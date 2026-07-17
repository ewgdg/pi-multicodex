import { randomUUID } from "node:crypto";
import {
	isUsageAuthenticationError,
	isUsageCancellationError,
	type SharedUsageChangeHandler,
	type SharedUsageCoordination,
	type SharedUsageFetcher,
	type SharedUsageRefreshRequest,
	type SharedUsageState,
	type UsageRefreshResult,
} from "./contracts";
import { normalizeManagedAccountIdentity } from "./identity";
import {
	PRODUCTION_USAGE_COORDINATION_POLICY,
	type UsageCoordinationPolicy,
} from "./policy";
import {
	normalizeUsageSnapshot,
	usageResultFromState,
	waitForDetached,
	withoutRetrySuppression,
} from "./refresh-result";
import { isSnapshotFresh, toSharedUsageView } from "./state";

interface InMemoryUsageCoordinationOptions {
	now?: () => number;
	token?: () => string;
	policy?: UsageCoordinationPolicy;
}

export class InMemoryUsageCoordination implements SharedUsageCoordination {
	readonly policy: UsageCoordinationPolicy;
	private readonly states = new Map<string, SharedUsageState>();
	private readonly inFlight = new Map<string, Promise<UsageRefreshResult>>();
	private readonly handlers = new Map<string, Set<SharedUsageChangeHandler>>();
	private readonly now: () => number;
	private readonly token: () => string;

	constructor(options: InMemoryUsageCoordinationOptions = {}) {
		this.policy = options.policy ?? PRODUCTION_USAGE_COORDINATION_POLICY;
		this.now = options.now ?? Date.now;
		this.token = options.token ?? randomUUID;
	}

	async read(email: string) {
		const state = this.states.get(normalizeManagedAccountIdentity(email));
		return toSharedUsageView(state);
	}

	async invalidate(email: string) {
		const identity = normalizeManagedAccountIdentity(email);
		const state = this.states.get(identity) ?? {};
		const next: SharedUsageState = {
			...state,
			pendingInvalidation: {
				token: this.token(),
				recordedAt: this.now(),
			},
		};
		this.states.set(identity, next);
		this.notify(identity, next);
		return toSharedUsageView(next);
	}

	refresh(
		email: string,
		fetcher: SharedUsageFetcher,
		request: SharedUsageRefreshRequest = {},
	): Promise<UsageRefreshResult> {
		const identity = normalizeManagedAccountIdentity(email);
		const state = this.states.get(identity);
		const now = this.now();
		if (!request.force && isSnapshotFresh(state?.snapshot, now, this.policy)) {
			return Promise.resolve(
				usageResultFromState(state, now, this.policy, "existing-fresh"),
			);
		}
		if (
			!request.force &&
			state?.retryNotBefore !== undefined &&
			state.retryNotBefore > now
		) {
			return Promise.resolve(
				usageResultFromState(state, now, this.policy, "retry-suppressed"),
			);
		}

		const existing = this.inFlight.get(identity);
		if (existing) return this.waitFor(existing, request.signal, false);

		const owned = this.runOwned(identity, fetcher);
		this.inFlight.set(identity, owned);
		void owned.finally(() => {
			if (this.inFlight.get(identity) === owned) this.inFlight.delete(identity);
		});
		return this.waitFor(owned, request.signal, true);
	}

	subscribe(email: string, handler: SharedUsageChangeHandler): () => void {
		const identity = normalizeManagedAccountIdentity(email);
		const handlers = this.handlers.get(identity) ?? new Set();
		handlers.add(handler);
		this.handlers.set(identity, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.handlers.delete(identity);
		};
	}

	dispose(): void {
		this.handlers.clear();
	}

	seedStateForTests(email: string, state: SharedUsageState): void {
		this.states.set(normalizeManagedAccountIdentity(email), state);
	}

	getStateForTests(email: string): SharedUsageState | undefined {
		return this.states.get(normalizeManagedAccountIdentity(email));
	}

	private async runOwned(
		identity: string,
		fetcher: SharedUsageFetcher,
	): Promise<UsageRefreshResult> {
		const baseline = this.states.get(identity) ?? {};
		const capturedInvalidationToken = baseline.pendingInvalidation?.token;
		const attemptToken = this.token();
		const startedAt = this.now();

		try {
			const fetched = normalizeUsageSnapshot(await fetcher({}), this.now());
			const completedAt = this.now();
			const current = this.states.get(identity) ?? {};
			const next: SharedUsageState = {
				...withoutRetrySuppression(current),
				snapshot: { ...fetched, attemptToken },
				lastRefresh: {
					token: attemptToken,
					startedAt,
					completedAt,
					outcome: "success",
				},
			};
			if (
				capturedInvalidationToken &&
				current.pendingInvalidation?.token === capturedInvalidationToken
			) {
				delete next.pendingInvalidation;
			}
			this.states.set(identity, next);
			this.notify(identity, next);
			return usageResultFromState(
				next,
				completedAt,
				this.policy,
				"owned-fetch",
			);
		} catch (error) {
			const completedAt = this.now();
			const current = this.states.get(identity) ?? baseline;
			const suppressRetry =
				!isUsageAuthenticationError(error) && !isUsageCancellationError(error);
			const next: SharedUsageState = suppressRetry
				? {
						...current,
						lastRefresh: {
							token: attemptToken,
							startedAt,
							completedAt,
							outcome: "failure",
						},
						retryNotBefore: completedAt + this.policy.retrySuppressionMs,
					}
				: current;
			if (suppressRetry) {
				this.states.set(identity, next);
				this.notify(identity, next);
			}
			return usageResultFromState(
				next,
				completedAt,
				this.policy,
				isUsageCancellationError(error) ? "cancellation" : "failure",
				{ error },
			);
		}
	}

	private waitFor(
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

	private notify(identity: string, state: SharedUsageState): void {
		const view = toSharedUsageView(state);
		for (const handler of this.handlers.get(identity) ?? []) handler(view);
	}
}

export function createInMemoryUsageCoordination(
	options: InMemoryUsageCoordinationOptions = {},
): InMemoryUsageCoordination {
	return new InMemoryUsageCoordination(options);
}
