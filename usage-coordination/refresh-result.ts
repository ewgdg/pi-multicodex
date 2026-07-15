import type { CodexUsageSnapshot } from "../usage";
import type { SharedUsageState, UsageRefreshResult } from "./contracts";
import type { UsageCoordinationPolicy } from "./policy";
import { getSharedAvailability, toSharedUsageView } from "./state";

export function normalizeUsageSnapshot(
	usage: CodexUsageSnapshot,
	fallbackFetchedAt: number,
): CodexUsageSnapshot {
	return Number.isFinite(usage.fetchedAt)
		? usage
		: { ...usage, fetchedAt: fallbackFetchedAt };
}

export function withoutRetrySuppression(
	state: SharedUsageState,
): SharedUsageState {
	const { retryNotBefore: _retryNotBefore, ...remaining } = state;
	return remaining;
}

export function usageResultFromState(
	state: SharedUsageState | undefined,
	now: number,
	policy: UsageCoordinationPolicy,
	source: UsageRefreshResult["source"],
	extra: Pick<UsageRefreshResult, "error" | "warning"> = {},
): UsageRefreshResult {
	const view = toSharedUsageView(state);
	return {
		availability: getSharedAvailability(view, now, policy),
		source,
		...(view.snapshot ? { snapshot: view.snapshot } : {}),
		...(view.lastRefresh ? { refreshOutcome: view.lastRefresh } : {}),
		...extra,
	};
}

export function waitForDetached<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
	cancelledValue: () => T,
): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.resolve(cancelledValue());
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			resolve(cancelledValue());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
