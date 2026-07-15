import { getAgentPath } from "./shared/agent-paths";
import type { CodexUsageSnapshot } from "./usage";
import {
	createFilesystemUsageCoordination,
	createInMemoryUsageCoordination,
	isSnapshotFresh,
	normalizeManagedAccountIdentity,
	PRODUCTION_USAGE_COORDINATION_POLICY,
	type SharedUsageCoordination,
	type SharedUsageView,
	type UsageCoordinationDiagnostic,
	type UsageCoordinationWarning,
	type UsageRefreshResult,
	waitForDetached,
} from "./usage-coordination/index";

export const USAGE_FRESHNESS_INTERVAL_MS =
	PRODUCTION_USAGE_COORDINATION_POLICY.freshnessIntervalMs;

export interface UsageAccount {
	email: string;
	accountId?: string;
}

export interface UsageRefreshRequest {
	force?: boolean;
	signal?: AbortSignal;
}

export type UsageFetcher = (
	account: UsageAccount,
	options: { signal?: AbortSignal },
) => Promise<CodexUsageSnapshot>;

type UsageChangeHandler = (
	account: UsageAccount,
	usage: CodexUsageSnapshot,
) => void;

type WarningHandler = (warning: UsageCoordinationWarning) => void;

type InFlightRefresh = {
	promise: Promise<UsageRefreshResult>;
	controller: AbortController;
};

type UsageEntry = {
	identity: string;
	account: UsageAccount;
	snapshot?: CodexUsageSnapshot;
	locallyAvailable: boolean;
	fetcher?: UsageFetcher;
	inFlight?: InFlightRefresh;
	sharedUnsubscribe?: () => void;
	consumptionDirty: boolean;
	consumptionTimer?: ReturnType<typeof setTimeout>;
	invalidationRunning?: Promise<void>;
	invalidationPending: boolean;
};

export interface UsageCoordinatorOptions {
	sharedCoordination?: SharedUsageCoordination;
	now?: () => number;
}

export function normalizeUsageEmail(email: string): string {
	return normalizeManagedAccountIdentity(email);
}

export function getUsageKey(account: UsageAccount | string): string {
	const email = typeof account === "string" ? account : account.email;
	return `email:${normalizeUsageEmail(email)}`;
}

export class UsageCoordinator {
	private readonly entries = new Map<string, UsageEntry>();
	private readonly changeHandlers = new Set<UsageChangeHandler>();
	private readonly warningHandlers = new Set<WarningHandler>();
	private readonly warnedCoordinationFailures = new Set<string>();
	private readonly sharedCoordination: SharedUsageCoordination;
	private readonly now: () => number;
	private activeObserverCount = 0;
	private reconciliationTimer?: ReturnType<typeof setTimeout>;
	private lastReconciliationAt?: number;

	constructor(options: UsageCoordinatorOptions = {}) {
		this.sharedCoordination =
			options.sharedCoordination ?? createInMemoryUsageCoordination();
		this.now = options.now ?? Date.now;
	}

	dispose(): void {
		this.stopObserverWork();
		for (const entry of this.entries.values()) {
			entry.inFlight?.controller.abort();
			this.clearConsumptionWork(entry);
		}
		this.entries.clear();
		this.changeHandlers.clear();
		this.warningHandlers.clear();
		this.warnedCoordinationFailures.clear();
		this.activeObserverCount = 0;
		this.sharedCoordination.dispose();
	}

	getCachedUsage(
		account: UsageAccount | string,
	): CodexUsageSnapshot | undefined {
		return this.entries.get(getUsageKey(account))?.snapshot;
	}

	getCachedResult(account: UsageAccount | string): UsageRefreshResult {
		const entry = this.entries.get(getUsageKey(account));
		const snapshot = entry?.snapshot;
		return {
			availability: snapshot
				? entry?.locallyAvailable
					? "locally-available"
					: isSnapshotFresh(
								snapshot,
								this.now(),
								this.sharedCoordination.policy,
							)
						? "fresh"
						: "stale"
				: "unavailable",
			source: "failure",
			...(snapshot ? { snapshot } : {}),
		};
	}

	isRefreshEligible(account: UsageAccount | string, now = this.now()): boolean {
		return !isSnapshotFresh(
			this.getCachedUsage(account),
			now,
			this.sharedCoordination.policy,
		);
	}

	onUsageChange(handler: UsageChangeHandler): () => void {
		this.changeHandlers.add(handler);
		return () => this.changeHandlers.delete(handler);
	}

	onWarning(handler: WarningHandler): () => void {
		this.warningHandlers.add(handler);
		return () => this.warningHandlers.delete(handler);
	}

	resetWarnings(): void {
		this.warnedCoordinationFailures.clear();
	}

	getDiagnostics(): readonly UsageCoordinationDiagnostic[] {
		const shared = this.sharedCoordination as SharedUsageCoordination & {
			getDiagnostics?: () => readonly UsageCoordinationDiagnostic[];
		};
		return shared.getDiagnostics?.() ?? [];
	}

	subscribeActiveObserver(): () => void {
		this.activeObserverCount += 1;
		if (this.activeObserverCount === 1) this.startObserverWork();
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.activeObserverCount = Math.max(0, this.activeObserverCount - 1);
			if (this.activeObserverCount === 0) this.stopObserverWork();
		};
	}

	refresh(
		account: UsageAccount,
		fetcher: UsageFetcher,
		request: UsageRefreshRequest = {},
	): Promise<UsageRefreshResult> {
		const entry = this.getOrCreateEntry(account);
		entry.fetcher = fetcher;
		if (entry.inFlight) {
			return this.waitForWork(entry.inFlight.promise, request.signal, false);
		}

		const controller = new AbortController();
		const promise = this.runRefresh(
			entry,
			account,
			fetcher,
			request.force === true,
			controller,
		);
		entry.inFlight = { promise, controller };
		void promise.finally(() => {
			if (entry.inFlight?.promise !== promise) return;
			entry.inFlight = undefined;
			void this.reconcileEntry(entry).finally(() => {
				if (this.entries.get(getUsageKey(entry.account)) !== entry) return;
				this.scheduleConsumptionRefresh(entry);
			});
		});
		return this.waitForWork(promise, request.signal, true);
	}

	async reconcile(account: UsageAccount): Promise<SharedUsageView> {
		const entry = this.getOrCreateEntry(account);
		return this.reconcileEntry(entry);
	}

	forget(account: UsageAccount | string): void {
		const key = getUsageKey(account);
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		entry.inFlight?.controller.abort();
		entry.sharedUnsubscribe?.();
		entry.sharedUnsubscribe = undefined;
		this.clearConsumptionWork(entry);
		entry.invalidationPending = false;
	}

	recordUsageConsumption(account: UsageAccount, fetcher: UsageFetcher): void {
		const entry = this.getOrCreateEntry(account);
		entry.fetcher = fetcher;
		entry.consumptionDirty = true;
		entry.invalidationPending = true;
		if (!entry.invalidationRunning) this.startInvalidationLoop(entry);
	}

	private getOrCreateEntry(account: UsageAccount): UsageEntry {
		const key = getUsageKey(account);
		const existing = this.entries.get(key);
		if (existing) {
			existing.account = account;
			return existing;
		}
		const entry: UsageEntry = {
			identity: normalizeUsageEmail(account.email),
			account,
			locallyAvailable: false,
			consumptionDirty: false,
			invalidationPending: false,
		};
		this.entries.set(key, entry);
		if (this.activeObserverCount > 0) {
			this.subscribeEntry(entry);
			void this.reconcileEntry(entry);
		}
		return entry;
	}

	private async runRefresh(
		entry: UsageEntry,
		account: UsageAccount,
		fetcher: UsageFetcher,
		force: boolean,
		controller: AbortController,
	): Promise<UsageRefreshResult> {
		const result = await this.sharedCoordination.refresh(
			entry.identity,
			({ signal }) => {
				const workSignal = signal
					? AbortSignal.any([signal, controller.signal])
					: controller.signal;
				return fetcher(account, { signal: workSignal });
			},
			{ force },
		);
		if (this.entries.get(getUsageKey(entry.account)) === entry) {
			this.applyRefreshResult(entry, result);
		}
		return result;
	}

	private applyRefreshResult(
		entry: UsageEntry,
		result: UsageRefreshResult,
	): void {
		if (result.snapshot) {
			this.acceptSnapshot(
				entry,
				result.snapshot,
				result.availability === "locally-available",
			);
		}
		if (result.warning) this.notifyWarning(result.warning);
	}

	private async reconcileEntry(entry: UsageEntry): Promise<SharedUsageView> {
		const view = await this.sharedCoordination.read(entry.identity);
		if (this.entries.get(getUsageKey(entry.account)) !== entry) return view;
		this.applySharedView(entry, view);
		return view;
	}

	private applySharedView(entry: UsageEntry, view: SharedUsageView): void {
		if (view.snapshot) this.acceptSnapshot(entry, view.snapshot, false);
		entry.consumptionDirty = Boolean(view.pendingInvalidation);
		if (view.warning) this.notifyWarning(view.warning);
		this.scheduleConsumptionRefresh(entry);
	}

	private acceptSnapshot(
		entry: UsageEntry,
		snapshot: CodexUsageSnapshot,
		locallyAvailable: boolean,
	): void {
		if (entry.snapshot && entry.snapshot.fetchedAt > snapshot.fetchedAt) {
			return;
		}
		if (
			entry.snapshot &&
			entry.snapshot.fetchedAt === snapshot.fetchedAt &&
			JSON.stringify(entry.snapshot) === JSON.stringify(snapshot)
		) {
			entry.locallyAvailable = locallyAvailable;
			return;
		}
		entry.snapshot = snapshot;
		entry.locallyAvailable = locallyAvailable;
		for (const handler of this.changeHandlers) {
			handler(entry.account, snapshot);
		}
	}

	private startInvalidationLoop(entry: UsageEntry): void {
		let running!: Promise<void>;
		running = (async () => {
			while (entry.invalidationPending) {
				entry.invalidationPending = false;
				const view = await this.sharedCoordination.invalidate(entry.identity);
				if (this.entries.get(getUsageKey(entry.account)) !== entry) return;
				this.applySharedView(entry, view);
			}
		})()
			.catch((error) => {
				this.notifyWarning({
					code: "coordination-unavailable",
					message: `Shared usage invalidation failed: ${String(error)}`,
				});
			})
			.finally(() => {
				if (entry.invalidationRunning === running) {
					entry.invalidationRunning = undefined;
				}
				if (entry.invalidationPending) this.startInvalidationLoop(entry);
			});
		entry.invalidationRunning = running;
	}

	private scheduleConsumptionRefresh(entry: UsageEntry): void {
		if (
			this.activeObserverCount === 0 ||
			!entry.consumptionDirty ||
			entry.inFlight ||
			!entry.fetcher ||
			entry.consumptionTimer
		) {
			return;
		}
		const fetchedAt = entry.snapshot?.fetchedAt;
		const delay =
			fetchedAt === undefined
				? 0
				: Math.max(
						0,
						fetchedAt +
							this.sharedCoordination.policy.freshnessIntervalMs -
							this.now(),
					);
		entry.consumptionTimer = setTimeout(() => {
			entry.consumptionTimer = undefined;
			if (
				this.activeObserverCount === 0 ||
				!entry.consumptionDirty ||
				entry.inFlight ||
				!entry.fetcher
			) {
				return;
			}
			void this.refresh(entry.account, entry.fetcher).then(() => undefined);
		}, delay);
		entry.consumptionTimer.unref?.();
	}

	private waitForWork(
		promise: Promise<UsageRefreshResult>,
		signal: AbortSignal | undefined,
		owner: boolean,
	): Promise<UsageRefreshResult> {
		const normalize = (result: UsageRefreshResult): UsageRefreshResult => {
			if (owner) return result;
			const { error: _error, ...shared } = result;
			return { ...shared, source: "joined-work" };
		};
		return waitForDetached(promise.then(normalize), signal, () => ({
			availability: "unavailable",
			source: "cancellation",
		}));
	}

	private startObserverWork(): void {
		for (const entry of this.entries.values()) {
			this.subscribeEntry(entry);
			void this.reconcileEntry(entry);
		}
		this.lastReconciliationAt = this.now();
		this.scheduleSafetyReconciliation();
	}

	private stopObserverWork(): void {
		if (this.reconciliationTimer) {
			clearTimeout(this.reconciliationTimer);
			this.reconciliationTimer = undefined;
		}
		for (const entry of this.entries.values()) {
			entry.sharedUnsubscribe?.();
			entry.sharedUnsubscribe = undefined;
			this.clearConsumptionTimer(entry);
		}
		this.lastReconciliationAt = undefined;
	}

	private subscribeEntry(entry: UsageEntry): void {
		if (entry.sharedUnsubscribe) return;
		entry.sharedUnsubscribe = this.sharedCoordination.subscribe(
			entry.identity,
			(view) => {
				if (this.entries.get(getUsageKey(entry.account)) !== entry) return;
				this.applySharedView(entry, view);
			},
		);
	}

	private scheduleSafetyReconciliation(): void {
		if (this.activeObserverCount === 0 || this.reconciliationTimer) return;
		this.reconciliationTimer = setTimeout(() => {
			this.reconciliationTimer = undefined;
			if (this.activeObserverCount === 0) return;
			const now = this.now();
			const previous = this.lastReconciliationAt;
			this.lastReconciliationAt = now;
			const likelySleep =
				previous !== undefined &&
				now - previous >= this.sharedCoordination.policy.sleepDetectionMs;
			for (const entry of this.entries.values()) {
				void this.reconcileEntry(entry);
				if (likelySleep) this.clearConsumptionTimer(entry);
			}
			this.scheduleSafetyReconciliation();
		}, this.sharedCoordination.policy.freshnessIntervalMs);
		this.reconciliationTimer.unref?.();
	}

	private clearConsumptionTimer(entry: UsageEntry): void {
		if (!entry.consumptionTimer) return;
		clearTimeout(entry.consumptionTimer);
		entry.consumptionTimer = undefined;
	}

	private clearConsumptionWork(entry: UsageEntry): void {
		this.clearConsumptionTimer(entry);
		entry.consumptionDirty = false;
	}

	private notifyWarning(warning: UsageCoordinationWarning): void {
		if (this.warningHandlers.size === 0) return;
		const key = `${warning.code}:${warning.message}`;
		if (this.warnedCoordinationFailures.has(key)) return;
		this.warnedCoordinationFailures.add(key);
		for (const handler of this.warningHandlers) handler(warning);
	}
}

const PROCESS_COORDINATOR_KEY = Symbol.for("pi-multicodex.usage-coordinator");

function getProcessGlobalState(): Record<symbol, unknown> {
	return globalThis as unknown as Record<symbol, unknown>;
}

export function getUsageCoordinator(): UsageCoordinator {
	const globalState = getProcessGlobalState();
	const existing = globalState[PROCESS_COORDINATOR_KEY];
	if (
		existing &&
		typeof (existing as UsageCoordinator).refresh === "function"
	) {
		return existing as UsageCoordinator;
	}
	const coordinator = new UsageCoordinator({
		sharedCoordination: createFilesystemUsageCoordination({
			root: getAgentPath("state", "multicodex", "usage-coordination"),
		}),
	});
	globalState[PROCESS_COORDINATOR_KEY] = coordinator;
	return coordinator;
}

export function resetUsageCoordinatorForTests(
	sharedCoordination: SharedUsageCoordination = createInMemoryUsageCoordination(),
): void {
	const globalState = getProcessGlobalState();
	const existing = globalState[PROCESS_COORDINATOR_KEY];
	if (
		existing &&
		typeof (existing as UsageCoordinator).dispose === "function"
	) {
		(existing as UsageCoordinator).dispose();
	}
	globalState[PROCESS_COORDINATOR_KEY] = new UsageCoordinator({
		sharedCoordination,
	});
}

export function createUsageCoordinator(
	options: UsageCoordinatorOptions = {},
): UsageCoordinator {
	return new UsageCoordinator(options);
}
