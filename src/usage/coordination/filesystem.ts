import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodexUsageSnapshot } from "../usage";
import {
	isUsageAuthenticationError,
	isUsageCancellationError,
	type SharedUsageChangeHandler,
	type SharedUsageCoordination,
	type SharedUsageFetcher,
	type SharedUsageRefreshRequest,
	type SharedUsageState,
	type SharedUsageView,
	type UsageRefreshResult,
} from "./contracts";
import {
	FilesystemCoordinationStorage,
	isExpectedFilesystemError,
	type OwnedLease,
	REFRESH_LEASE_NAME,
	type StateReadResult,
	sleep,
	warningForError,
} from "./filesystem-storage";
import type {
	FilesystemUsageCoordinationOptions,
	UsageCoordinationDiagnostic,
} from "./filesystem-types";
import { FilesystemSubscriptionAdapter } from "./filesystem-watcher";
import {
	deriveManagedAccountDigest,
	normalizeManagedAccountIdentity,
} from "./identity";
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

export type {
	FilesystemUsageCoordinationFaultHooks,
	FilesystemUsageCoordinationOptions,
	UsageCoordinationDiagnostic,
} from "./filesystem-types";

function viewFromRead(result: StateReadResult): SharedUsageView {
	if (result.status === "valid") return toSharedUsageView(result.state);
	if (result.status === "absent") return toSharedUsageView(undefined);
	return {
		status: "unavailable",
		...(result.warning ? { warning: result.warning } : {}),
	};
}

class UsageRequestTimeoutError extends Error {
	override readonly name = "UsageRequestTimeoutError";
}

export class FilesystemUsageCoordination implements SharedUsageCoordination {
	readonly policy: UsageCoordinationPolicy;
	private readonly root: string;
	private readonly now: () => number;
	private readonly token: () => string;
	private readonly diagnostics: UsageCoordinationDiagnostic[] = [];
	private readonly storage: FilesystemCoordinationStorage;
	private readonly subscriptions: FilesystemSubscriptionAdapter;

	constructor(options: FilesystemUsageCoordinationOptions) {
		this.root = options.root;
		this.policy = options.policy ?? PRODUCTION_USAGE_COORDINATION_POLICY;
		this.now = options.now ?? Date.now;
		this.token = options.token ?? randomUUID;
		const recordDiagnostic = (
			action: UsageCoordinationDiagnostic["action"],
			scope: string,
			details?: Record<string, unknown>,
		) => this.recordDiagnostic(action, scope, details);
		this.storage = new FilesystemCoordinationStorage(
			this.policy,
			this.now,
			this.token,
			options.fsFaultHooks ?? {},
			recordDiagnostic,
		);
		this.subscriptions = new FilesystemSubscriptionAdapter(
			this.root,
			this.policy,
			async (identity) =>
				viewFromRead(
					await this.storage.readCanonical(this.scopeForIdentity(identity)),
				),
			recordDiagnostic,
			options.fsFaultHooks?.watchFactory,
		);
	}

	async read(email: string): Promise<SharedUsageView> {
		const identity = normalizeManagedAccountIdentity(email);
		const scope = this.scopeForIdentity(identity);
		await this.storage.cleanAgedDebris(scope);
		return viewFromRead(await this.storage.readCanonical(scope));
	}

	async invalidate(email: string): Promise<SharedUsageView> {
		const identity = normalizeManagedAccountIdentity(email);
		const scope = this.scopeForIdentity(identity);
		const mutation = await this.storage.mutateState(scope, (state) => ({
			...state,
			pendingInvalidation: {
				token: this.token(),
				recordedAt: this.now(),
			},
		}));
		const view = mutation.published
			? toSharedUsageView(mutation.state)
			: {
					...toSharedUsageView(
						mutation.state,
						mutation.state ? "valid" : "unavailable",
					),
					...(mutation.warning ? { warning: mutation.warning } : {}),
				};
		if (mutation.published) this.subscriptions.notify(identity, view);
		return view;
	}

	refresh(
		email: string,
		fetcher: SharedUsageFetcher,
		request: SharedUsageRefreshRequest = {},
	): Promise<UsageRefreshResult> {
		const identity = normalizeManagedAccountIdentity(email);
		const work = this.coordinateRefresh(
			identity,
			fetcher,
			request.force ?? false,
		);
		return this.waitFor(work, request.signal);
	}

	subscribe(email: string, handler: SharedUsageChangeHandler): () => void {
		return this.subscriptions.subscribe(
			normalizeManagedAccountIdentity(email),
			handler,
		);
	}

	dispose(): void {
		this.subscriptions.dispose();
	}

	getDiagnostics(): readonly UsageCoordinationDiagnostic[] {
		return [...this.diagnostics];
	}

	private scopeForIdentity(identity: string): string {
		return join(this.root, deriveManagedAccountDigest(identity));
	}

	private async coordinateRefresh(
		identity: string,
		fetcher: SharedUsageFetcher,
		force: boolean,
	): Promise<UsageRefreshResult> {
		const scope = this.scopeForIdentity(identity);
		await this.storage.cleanAgedDebris(scope);
		const baseline = await this.storage.readCanonical(scope);
		const baselineState = baseline.state;
		const baselineRefreshToken = baselineState?.lastRefresh?.token;
		const initialNow = this.now();

		if (
			!force &&
			isSnapshotFresh(baselineState?.snapshot, initialNow, this.policy)
		) {
			return usageResultFromState(
				baselineState,
				initialNow,
				this.policy,
				"existing-fresh",
			);
		}
		if (
			!force &&
			baselineState?.retryNotBefore !== undefined &&
			baselineState.retryNotBefore > initialNow
		) {
			return usageResultFromState(
				baselineState,
				initialNow,
				this.policy,
				"retry-suppressed",
			);
		}

		try {
			await mkdir(scope, { recursive: true });
			let acquisitionWaitedMs = 0;
			while (true) {
				const beforeAcquisition = await this.storage.readCanonical(scope);
				const capturedInvalidationToken =
					beforeAcquisition.state?.pendingInvalidation?.token;
				const lease = await this.storage.tryAcquireLease(
					scope,
					REFRESH_LEASE_NAME,
					this.policy.refreshLeaseMs,
					capturedInvalidationToken,
				);

				if (!lease) {
					this.recordDiagnostic("refresh-contention", scope);
					if (acquisitionWaitedMs >= this.policy.refreshAcquisitionTimeoutMs) {
						const current = await this.storage.readCanonical(scope);
						return usageResultFromState(
							current.state ?? baselineState,
							this.now(),
							this.policy,
							"failure",
							{
								warning: {
									code: "coordination-unavailable",
									message:
										"Timed out waiting for compatible shared usage refresh work.",
								},
							},
						);
					}
					await sleep(this.policy.refreshJoinPollMs);
					acquisitionWaitedMs += this.policy.refreshJoinPollMs;
					const reconciled = await this.storage.readCanonical(scope);
					if (this.hasNewRefresh(reconciled.state, baselineRefreshToken)) {
						return usageResultFromState(
							reconciled.state,
							this.now(),
							this.policy,
							"joined-work",
						);
					}
					continue;
				}

				const afterAcquisition = await this.storage.readCanonical(scope);
				if (this.hasNewRefresh(afterAcquisition.state, baselineRefreshToken)) {
					await this.storage.releaseLease(lease);
					return usageResultFromState(
						afterAcquisition.state,
						this.now(),
						this.policy,
						"joined-work",
					);
				}

				return await this.runOwnedRefresh(
					identity,
					scope,
					lease,
					fetcher,
					baselineRefreshToken,
				);
			}
		} catch (error) {
			if (!isExpectedFilesystemError(error)) throw error;
			const warning = warningForError(error);
			try {
				const fetched = normalizeUsageSnapshot(
					await this.fetchWithTimeout(fetcher),
					this.now(),
				);
				this.recordDiagnostic("local-fallback", scope);
				return {
					availability: "locally-available",
					source: "local-fallback",
					snapshot: fetched,
					warning,
				};
			} catch (fetchError) {
				const current = await this.storage.readCanonical(scope);
				return usageResultFromState(
					current.state ?? baselineState,
					this.now(),
					this.policy,
					isUsageCancellationError(fetchError) ? "cancellation" : "failure",
					{ error: fetchError, warning },
				);
			}
		}
	}

	private hasNewRefresh(
		state: SharedUsageState | undefined,
		baselineRefreshToken: string | undefined,
	): boolean {
		return Boolean(
			state?.lastRefresh?.token &&
				state.lastRefresh.token !== baselineRefreshToken,
		);
	}

	private async runOwnedRefresh(
		identity: string,
		scope: string,
		lease: OwnedLease,
		fetcher: SharedUsageFetcher,
		baselineRefreshToken: string | undefined,
	): Promise<UsageRefreshResult> {
		const attemptToken = lease.record.token;
		const capturedInvalidationToken = lease.record.capturedInvalidationToken;
		const startedAt = this.now();
		try {
			let fetched: CodexUsageSnapshot;
			try {
				fetched = normalizeUsageSnapshot(
					await this.fetchWithTimeout(fetcher),
					this.now(),
				);
			} catch (error) {
				return await this.publishFetchFailure(
					identity,
					scope,
					attemptToken,
					startedAt,
					error,
				);
			}
			return await this.publishFetchSuccess(
				identity,
				scope,
				attemptToken,
				capturedInvalidationToken,
				startedAt,
				fetched,
				baselineRefreshToken,
			);
		} finally {
			await this.storage.releaseLease(lease);
		}
	}

	private async publishFetchSuccess(
		identity: string,
		scope: string,
		attemptToken: string,
		capturedInvalidationToken: string | undefined,
		startedAt: number,
		fetched: CodexUsageSnapshot,
		baselineRefreshToken: string | undefined,
	): Promise<UsageRefreshResult> {
		const completedAt = this.now();
		const refreshOutcome = {
			token: attemptToken,
			startedAt,
			completedAt,
			outcome: "success" as const,
		};
		const mutation = await this.storage.mutateState(scope, (state) => {
			if (
				state.lastRefresh?.token &&
				state.lastRefresh.token !== baselineRefreshToken
			) {
				this.recordDiagnostic("duplicate-fetch", scope, {
					attemptToken,
					overlappingAttemptToken: state.lastRefresh.token,
				});
			}
			if (state.snapshot && state.snapshot.fetchedAt > fetched.fetchedAt) {
				this.recordDiagnostic("late-publication", scope, {
					publishedFetchedAt: fetched.fetchedAt,
					observedFetchedAt: state.snapshot.fetchedAt,
				});
			}
			const next: SharedUsageState = {
				...withoutRetrySuppression(state),
				snapshot: { ...fetched, attemptToken },
				lastRefresh: refreshOutcome,
			};
			if (
				capturedInvalidationToken !== undefined &&
				state.pendingInvalidation?.token === capturedInvalidationToken
			) {
				delete next.pendingInvalidation;
			}
			return next;
		});
		if (!mutation.published) {
			this.recordDiagnostic("local-fallback", scope);
			return {
				availability: "locally-available",
				source: "local-fallback",
				snapshot: fetched,
				refreshOutcome,
				...(mutation.warning ? { warning: mutation.warning } : {}),
				...(mutation.error ? { error: mutation.error } : {}),
			};
		}
		this.subscriptions.notify(identity, toSharedUsageView(mutation.state));
		return usageResultFromState(
			mutation.state,
			completedAt,
			this.policy,
			"owned-fetch",
		);
	}

	private async publishFetchFailure(
		identity: string,
		scope: string,
		attemptToken: string,
		startedAt: number,
		error: unknown,
	): Promise<UsageRefreshResult> {
		const completedAt = this.now();
		if (isUsageAuthenticationError(error) || isUsageCancellationError(error)) {
			const current = await this.storage.readCanonical(scope);
			return usageResultFromState(
				current.state,
				completedAt,
				this.policy,
				isUsageCancellationError(error) ? "cancellation" : "failure",
				{ error },
			);
		}
		const mutation = await this.storage.mutateState(scope, (state) => ({
			...state,
			lastRefresh: {
				token: attemptToken,
				startedAt,
				completedAt,
				outcome: "failure",
			},
			retryNotBefore: completedAt + this.policy.retrySuppressionMs,
		}));
		if (mutation.published) {
			this.subscriptions.notify(identity, toSharedUsageView(mutation.state));
		}
		return usageResultFromState(
			mutation.state,
			completedAt,
			this.policy,
			"failure",
			{
				error,
				...(mutation.warning ? { warning: mutation.warning } : {}),
			},
		);
	}

	private async fetchWithTimeout(
		fetcher: SharedUsageFetcher,
	): Promise<CodexUsageSnapshot> {
		const controller = new AbortController();
		const timeoutMs =
			this.policy.usageRequestTimeoutMs + this.policy.stateWriteLeaseMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(new UsageRequestTimeoutError("Usage refresh timed out."));
				controller.abort();
			}, timeoutMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([
				fetcher({ signal: controller.signal }),
				timeout,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private waitFor(
		work: Promise<UsageRefreshResult>,
		signal: AbortSignal | undefined,
	): Promise<UsageRefreshResult> {
		return waitForDetached(work, signal, () => ({
			availability: "unavailable",
			source: "cancellation",
		}));
	}

	private recordDiagnostic(
		action: UsageCoordinationDiagnostic["action"],
		scope: string,
		details?: Record<string, unknown>,
	): void {
		this.diagnostics.push({
			at: this.now(),
			action,
			scopeDigest: scope === this.root ? "coordination-root" : scope.slice(-64),
			...(details ? { details } : {}),
		});
		if (this.diagnostics.length > this.policy.maxDiagnosticsEntries) {
			this.diagnostics.shift();
		}
	}
}

export function createFilesystemUsageCoordination(
	options: FilesystemUsageCoordinationOptions,
): FilesystemUsageCoordination {
	return new FilesystemUsageCoordination(options);
}
