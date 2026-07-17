import type { CodexUsageSnapshot } from "../usage";
import type {
	SharedUsageSnapshot,
	SharedUsageState,
	SharedUsageView,
	UsageAvailability,
} from "./contracts";
import type { UsageCoordinationPolicy } from "./policy";

export type ParsedSharedUsageState =
	| { status: "valid"; state: SharedUsageState }
	| { status: "malformed" | "oversized"; state?: undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
	return value === undefined || isFiniteNumber(value);
}

function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function isValidUsageWindow(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		isOptionalFiniteNumber(value.usedPercent) &&
		isOptionalFiniteNumber(value.resetAt) &&
		isOptionalFiniteNumber(value.limitWindowSeconds) &&
		isOptionalFiniteNumber(value.resetAfterSeconds) &&
		isOptionalBoolean(value.allowed) &&
		isOptionalBoolean(value.limitReached)
	);
}

function isValidSnapshot(value: unknown): value is SharedUsageSnapshot {
	if (!isRecord(value)) return false;
	if (!isFiniteNumber(value.fetchedAt)) return false;
	if (
		typeof value.attemptToken !== "string" ||
		value.attemptToken.length === 0
	) {
		return false;
	}
	if (value.primary !== undefined && !isValidUsageWindow(value.primary)) {
		return false;
	}
	if (value.secondary !== undefined && !isValidUsageWindow(value.secondary)) {
		return false;
	}
	return value.planType === undefined || typeof value.planType === "string";
}

export function isValidSharedUsageState(
	value: unknown,
): value is SharedUsageState {
	if (!isRecord(value)) return false;
	if ("snapshot" in value && !isValidSnapshot(value.snapshot)) return false;
	if ("pendingInvalidation" in value) {
		const invalidation = value.pendingInvalidation;
		if (
			!isRecord(invalidation) ||
			typeof invalidation.token !== "string" ||
			!isFiniteNumber(invalidation.recordedAt)
		) {
			return false;
		}
	}
	if ("lastRefresh" in value) {
		const refresh = value.lastRefresh;
		if (
			!isRecord(refresh) ||
			typeof refresh.token !== "string" ||
			!isFiniteNumber(refresh.startedAt) ||
			!isFiniteNumber(refresh.completedAt) ||
			(refresh.outcome !== "success" && refresh.outcome !== "failure")
		) {
			return false;
		}
	}
	return !("retryNotBefore" in value) || isFiniteNumber(value.retryNotBefore);
}

export function parseSharedUsageState(
	bytes: Uint8Array,
	policy: UsageCoordinationPolicy,
): ParsedSharedUsageState {
	if (bytes.byteLength > policy.maxStateBytes) return { status: "oversized" };
	try {
		const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
		return isValidSharedUsageState(value)
			? { status: "valid", state: value }
			: { status: "malformed" };
	} catch {
		return { status: "malformed" };
	}
}

export function snapshotWithoutAttemptToken(
	snapshot: SharedUsageSnapshot,
): CodexUsageSnapshot {
	const { attemptToken: _attemptToken, ...usage } = snapshot;
	return usage;
}

export function toSharedUsageView(
	state: SharedUsageState | undefined,
	status: SharedUsageView["status"] = state ? "valid" : "absent",
): SharedUsageView {
	return {
		status,
		...(state?.snapshot
			? { snapshot: snapshotWithoutAttemptToken(state.snapshot) }
			: {}),
		...(state?.pendingInvalidation
			? { pendingInvalidation: state.pendingInvalidation }
			: {}),
		...(state?.lastRefresh ? { lastRefresh: state.lastRefresh } : {}),
		...(state?.retryNotBefore !== undefined
			? { retryNotBefore: state.retryNotBefore }
			: {}),
	};
}

export function isSnapshotFresh(
	snapshot: CodexUsageSnapshot | undefined,
	now: number,
	policy: UsageCoordinationPolicy,
): boolean {
	return Boolean(
		snapshot &&
			Number.isFinite(snapshot.fetchedAt) &&
			now - snapshot.fetchedAt < policy.freshnessIntervalMs,
	);
}

export function getSharedAvailability(
	view: SharedUsageView,
	now: number,
	policy: UsageCoordinationPolicy,
): UsageAvailability {
	if (!view.snapshot) return "unavailable";
	return isSnapshotFresh(view.snapshot, now, policy) ? "fresh" : "stale";
}
