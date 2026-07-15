import type { CodexUsageSnapshot } from "../usage";
import type { UsageCoordinationPolicy } from "./policy";

export type UsageAvailability =
	| "fresh"
	| "stale"
	| "locally-available"
	| "unavailable";

export type UsageRefreshSource =
	| "existing-fresh"
	| "retry-suppressed"
	| "joined-work"
	| "owned-fetch"
	| "local-fallback"
	| "failure"
	| "cancellation";

export interface SharedUsageSnapshot extends CodexUsageSnapshot {
	attemptToken: string;
}

export interface PendingUsageInvalidation {
	token: string;
	recordedAt: number;
}

export interface SharedRefreshOutcome {
	token: string;
	startedAt: number;
	completedAt: number;
	outcome: "success" | "failure";
}

export interface SharedUsageState extends Record<string, unknown> {
	snapshot?: SharedUsageSnapshot;
	pendingInvalidation?: PendingUsageInvalidation;
	lastRefresh?: SharedRefreshOutcome;
	retryNotBefore?: number;
}

export interface UsageCoordinationWarning {
	code:
		| "permission"
		| "malformed-state"
		| "replacement-failed"
		| "watcher-failed"
		| "coordination-unavailable";
	message: string;
}

export interface SharedUsageView {
	status: "valid" | "absent" | "unavailable";
	snapshot?: CodexUsageSnapshot;
	pendingInvalidation?: PendingUsageInvalidation;
	lastRefresh?: SharedRefreshOutcome;
	retryNotBefore?: number;
	warning?: UsageCoordinationWarning;
}

export interface UsageRefreshResult {
	availability: UsageAvailability;
	source: UsageRefreshSource;
	snapshot?: CodexUsageSnapshot;
	refreshOutcome?: SharedRefreshOutcome;
	warning?: UsageCoordinationWarning;
	error?: unknown;
}

export function isFreshUsageConfirmation(result: UsageRefreshResult): boolean {
	return (
		result.availability === "fresh" &&
		(result.source === "owned-fetch" || result.source === "joined-work") &&
		result.refreshOutcome?.outcome === "success"
	);
}

export type SharedUsageFetcher = (options: {
	signal?: AbortSignal;
}) => Promise<CodexUsageSnapshot>;

export interface SharedUsageRefreshRequest {
	force?: boolean;
	signal?: AbortSignal;
}

export type SharedUsageChangeHandler = (view: SharedUsageView) => void;

export interface SharedUsageCoordination {
	readonly policy: UsageCoordinationPolicy;
	read(email: string): Promise<SharedUsageView>;
	invalidate(email: string): Promise<SharedUsageView>;
	refresh(
		email: string,
		fetcher: SharedUsageFetcher,
		request?: SharedUsageRefreshRequest,
	): Promise<UsageRefreshResult>;
	subscribe(email: string, handler: SharedUsageChangeHandler): () => void;
	dispose(): void;
}

export class UsageAuthenticationError extends Error {
	override readonly name = "UsageAuthenticationError";
}

export class UsageCoordinationCancellationError extends Error {
	override readonly name = "UsageCoordinationCancellationError";
}

export function isUsageAuthenticationError(
	error: unknown,
): error is UsageAuthenticationError {
	return error instanceof UsageAuthenticationError;
}

export function isUsageCancellationError(error: unknown): boolean {
	return (
		error instanceof UsageCoordinationCancellationError ||
		(error instanceof Error && error.name === "AbortError")
	);
}
