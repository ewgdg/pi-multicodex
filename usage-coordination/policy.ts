export interface UsageCoordinationPolicy {
	freshnessIntervalMs: number;
	retrySuppressionMs: number;
	usageRequestTimeoutMs: number;
	stateWriteLeaseMs: number;
	refreshLeaseMs: number;
	refreshAcquisitionTimeoutMs: number;
	leaseInitializationGraceMs: number;
	stateWriteAcquisitionTimeoutMs: number;
	refreshJoinPollMs: number;
	publicationRetryDelaysMs: readonly number[];
	watchDebounceMs: number;
	sleepDetectionMs: number;
	debrisGraceMs: number;
	maxDebrisEntriesPerPass: number;
	maxDiagnosticsEntries: number;
	maxStateBytes: number;
	maxLeaseBytes: number;
}

const FRESHNESS_INTERVAL_MS = 30_000;
const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const PUBLICATION_RETRY_DELAYS_MS = [25, 75] as const;
const PUBLICATION_MARGIN_MS =
	PUBLICATION_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) +
	2_000;
const STATE_WRITE_LEASE_MS = PUBLICATION_MARGIN_MS + 1_000;
const STATE_WRITE_ACQUISITION_TIMEOUT_MS = PUBLICATION_MARGIN_MS + 5_000;
const REFRESH_LEASE_MS =
	USAGE_REQUEST_TIMEOUT_MS +
	STATE_WRITE_ACQUISITION_TIMEOUT_MS +
	STATE_WRITE_LEASE_MS +
	5_000;
const REFRESH_ACQUISITION_TIMEOUT_MS = REFRESH_LEASE_MS + 5_000;

export const PRODUCTION_USAGE_COORDINATION_POLICY: UsageCoordinationPolicy = {
	freshnessIntervalMs: FRESHNESS_INTERVAL_MS,
	retrySuppressionMs: 30_000,
	usageRequestTimeoutMs: USAGE_REQUEST_TIMEOUT_MS,
	stateWriteLeaseMs: STATE_WRITE_LEASE_MS,
	refreshLeaseMs: REFRESH_LEASE_MS,
	refreshAcquisitionTimeoutMs: REFRESH_ACQUISITION_TIMEOUT_MS,
	leaseInitializationGraceMs: 1_000,
	stateWriteAcquisitionTimeoutMs: STATE_WRITE_ACQUISITION_TIMEOUT_MS,
	refreshJoinPollMs: 50,
	publicationRetryDelaysMs: PUBLICATION_RETRY_DELAYS_MS,
	watchDebounceMs: 50,
	sleepDetectionMs: FRESHNESS_INTERVAL_MS + REFRESH_LEASE_MS,
	debrisGraceMs: REFRESH_LEASE_MS + FRESHNESS_INTERVAL_MS,
	maxDebrisEntriesPerPass: 20,
	maxDiagnosticsEntries: 200,
	maxStateBytes: 64 * 1024,
	maxLeaseBytes: 8 * 1024,
};
