import type { CodexUsageSnapshot } from "./usage";

export const USAGE_FRESHNESS_INTERVAL_MS = 30 * 1000;

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

type RefreshResult = CodexUsageSnapshot | undefined;

type InFlightRefresh = {
	promise: Promise<RefreshResult>;
	force: boolean;
};

type PendingForce = {
	start: () => Promise<RefreshResult>;
	waiters: Array<{
		resolve: (value: RefreshResult | PromiseLike<RefreshResult>) => void;
		reject: (reason?: unknown) => void;
	}>;
};

type UsageEntry = {
	key: string;
	account?: UsageAccount;
	accountReferences: Set<UsageAccount>;
	snapshot?: CodexUsageSnapshot;
	lastAttemptAt?: number;
	inFlight?: InFlightRefresh;
	consumptionDirty: boolean;
	consumptionTimer?: ReturnType<typeof setTimeout>;
	pendingForce?: PendingForce;
};

export function normalizeUsageEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function getUsageKey(account: UsageAccount | string): string {
	if (typeof account === "string") {
		return `email:${normalizeUsageEmail(account)}`;
	}
	const accountId = account.accountId?.trim();
	return accountId
		? `account:${accountId}`
		: `email:${normalizeUsageEmail(account.email)}`;
}

function isEligible(lastAttemptAt: number | undefined, now: number): boolean {
	return (
		lastAttemptAt === undefined ||
		now - lastAttemptAt >= USAGE_FRESHNESS_INTERVAL_MS
	);
}

export class UsageCoordinator {
	private readonly entries = new Map<string, UsageEntry>();
	private readonly changeHandlers = new Set<UsageChangeHandler>();
	private activeObserverCount = 0;

	dispose(): void {
		this.cancelConsumptionWork();
		this.changeHandlers.clear();
		this.activeObserverCount = 0;
	}

	getCachedUsage(
		account: UsageAccount | string,
	): CodexUsageSnapshot | undefined {
		return this.entries.get(getUsageKey(account))?.snapshot;
	}

	isRefreshEligible(account: UsageAccount | string, now = Date.now()): boolean {
		return isEligible(
			this.entries.get(getUsageKey(account))?.lastAttemptAt,
			now,
		);
	}

	onUsageChange(handler: UsageChangeHandler): () => void {
		this.changeHandlers.add(handler);
		return () => {
			this.changeHandlers.delete(handler);
		};
	}

	subscribeActiveObserver(): () => void {
		this.activeObserverCount += 1;
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.activeObserverCount = Math.max(0, this.activeObserverCount - 1);
			if (this.activeObserverCount === 0) {
				this.cancelConsumptionWork();
			}
		};
	}

	refresh(
		account: UsageAccount,
		fetcher: UsageFetcher,
		request: UsageRefreshRequest = {},
	): Promise<RefreshResult> {
		const key = getUsageKey(account);
		const entry = this.getOrCreateEntry(key, account);
		const force = request.force === true;

		if (entry.inFlight) {
			if (force && !entry.inFlight.force) {
				return this.queueForcedFollowup(entry, account, fetcher, request);
			}
			return entry.inFlight.promise;
		}

		if (!force && !isEligible(entry.lastAttemptAt, Date.now())) {
			return Promise.resolve(entry.snapshot);
		}

		if (force) {
			this.clearConsumptionWork(entry);
		}
		return this.startRefresh(entry, account, fetcher, {
			...request,
			force,
		});
	}

	invalidate(account: UsageAccount): void {
		const key = getUsageKey(account);
		const entry =
			this.entries.get(key) ??
			[...this.entries.values()].find((candidate) =>
				candidate.accountReferences.has(account),
			);
		if (!entry) return;
		if (this.entries.get(entry.key) === entry) {
			this.entries.delete(entry.key);
		}
		this.clearConsumptionWork(entry);
		const pendingForce = entry.pendingForce;
		entry.pendingForce = undefined;
		for (const waiter of pendingForce?.waiters ?? []) {
			waiter.resolve(undefined);
		}
	}

	recordUsageConsumption(account: UsageAccount, fetcher: UsageFetcher): void {
		if (this.activeObserverCount === 0) return;

		const key = getUsageKey(account);
		const entry = this.getOrCreateEntry(key, account);
		entry.consumptionDirty = true;
		if (entry.inFlight) return;

		this.startEligibleConsumptionRefresh(entry, account, fetcher);
	}

	private getOrCreateEntry(key: string, account: UsageAccount): UsageEntry {
		const existing = this.entries.get(key);
		if (existing) {
			existing.account = account;
			existing.accountReferences.add(account);
			return existing;
		}
		const entry: UsageEntry = {
			key,
			account,
			accountReferences: new Set([account]),
			consumptionDirty: false,
		};
		this.entries.set(key, entry);
		return entry;
	}

	private startEligibleConsumptionRefresh(
		entry: UsageEntry,
		account: UsageAccount,
		fetcher: UsageFetcher,
	): void {
		if (this.activeObserverCount === 0 || entry.inFlight) return;
		const now = Date.now();
		if (isEligible(entry.lastAttemptAt, now)) {
			this.clearConsumptionTimer(entry);
			entry.consumptionDirty = false;
			void this.startRefresh(entry, account, fetcher, { force: false }).catch(
				() => undefined,
			);
			return;
		}
		this.scheduleConsumptionRefresh(entry, account, fetcher);
	}

	private scheduleConsumptionRefresh(
		entry: UsageEntry,
		account: UsageAccount,
		fetcher: UsageFetcher,
	): void {
		if (
			this.activeObserverCount === 0 ||
			entry.consumptionTimer ||
			!entry.consumptionDirty
		) {
			return;
		}

		const delay = Math.max(
			0,
			(entry.lastAttemptAt ?? Date.now()) +
				USAGE_FRESHNESS_INTERVAL_MS -
				Date.now(),
		);
		entry.consumptionTimer = setTimeout(() => {
			entry.consumptionTimer = undefined;
			if (this.activeObserverCount === 0 || !entry.consumptionDirty) return;
			if (entry.inFlight) return;
			this.startEligibleConsumptionRefresh(entry, account, fetcher);
		}, delay);
		entry.consumptionTimer.unref?.();
	}

	private startRefresh(
		entry: UsageEntry,
		account: UsageAccount,
		fetcher: UsageFetcher,
		request: UsageRefreshRequest & { force: boolean },
	): Promise<RefreshResult> {
		let promise!: Promise<RefreshResult>;
		promise = (async () => {
			try {
				const usage = await fetcher(account, { signal: request.signal });
				const completedAt = Date.now();
				const fetchedAt =
					typeof usage.fetchedAt === "number" &&
					Number.isFinite(usage.fetchedAt)
						? usage.fetchedAt
						: completedAt;
				const normalizedUsage =
					usage.fetchedAt === fetchedAt ? usage : { ...usage, fetchedAt };
				const currentEntry = this.migrateEntryForAccountIdentity(
					entry,
					account,
				);
				if (currentEntry) {
					currentEntry.snapshot = normalizedUsage;
					currentEntry.lastAttemptAt = completedAt;
					this.notifyUsageChange(
						currentEntry.account ?? account,
						normalizedUsage,
					);
				}
				return normalizedUsage;
			} catch (error) {
				entry.lastAttemptAt = Date.now();
				throw error;
			} finally {
				if (entry.inFlight?.promise === promise) {
					entry.inFlight = undefined;
					this.finishRefresh(entry, account, fetcher);
				}
			}
		})();

		entry.inFlight = {
			promise,
			force: request.force,
		};
		return promise;
	}

	private migrateEntryForAccountIdentity(
		entry: UsageEntry,
		account: UsageAccount,
	): UsageEntry | undefined {
		if (this.entries.get(entry.key) !== entry) return undefined;

		const nextKey = getUsageKey(account);
		if (nextKey === entry.key) return entry;

		const existing = this.entries.get(nextKey);
		if (existing && existing !== entry) {
			if (
				entry.lastAttemptAt !== undefined &&
				entry.lastAttemptAt > (existing.lastAttemptAt ?? -Infinity)
			) {
				existing.lastAttemptAt = entry.lastAttemptAt;
			}
			if (!existing.snapshot && entry.snapshot) {
				existing.snapshot = entry.snapshot;
			}
			for (const accountReference of entry.accountReferences) {
				existing.accountReferences.add(accountReference);
			}
			existing.consumptionDirty ||= entry.consumptionDirty;
			this.entries.delete(entry.key);
			return existing;
		}

		this.entries.delete(entry.key);
		entry.key = nextKey;
		this.entries.set(nextKey, entry);
		return entry;
	}

	private finishRefresh(
		entry: UsageEntry,
		account: UsageAccount,
		fetcher: UsageFetcher,
	): void {
		const isCurrent = this.entries.get(entry.key) === entry;
		const pendingForce = entry.pendingForce;
		if (pendingForce) {
			entry.pendingForce = undefined;
			entry.consumptionDirty = false;
			const followup = pendingForce.start();
			for (const waiter of pendingForce.waiters) {
				followup.then(waiter.resolve, waiter.reject);
			}
			return;
		}

		if (!isCurrent) return;

		if (this.activeObserverCount === 0) {
			this.clearConsumptionWork(entry);
			return;
		}
		if (!entry.consumptionDirty) return;
		this.scheduleConsumptionRefresh(entry, account, fetcher);
	}

	private queueForcedFollowup(
		entry: UsageEntry,
		account: UsageAccount,
		fetcher: UsageFetcher,
		request: UsageRefreshRequest,
	): Promise<RefreshResult> {
		if (!entry.pendingForce) {
			entry.pendingForce = {
				start: () =>
					this.startRefresh(entry, account, fetcher, {
						...request,
						force: true,
					}),
				waiters: [],
			};
		}
		return new Promise<RefreshResult>((resolve, reject) => {
			entry.pendingForce?.waiters.push({ resolve, reject });
		});
	}

	private notifyUsageChange(
		account: UsageAccount,
		usage: CodexUsageSnapshot,
	): void {
		for (const handler of this.changeHandlers) {
			handler(account, usage);
		}
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

	private cancelConsumptionWork(): void {
		for (const entry of this.entries.values()) {
			this.clearConsumptionWork(entry);
		}
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
	const coordinator = new UsageCoordinator();
	globalState[PROCESS_COORDINATOR_KEY] = coordinator;
	return coordinator;
}

export function resetUsageCoordinatorForTests(): void {
	const globalState = getProcessGlobalState();
	const existing = globalState[PROCESS_COORDINATOR_KEY];
	if (
		existing &&
		typeof (existing as UsageCoordinator).dispose === "function"
	) {
		(existing as UsageCoordinator).dispose();
	}
	globalState[PROCESS_COORDINATOR_KEY] = new UsageCoordinator();
}

export function createUsageCoordinator(): UsageCoordinator {
	return new UsageCoordinator();
}
