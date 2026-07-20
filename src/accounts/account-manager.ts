import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { normalizeUnknownError } from "../platform/streams";
import {
	isFreshUsageConfirmation,
	PRODUCTION_USAGE_COORDINATION_POLICY,
	UsageAuthenticationError,
	type UsageCoordinationDiagnostic,
	type UsageRefreshResult,
} from "../usage/coordination/index";
import {
	type CodexUsageSnapshot,
	getQuotaCooldownResetAt,
} from "../usage/usage";
import { fetchCodexUsage } from "../usage/usage-client";
import {
	getUsageCoordinator,
	normalizeUsageEmail,
} from "../usage/usage-coordinator";
import {
	loadImportedOpenAICodexAuth,
	watchImportedOpenAICodexAuth,
} from "./auth";
import { refreshOpenAICodexToken } from "./codex-oauth";
import {
	type CacheAffinityContext,
	isAccountAvailable,
	pickBestAccount,
} from "./selection";
import {
	type Account,
	loadStorage,
	type StorageData,
	saveStorage,
} from "./storage";

const USAGE_REQUEST_TIMEOUT_MS =
	PRODUCTION_USAGE_COORDINATION_POLICY.usageRequestTimeoutMs;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const PI_AUTH_SYNC_RETRY_DELAYS_MS = [25, 50] as const;

type WarningHandler = (message: string) => void;
type StateChangeHandler = () => void;
type InitializationToken = symbol;

export interface UsageRefreshOptions {
	force?: boolean;
	signal?: AbortSignal;
	warningHandler?: WarningHandler;
}

interface PiAuthLoadOptions {
	authFile?: string;
	shouldApply?: () => boolean;
	generation?: number;
	throwOnNonEnoentError?: boolean;
}

interface PiAuthWatchOptions {
	authFile?: string;
	onError?: (error: unknown) => void;
	shouldApply?: () => boolean;
}

export class AccountManager {
	private data: StorageData;
	private readonly usageCoordinator = getUsageCoordinator();
	private refreshPromises = new Map<string, Promise<string>>();
	private warningHandler?: WarningHandler;
	private manualEmail?: string;
	private initializing = false;
	private stateChangeHandlers = new Set<StateChangeHandler>();
	private warnedAuthFailureEmails = new Set<string>();
	private disposePiAuthWatch?: () => void;
	private piAuthWatchShouldApply?: () => boolean;
	private piAuthWatchOnError?: (error: unknown) => void;
	private piAuthWatchAuthFile?: string;
	private piAuthWatchSync?: Promise<void>;
	private piAuthWatchEventQueued = false;
	private piAuthWatchGeneration = 0;
	private readyPromise: Promise<void> = Promise.resolve();
	private readyResolve?: () => void;
	private initializationToken?: InitializationToken;
	private usageWarningUnsubscribe?: () => void;

	constructor() {
		this.data = loadStorage();
	}

	/**
	 * Mark the account manager as initializing. Stream requests wait on
	 * {@link waitUntilReady} so they don't race the latest startup refresh.
	 */
	beginInitialization(): InitializationToken {
		const token = Symbol("multicodex-initialization");
		this.initializationToken = token;
		if (!this.initializing) {
			this.initializing = true;
			this.readyPromise = new Promise<void>((resolve) => {
				this.readyResolve = resolve;
			});
			this.notifyStateChanged();
		}
		return token;
	}

	markReady(token?: InitializationToken): void {
		if (token && token !== this.initializationToken) return;
		this.initializing = false;
		this.initializationToken = undefined;
		this.readyResolve?.();
		this.readyResolve = undefined;
		this.notifyStateChanged();
	}

	isInitializing(): boolean {
		return this.initializing;
	}

	waitUntilReady(): Promise<void> {
		return this.readyPromise;
	}

	private save(): void {
		saveStorage(this.data);
	}

	private notifyStateChanged(): void {
		for (const handler of this.stateChangeHandlers) {
			handler();
		}
	}

	onStateChange(handler: StateChangeHandler): () => void {
		this.stateChangeHandlers.add(handler);
		return () => {
			this.stateChangeHandlers.delete(handler);
		};
	}

	getAccounts(): Account[] {
		return this.data.accounts;
	}

	getAccount(email: string): Account | undefined {
		return this.data.accounts.find((a) => a.email === email);
	}

	isPiAuthAccount(account: Account): boolean {
		return account.piAuth === true;
	}

	setWarningHandler(handler?: WarningHandler): void {
		this.warningHandler = handler;
		this.usageWarningUnsubscribe?.();
		this.usageWarningUnsubscribe = handler
			? this.usageCoordinator.onWarning((warning) => handler(warning.message))
			: undefined;
	}

	resetSessionWarnings(): void {
		this.warnedAuthFailureEmails.clear();
		this.usageCoordinator.resetWarnings();
	}

	getUsageDiagnostics(): readonly UsageCoordinationDiagnostic[] {
		return this.usageCoordinator.getDiagnostics();
	}

	notifyRotationSkipForAuthFailure(account: Account, error: unknown): void {
		if (this.warnedAuthFailureEmails.has(account.email)) {
			return;
		}
		this.warnedAuthFailureEmails.add(account.email);
		const hint = `/multicodex reauth ${account.email}`;
		this.warningHandler?.(
			`Multicodex skipped ${account.email} during rotation: ${normalizeUnknownError(error)}. Account is flagged in /multicodex accounts. Run ${hint} to repair it.`,
		);
	}

	private removeAccountRecord(account: Account): boolean {
		const index = this.data.accounts.findIndex(
			(candidate) => candidate.email === account.email,
		);
		if (index < 0) return false;
		const removedEmail = this.data.accounts[index]?.email;
		this.data.accounts.splice(index, 1);
		if (removedEmail) {
			if (this.manualEmail === removedEmail) {
				this.manualEmail = undefined;
			}
			if (this.data.activeEmail === removedEmail) {
				this.data.activeEmail = this.data.accounts[0]?.email;
			}
		}
		return true;
	}

	private credentialsMatch(account: Account, creds: OAuthCredentials): boolean {
		const accountId =
			typeof creds.accountId === "string" ? creds.accountId : undefined;
		return (
			account.accessToken === creds.access &&
			account.refreshToken === creds.refresh &&
			account.expiresAt === creds.expires &&
			(!accountId || account.accountId === accountId)
		);
	}

	private applyCredentials(
		account: Account,
		creds: OAuthCredentials,
		options?: { clearNeedsReauth?: boolean },
	): boolean {
		const accountId =
			typeof creds.accountId === "string" ? creds.accountId : undefined;
		let changed = false;
		if (account.accessToken !== creds.access) {
			account.accessToken = creds.access;
			changed = true;
		}
		if (account.refreshToken !== creds.refresh) {
			account.refreshToken = creds.refresh;
			changed = true;
		}
		if (account.expiresAt !== creds.expires) {
			account.expiresAt = creds.expires;
			changed = true;
		}
		if (accountId && account.accountId !== accountId) {
			account.accountId = accountId;
			changed = true;
		}
		if (options?.clearNeedsReauth !== false && account.needsReauth) {
			account.needsReauth = undefined;
			this.warnedAuthFailureEmails.delete(account.email);
			changed = true;
		}
		return changed;
	}

	addOrUpdateAccount(
		email: string,
		creds: OAuthCredentials,
		options?: { clearNeedsReauth?: boolean },
	): Account {
		const existing = this.data.accounts.find((a) => a.email === email);
		if (existing) {
			const changed = this.applyCredentials(existing, creds, options);
			if (changed) {
				this.save();
				this.notifyStateChanged();
			}
			return existing;
		}

		const account: Account = {
			email,
			accessToken: creds.access,
			refreshToken: creds.refresh,
			expiresAt: creds.expires,
			accountId:
				typeof creds.accountId === "string" ? creds.accountId : undefined,
		};
		this.data.accounts.push(account);
		this.setActiveAccount(email);
		return account;
	}

	getActiveAccount(): Account | undefined {
		const manual = this.getManualAccount();
		if (manual) return manual;
		if (this.data.activeEmail) {
			return this.getAccount(this.data.activeEmail);
		}
		return this.data.accounts[0];
	}

	getManualAccount(): Account | undefined {
		if (!this.manualEmail) return undefined;
		const account = this.getAccount(this.manualEmail);
		if (!account) {
			this.manualEmail = undefined;
			return undefined;
		}
		return account;
	}

	hasManualAccount(): boolean {
		return Boolean(this.manualEmail);
	}

	setActiveAccount(email: string): void {
		this.data.activeEmail = email;
		this.save();
		this.notifyStateChanged();
	}

	setManualAccount(email: string): void {
		const account = this.getAccount(email);
		if (!account) return;
		this.manualEmail = email;
		account.lastUsed = Date.now();
		this.notifyStateChanged();
	}

	clearManualAccount(): void {
		if (!this.manualEmail) return;
		this.manualEmail = undefined;
		this.notifyStateChanged();
	}

	/**
	 * Read pi's openai-codex auth from auth.json and merge it into the
	 * normal managed account pool so pi-login accounts behave like all others.
	 */
	private isPiAuthLoadAllowed(options?: PiAuthLoadOptions): boolean {
		return (
			(options?.generation === undefined ||
				options.generation === this.piAuthWatchGeneration) &&
			options?.shouldApply?.() !== false
		);
	}

	private isPiAuthWatchCurrent(
		generation: number,
		shouldApply?: () => boolean,
	): boolean {
		return (
			generation === this.piAuthWatchGeneration && shouldApply?.() !== false
		);
	}

	private async loadPiAuthInternal(
		options?: PiAuthLoadOptions,
	): Promise<boolean> {
		if (!this.isPiAuthLoadAllowed(options)) return false;
		const imported = await loadImportedOpenAICodexAuth({
			...(options?.authFile ? { authFile: options.authFile } : {}),
			...(options?.throwOnNonEnoentError
				? { throwOnNonEnoentError: true }
				: {}),
		});
		if (!this.isPiAuthLoadAllowed(options) || !imported) return false;

		const existing = this.data.accounts.find(
			(account) => account.email === imported.identifier,
		);
		const account = this.addOrUpdateAccount(
			imported.identifier,
			imported.credentials,
			{
				clearNeedsReauth:
					!existing || !this.credentialsMatch(existing, imported.credentials),
			},
		);
		if (!account.piAuth) {
			account.piAuth = true;
			this.save();
			this.notifyStateChanged();
		}
		return true;
	}

	async loadPiAuth(options?: PiAuthLoadOptions): Promise<void> {
		await this.loadPiAuthInternal(options);
	}

	private reportPiAuthWatchError(
		generation: number,
		error: unknown,
		shouldApply?: () => boolean,
		onError?: (error: unknown) => void,
	): void {
		if (!this.isPiAuthWatchCurrent(generation, shouldApply)) return;
		(onError ?? this.piAuthWatchOnError)?.(error);
	}

	private retirePiAuthWatch(generation: number): void {
		if (generation !== this.piAuthWatchGeneration) return;
		this.disposePiAuthWatch?.();
		this.disposePiAuthWatch = undefined;
		this.piAuthWatchGeneration += 1;
		this.piAuthWatchEventQueued = false;
		this.piAuthWatchSync = undefined;
		this.piAuthWatchShouldApply = undefined;
		this.piAuthWatchOnError = undefined;
		this.piAuthWatchAuthFile = undefined;
	}

	private handlePiAuthWatchFailure(generation: number, error: unknown): void {
		const shouldApply = this.piAuthWatchShouldApply;
		const onError = this.piAuthWatchOnError;
		try {
			this.reportPiAuthWatchError(generation, error, shouldApply, onError);
		} finally {
			this.retirePiAuthWatch(generation);
		}
	}

	private async syncPiAuthAfterEvent(options: {
		generation: number;
		authFile?: string;
		shouldApply?: () => boolean;
	}): Promise<void> {
		for (let attempt = 0; ; attempt += 1) {
			if (!this.isPiAuthWatchCurrent(options.generation, options.shouldApply)) {
				return;
			}
			try {
				const loaded = await this.loadPiAuthInternal({
					authFile: options.authFile,
					generation: options.generation,
					shouldApply: options.shouldApply,
					throwOnNonEnoentError: true,
				});
				if (
					!this.isPiAuthWatchCurrent(options.generation, options.shouldApply) ||
					loaded ||
					attempt >= PI_AUTH_SYNC_RETRY_DELAYS_MS.length
				) {
					return;
				}
			} catch (error) {
				if (
					!this.isPiAuthWatchCurrent(options.generation, options.shouldApply)
				) {
					return;
				}
				if (attempt >= PI_AUTH_SYNC_RETRY_DELAYS_MS.length) throw error;
			}
			if (!this.isPiAuthWatchCurrent(options.generation, options.shouldApply)) {
				return;
			}
			const delay = PI_AUTH_SYNC_RETRY_DELAYS_MS[attempt];
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
	}

	private handlePiAuthWatchEvent(generation: number): void {
		if (generation !== this.piAuthWatchGeneration) return;
		if (this.piAuthWatchSync) {
			this.piAuthWatchEventQueued = true;
			return;
		}

		const shouldApply = this.piAuthWatchShouldApply;
		const onError = this.piAuthWatchOnError;
		const authFile = this.piAuthWatchAuthFile;
		let tracked: Promise<void>;
		tracked = this.syncPiAuthAfterEvent({
			generation,
			authFile,
			shouldApply,
		})
			.catch((error) => {
				this.reportPiAuthWatchError(generation, error, shouldApply, onError);
			})
			.finally(() => {
				if (this.piAuthWatchSync !== tracked) return;
				this.piAuthWatchSync = undefined;
				if (
					this.piAuthWatchEventQueued &&
					generation === this.piAuthWatchGeneration &&
					this.disposePiAuthWatch &&
					shouldApply?.() !== false
				) {
					this.piAuthWatchEventQueued = false;
					this.handlePiAuthWatchEvent(generation);
				} else {
					this.piAuthWatchEventQueued = false;
				}
			});
		this.piAuthWatchSync = tracked;
	}

	startPiAuthWatch(options?: PiAuthWatchOptions): void {
		this.piAuthWatchShouldApply = options?.shouldApply;
		this.piAuthWatchOnError = options?.onError;
		this.piAuthWatchAuthFile = options?.authFile;
		if (this.disposePiAuthWatch) return;

		const generation = ++this.piAuthWatchGeneration;
		const dispose = watchImportedOpenAICodexAuth(
			() => this.handlePiAuthWatchEvent(generation),
			{
				authFile: options?.authFile,
				onError: (error) => this.handlePiAuthWatchFailure(generation, error),
			},
		);
		if (dispose) this.disposePiAuthWatch = dispose;
	}

	stopPiAuthWatch(): void {
		this.piAuthWatchGeneration += 1;
		this.piAuthWatchEventQueued = false;
		this.disposePiAuthWatch?.();
		this.disposePiAuthWatch = undefined;
		this.piAuthWatchShouldApply = undefined;
		this.piAuthWatchOnError = undefined;
		this.piAuthWatchAuthFile = undefined;
		this.piAuthWatchSync = undefined;
	}

	getAvailableManualAccount(options?: {
		excludeEmails?: Set<string>;
		now?: number;
	}): Account | undefined {
		const manual = this.getManualAccount();
		if (!manual) return undefined;
		const now = options?.now ?? Date.now();
		if (!isAccountAvailable(manual, now)) return undefined;
		if (options?.excludeEmails?.has(manual.email)) return undefined;
		return manual;
	}

	getAvailableActiveAccount(options?: {
		excludeEmails?: Set<string>;
		now?: number;
	}): Account | undefined {
		const active = this.getActiveAccount();
		if (!active) return undefined;
		const now = options?.now ?? Date.now();
		if (!isAccountAvailable(active, now)) return undefined;
		if (options?.excludeEmails?.has(active.email)) return undefined;
		return active;
	}

	markExhausted(email: string, until: number): void {
		const account = this.getAccount(email);
		if (account) {
			account.quotaExhaustedUntil = until;
			this.save();
			this.notifyStateChanged();
		}
	}

	clearAllQuotaExhaustion(): number {
		let cleared = 0;
		for (const account of this.getAccounts()) {
			if (account.quotaExhaustedUntil) {
				account.quotaExhaustedUntil = undefined;
				cleared += 1;
			}
		}
		if (cleared > 0) {
			this.save();
			this.notifyStateChanged();
		}
		return cleared;
	}

	async reconcileQuotaCooldowns(options?: {
		excludeEmails?: Set<string>;
		signal?: AbortSignal;
		warningHandler?: WarningHandler;
	}): Promise<number> {
		const now = Date.now();
		let cleared = 0;
		let changed = false;

		for (const account of this.getAccounts()) {
			if (!account.quotaExhaustedUntil) continue;
			if (options?.excludeEmails?.has(account.email)) continue;

			if (account.quotaExhaustedUntil <= now) {
				account.quotaExhaustedUntil = undefined;
				cleared += 1;
				changed = true;
				continue;
			}

			await this.refreshUsageForAccount(account, {
				force: true,
				signal: options?.signal,
				warningHandler: options?.warningHandler,
			});
			if (!account.quotaExhaustedUntil) {
				cleared += 1;
			}
		}

		if (changed) {
			this.save();
			this.notifyStateChanged();
		}
		return cleared;
	}

	removeAccount(email: string): boolean {
		const account = this.getAccount(email);
		if (!account) return false;
		this.usageCoordinator.forget(account);
		const removed = this.removeAccountRecord(account);
		if (!removed) return false;
		this.save();
		this.notifyStateChanged();
		return true;
	}

	getCachedUsage(email: string): CodexUsageSnapshot | undefined {
		const account = this.getAccount(email);
		return this.usageCoordinator.getCachedUsage(account ?? email);
	}

	subscribeUsageObserver(handler?: StateChangeHandler): () => void {
		const unsubscribeObserver = this.usageCoordinator.subscribeActiveObserver();
		const unsubscribeUsageChange = handler
			? this.usageCoordinator.onUsageChange(() => handler())
			: () => undefined;
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			unsubscribeUsageChange();
			unsubscribeObserver();
		};
	}

	private async fetchUsageSnapshotForAccount(
		account: Account,
		options: { signal?: AbortSignal },
	): Promise<CodexUsageSnapshot> {
		let token: string;
		try {
			token = await this.ensureValidToken(account);
		} catch (error) {
			throw new UsageAuthenticationError(normalizeUnknownError(error));
		}
		return fetchCodexUsage(token, account.accountId, {
			signal: options.signal,
			timeoutMs: USAGE_REQUEST_TIMEOUT_MS,
		});
	}

	recordUsageConsumption(account: Account): void {
		if (!this.getAccounts().some((candidate) => candidate === account)) return;
		this.usageCoordinator.recordUsageConsumption(
			account,
			(_usageAccount, options) =>
				this.fetchUsageSnapshotForAccount(account, options),
		);
	}

	getAccountsNeedingReauth(): Account[] {
		return this.data.accounts.filter((a) => a.needsReauth);
	}

	private markNeedsReauth(account: Account): void {
		account.needsReauth = true;
		this.save();
		this.notifyStateChanged();
	}

	async refreshUsageForAccount(
		account: Account,
		options?: UsageRefreshOptions,
	): Promise<UsageRefreshResult> {
		if (account.needsReauth) {
			return {
				...this.usageCoordinator.getCachedResult(account),
				error: new UsageAuthenticationError("re-authentication required"),
			};
		}

		try {
			const result = await this.usageCoordinator.refresh(
				account,
				(_usageAccount, request) =>
					this.fetchUsageSnapshotForAccount(account, request),
				{
					force: options?.force,
					signal: options?.signal,
				},
			);
			if (result.error) {
				(options?.warningHandler ?? this.warningHandler)?.(
					`Multicodex: failed to fetch usage for ${account.email}: ${normalizeUnknownError(
						result.error,
					)}`,
				);
			}
			if (
				result.warning &&
				options?.warningHandler &&
				options.warningHandler !== this.warningHandler
			) {
				options.warningHandler(result.warning.message);
			}
			this.clearQuotaCooldownWhenFreshUsageRemains(account, result);
			return result;
		} catch (error) {
			(options?.warningHandler ?? this.warningHandler)?.(
				`Multicodex: failed to fetch usage for ${account.email}: ${normalizeUnknownError(
					error,
				)}`,
			);
			return {
				...this.usageCoordinator.getCachedResult(account),
				error,
			};
		}
	}

	private clearQuotaCooldownWhenFreshUsageRemains(
		account: Account,
		result: UsageRefreshResult,
	): void {
		const primaryUsedPercent = result.snapshot?.primary?.usedPercent;
		const secondaryUsedPercent = result.snapshot?.secondary?.usedPercent;
		const effectiveUsedPercent =
			typeof primaryUsedPercent === "number" &&
			Number.isFinite(primaryUsedPercent)
				? primaryUsedPercent
				: secondaryUsedPercent;
		const hasRemainingUsage =
			typeof effectiveUsedPercent === "number" &&
			Number.isFinite(effectiveUsedPercent) &&
			effectiveUsedPercent >= 0 &&
			effectiveUsedPercent < 100;
		if (
			!account.quotaExhaustedUntil ||
			!isFreshUsageConfirmation(result) ||
			!hasRemainingUsage
		) {
			return;
		}

		// The 5h window is the effective limit when known; otherwise weekly usage
		// becomes authoritative. Any remaining effective quota proves this stale.
		account.quotaExhaustedUntil = undefined;
		this.save();
		this.notifyStateChanged();
	}

	async refreshUsageForAllAccounts(
		options?: UsageRefreshOptions,
	): Promise<Record<string, UsageRefreshResult>> {
		const accounts = this.getAccounts();
		const entries = await Promise.all(
			accounts.map(
				async (account) =>
					[
						normalizeUsageEmail(account.email),
						await this.refreshUsageForAccount(account, options),
					] as const,
			),
		);
		return Object.fromEntries(entries);
	}

	async refreshUsageIfStale(
		accounts: Account[],
		options?: Omit<UsageRefreshOptions, "force">,
	): Promise<void> {
		await Promise.all(
			accounts.map((account) => this.refreshUsageForAccount(account, options)),
		);
	}

	async activateBestAccount(options?: {
		excludeEmails?: Set<string>;
		signal?: AbortSignal;
		cacheAffinity?: Omit<CacheAffinityContext, "activeEmail">;
		warningHandler?: WarningHandler;
		shouldApply?: () => boolean;
	}): Promise<Account | undefined> {
		if (options?.shouldApply?.() === false) return undefined;
		const now = Date.now();
		this.clearExpiredExhaustion(now);
		const accounts = this.getAccounts();
		await this.refreshUsageIfStale(accounts, options);
		if (options?.shouldApply?.() === false) return undefined;

		const activeEmail = this.getActiveAccount()?.email;
		const usageByEmail = new Map<string, CodexUsageSnapshot>();
		for (const account of accounts) {
			const usage = this.getCachedUsage(account.email);
			if (usage) usageByEmail.set(account.email, usage);
		}
		const selected = pickBestAccount(accounts, usageByEmail, {
			excludeEmails: options?.excludeEmails,
			now,
			cacheAffinity: options?.cacheAffinity
				? { ...options.cacheAffinity, activeEmail }
				: undefined,
		});
		if (selected && options?.shouldApply?.() !== false) {
			this.setActiveAccount(selected.email);
		}
		return selected;
	}

	async handleQuotaExceeded(
		account: Account,
		options?: { signal?: AbortSignal; warningHandler?: WarningHandler },
	): Promise<void> {
		const usage = await this.refreshUsageForAccount(account, {
			force: true,
			signal: options?.signal,
			warningHandler: options?.warningHandler,
		});
		const now = Date.now();
		const resetAt = getQuotaCooldownResetAt(usage.snapshot, now);
		const fallback = now + QUOTA_COOLDOWN_MS;
		const until = resetAt && resetAt > now ? resetAt : fallback;
		this.markExhausted(account.email, until);
	}

	private clearExpiredExhaustion(now: number): void {
		let changed = false;
		for (const account of this.getAccounts()) {
			if (account.quotaExhaustedUntil && account.quotaExhaustedUntil <= now) {
				account.quotaExhaustedUntil = undefined;
				changed = true;
			}
		}
		if (changed) {
			this.save();
			this.notifyStateChanged();
		}
	}

	async ensureValidToken(account: Account): Promise<string> {
		if (account.needsReauth) {
			const hint = `/multicodex use ${account.email}`;
			throw new Error(
				`${account.email}: re-authentication required — run ${hint}`,
			);
		}

		if (Date.now() < account.expiresAt - 5 * 60 * 1000) {
			return account.accessToken;
		}

		const inflight = this.refreshPromises.get(account.email);
		if (inflight) {
			return inflight;
		}

		const promise = (async () => {
			try {
				const result = await refreshOpenAICodexToken(account.refreshToken);
				account.accessToken = result.access;
				account.refreshToken = result.refresh;
				account.expiresAt = result.expires;
				const accountId =
					typeof result.accountId === "string" ? result.accountId : undefined;
				if (accountId) {
					account.accountId = accountId;
				}
				this.save();
				this.notifyStateChanged();
				return account.accessToken;
			} catch (error) {
				this.markNeedsReauth(account);
				throw error;
			} finally {
				this.refreshPromises.delete(account.email);
			}
		})();

		this.refreshPromises.set(account.email, promise);
		return promise;
	}
}
