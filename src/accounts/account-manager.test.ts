import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storageData: {
		accounts: [] as Array<Record<string, unknown>>,
		activeEmail: undefined as string | undefined,
	},
	loadImportedOpenAICodexAuth: vi.fn(),
	watchImportedOpenAICodexAuth: vi.fn(),
	fetchCodexUsage: vi.fn(),
	saveStorage: vi.fn(),
}));

vi.mock("./storage", () => ({
	loadStorage: () =>
		JSON.parse(JSON.stringify(mocks.storageData)) as {
			accounts: Array<Record<string, unknown>>;
			activeEmail?: string;
		},
	saveStorage: mocks.saveStorage,
}));

vi.mock("./auth", () => ({
	loadImportedOpenAICodexAuth: mocks.loadImportedOpenAICodexAuth,
	watchImportedOpenAICodexAuth: mocks.watchImportedOpenAICodexAuth,
}));

vi.mock("./codex-oauth", () => ({
	refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("../usage/usage-client", () => ({
	fetchCodexUsage: mocks.fetchCodexUsage,
}));

import {
	createInMemoryUsageCoordination,
	UsageAuthenticationError,
} from "../usage/coordination/index";
import {
	resetUsageCoordinatorForTests,
	USAGE_FRESHNESS_INTERVAL_MS,
} from "../usage/usage-coordinator";
import { AccountManager } from "./account-manager";

beforeEach(() => {
	resetUsageCoordinatorForTests();
});

describe("AccountManager pi auth import", () => {
	beforeEach(() => {
		resetUsageCoordinatorForTests();
		vi.clearAllMocks();
		mocks.storageData.accounts = [];
		mocks.storageData.activeEmail = undefined;
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
		mocks.watchImportedOpenAICodexAuth.mockReset();
		mocks.watchImportedOpenAICodexAuth.mockReturnValue(() => undefined);
	});

	it("imports pi auth into the managed account pool", async () => {
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "fp",
			credentials: {
				access: "pi-access",
				refresh: "pi-refresh",
				expires: Date.now() + 3600_000,
				accountId: "pi-acc",
			},
		});

		const manager = new AccountManager();
		await manager.loadPiAuth();

		expect(manager.getAccounts()).toHaveLength(1);
		const account = manager.getAccount("pi@example.com");
		expect(account).toMatchObject({
			email: "pi@example.com",
			accessToken: "pi-access",
			refreshToken: "pi-refresh",
			accountId: "pi-acc",
			piAuth: true,
		});
		expect(account ? manager.isPiAuthAccount(account) : false).toBe(true);
		expect(manager.getActiveAccount()?.email).toBe("pi@example.com");
		expect(mocks.saveStorage).toHaveBeenCalled();
	});

	it("creates a normal managed account even if refresh token matches a different email", async () => {
		mocks.storageData.accounts = [
			{
				email: "managed@example.com",
				accessToken: "managed-access",
				refreshToken: "shared-refresh",
				expiresAt: Date.now() + 3600_000,
				accountId: "acc-1",
			},
		];
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "fp",
			credentials: {
				access: "pi-access",
				refresh: "shared-refresh",
				expires: Date.now() + 3600_000,
				accountId: "acc-1",
			},
		});

		const manager = new AccountManager();
		await manager.loadPiAuth();

		// Different emails = different accounts, even if same refresh token.
		expect(manager.getAccounts()).toHaveLength(2);
		expect(manager.getAccount("managed@example.com")).toBeDefined();
		expect(manager.getAccount("pi@example.com")).toMatchObject({
			piAuth: true,
		});
	});

	it("updates an existing managed account with the same email", async () => {
		mocks.storageData.accounts = [
			{
				email: "pi@example.com",
				accessToken: "managed-access",
				refreshToken: "managed-refresh",
				expiresAt: 100,
			},
		];
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "fp",
			credentials: {
				access: "pi-access",
				refresh: "different-refresh",
				expires: 200,
			},
		});

		const manager = new AccountManager();
		await manager.loadPiAuth();

		expect(manager.getAccounts()).toHaveLength(1);
		expect(manager.getAccount("pi@example.com")).toMatchObject({
			accessToken: "pi-access",
			refreshToken: "different-refresh",
			expiresAt: 200,
			piAuth: true,
		});
		expect(mocks.saveStorage).toHaveBeenCalled();
	});

	it("clears flagged state when pi login writes new credentials", async () => {
		mocks.storageData.accounts = [
			{
				email: "pi@example.com",
				accessToken: "stale-access",
				refreshToken: "stale-refresh",
				expiresAt: 100,
				needsReauth: true,
				piAuth: true,
			},
		];
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "new-fingerprint",
			credentials: {
				access: "fresh-access",
				refresh: "fresh-refresh",
				expires: Date.now() + 3600_000,
			},
		});

		const manager = new AccountManager();
		const account = manager.getAccount("pi@example.com");
		expect(account).toBeDefined();
		if (!account) return;

		await manager.loadPiAuth();
		await expect(manager.ensureValidToken(account)).resolves.toBe(
			"fresh-access",
		);
		expect(account).toMatchObject({
			accessToken: "fresh-access",
			refreshToken: "fresh-refresh",
			needsReauth: undefined,
		});
	});

	it("keeps reauth state when pi auth credentials did not change", async () => {
		const credentials = {
			access: "stale-access",
			refresh: "stale-refresh",
			expires: 100,
		};
		mocks.storageData.accounts = [
			{
				email: "pi@example.com",
				accessToken: credentials.access,
				refreshToken: credentials.refresh,
				expiresAt: credentials.expires,
				needsReauth: true,
				piAuth: true,
			},
		];
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "same-fingerprint",
			credentials,
		});

		const manager = new AccountManager();
		await manager.loadPiAuth();

		expect(manager.getAccount("pi@example.com")?.needsReauth).toBe(true);
	});

	it("syncs pi auth when the auth file watcher reports a login", async () => {
		mocks.storageData.accounts = [
			{
				email: "pi@example.com",
				accessToken: "stale-access",
				refreshToken: "stale-refresh",
				expiresAt: 100,
				needsReauth: true,
				piAuth: true,
			},
		];
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "new-fingerprint",
			credentials: {
				access: "fresh-access",
				refresh: "fresh-refresh",
				expires: Date.now() + 3600_000,
			},
		});

		let reportLogin: (() => void) | undefined;
		const dispose = vi.fn();
		mocks.watchImportedOpenAICodexAuth.mockImplementation((handler) => {
			reportLogin = handler;
			return dispose;
		});

		const manager = new AccountManager();
		manager.startPiAuthWatch();
		expect(reportLogin).toBeTypeOf("function");
		reportLogin?.();

		await vi.waitFor(() => {
			expect(manager.getAccount("pi@example.com")?.needsReauth).toBeUndefined();
		});
		manager.stopPiAuthWatch();

		expect(dispose).toHaveBeenCalledOnce();
	});

	it("retries transient auth reads after a file event", async () => {
		mocks.storageData.accounts = [
			{
				email: "pi@example.com",
				accessToken: "stale-access",
				refreshToken: "stale-refresh",
				expiresAt: 100,
				needsReauth: true,
				piAuth: true,
			},
		];
		mocks.loadImportedOpenAICodexAuth
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({
				identifier: "pi@example.com",
				fingerprint: "new-fingerprint",
				credentials: {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 3600_000,
				},
			});

		let reportChange: (() => void) | undefined;
		mocks.watchImportedOpenAICodexAuth.mockImplementation((handler) => {
			reportChange = handler;
			return () => undefined;
		});

		const manager = new AccountManager();
		manager.startPiAuthWatch();
		reportChange?.();

		await vi.waitFor(() => {
			expect(manager.getAccount("pi@example.com")?.needsReauth).toBeUndefined();
		});
		expect(mocks.loadImportedOpenAICodexAuth).toHaveBeenCalledTimes(2);
		manager.stopPiAuthWatch();
	});

	it("does not apply a pending watcher load after stop", async () => {
		const imported = {
			identifier: "pi@example.com",
			fingerprint: "new-fingerprint",
			credentials: {
				access: "fresh-access",
				refresh: "fresh-refresh",
				expires: Date.now() + 3600_000,
			},
		};
		let resolveLoad: (value: typeof imported) => void = () => undefined;
		const load = new Promise<typeof imported>((resolve) => {
			resolveLoad = resolve;
		});
		mocks.loadImportedOpenAICodexAuth.mockReturnValue(load);

		let reportChange: (() => void) | undefined;
		mocks.watchImportedOpenAICodexAuth.mockImplementation((handler) => {
			reportChange = handler;
			return () => undefined;
		});

		const manager = new AccountManager();
		manager.startPiAuthWatch();
		reportChange?.();
		expect(mocks.loadImportedOpenAICodexAuth).toHaveBeenCalledOnce();

		manager.stopPiAuthWatch();
		resolveLoad(imported);
		await Promise.resolve();
		await Promise.resolve();

		expect(manager.getAccounts()).toHaveLength(0);
		expect(mocks.saveStorage).not.toHaveBeenCalled();
	});

	it("retries watcher setup after a failed start", async () => {
		const setupError = new Error("watch setup failed");
		const dispose = vi.fn();
		const onError = vi.fn();
		const imported = {
			identifier: "pi@example.com",
			fingerprint: "fingerprint",
			credentials: {
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3600_000,
			},
		};
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(imported);
		let reportChange: (() => void) | undefined;
		mocks.watchImportedOpenAICodexAuth
			.mockImplementationOnce((_handler, options) => {
				options?.onError?.(setupError);
				return undefined;
			})
			.mockImplementationOnce((handler) => {
				reportChange = handler;
				return dispose;
			});

		const manager = new AccountManager();
		manager.startPiAuthWatch({ onError });
		expect(onError).toHaveBeenCalledWith(setupError);

		manager.startPiAuthWatch({ onError });
		reportChange?.();
		await vi.waitFor(() => {
			expect(manager.getAccount("pi@example.com")).toBeDefined();
		});
		expect(mocks.watchImportedOpenAICodexAuth).toHaveBeenCalledTimes(2);
		manager.stopPiAuthWatch();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("restarts the auth watcher after a runtime failure", () => {
		const runtimeError = new Error("watcher stopped");
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();
		let reportRuntimeError: ((error: unknown) => void) | undefined;
		mocks.watchImportedOpenAICodexAuth
			.mockImplementationOnce((_handler, options) => {
				reportRuntimeError = options?.onError;
				return firstDispose;
			})
			.mockReturnValueOnce(secondDispose);
		const onError = vi.fn();

		const manager = new AccountManager();
		manager.startPiAuthWatch({ onError });
		reportRuntimeError?.(runtimeError);

		expect(onError).toHaveBeenCalledWith(runtimeError);
		expect(firstDispose).toHaveBeenCalledOnce();
		manager.startPiAuthWatch({ onError });
		expect(mocks.watchImportedOpenAICodexAuth).toHaveBeenCalledTimes(2);

		manager.stopPiAuthWatch();
		expect(secondDispose).toHaveBeenCalledOnce();
	});

	it("reports malformed watcher auth after retry exhaustion", async () => {
		const malformedAuth = new SyntaxError("Unexpected end of JSON input");
		mocks.loadImportedOpenAICodexAuth.mockRejectedValue(malformedAuth);
		let reportChange: (() => void) | undefined;
		mocks.watchImportedOpenAICodexAuth.mockImplementation((handler) => {
			reportChange = handler;
			return () => undefined;
		});
		const onError = vi.fn();

		const manager = new AccountManager();
		manager.startPiAuthWatch({ onError });
		reportChange?.();

		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(malformedAuth));
		expect(mocks.loadImportedOpenAICodexAuth).toHaveBeenCalledTimes(3);
		expect(
			mocks.loadImportedOpenAICodexAuth.mock.calls.every(
				([options]) => options?.throwOnNonEnoentError === true,
			),
		).toBe(true);
		manager.stopPiAuthWatch();
	});

	it("keeps missing watcher auth quiet after retry exhaustion", async () => {
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
		let reportChange: (() => void) | undefined;
		mocks.watchImportedOpenAICodexAuth.mockImplementation((handler) => {
			reportChange = handler;
			return () => undefined;
		});
		const onError = vi.fn();

		const manager = new AccountManager();
		manager.startPiAuthWatch({ onError });
		reportChange?.();

		await vi.waitFor(() => {
			expect(mocks.loadImportedOpenAICodexAuth).toHaveBeenCalledTimes(3);
		});
		expect(onError).not.toHaveBeenCalled();
		manager.stopPiAuthWatch();
	});

	it("reports watcher sync failures without swallowing them", async () => {
		const error = new Error("auth read failed");
		mocks.loadImportedOpenAICodexAuth.mockRejectedValue(error);
		let reportChange: (() => void) | undefined;
		mocks.watchImportedOpenAICodexAuth.mockImplementation((handler) => {
			reportChange = handler;
			return () => undefined;
		});
		const onError = vi.fn();

		const manager = new AccountManager();
		manager.startPiAuthWatch({ onError });
		reportChange?.();

		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
		manager.stopPiAuthWatch();
	});

	it("does not report stale watcher sync failures", async () => {
		const error = new Error("stale auth read failed");
		mocks.loadImportedOpenAICodexAuth.mockRejectedValue(error);
		let reportChange: (() => void) | undefined;
		mocks.watchImportedOpenAICodexAuth.mockImplementation((handler) => {
			reportChange = handler;
			return () => undefined;
		});
		let current = true;
		const onError = vi.fn();

		const manager = new AccountManager();
		manager.startPiAuthWatch({
			onError,
			shouldApply: () => current,
		});
		reportChange?.();
		current = false;

		await vi.waitFor(() => {
			expect(mocks.loadImportedOpenAICodexAuth).toHaveBeenCalledTimes(1);
		});
		expect(onError).not.toHaveBeenCalled();
		manager.stopPiAuthWatch();
	});

	it("leaves managed accounts untouched when auth.json has no codex entry", async () => {
		mocks.storageData.accounts = [
			{
				email: "managed@example.com",
				accessToken: "managed-access",
				refreshToken: "managed-refresh",
				expiresAt: Date.now() + 3600_000,
			},
		];
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);

		const manager = new AccountManager();
		await manager.loadPiAuth();

		expect(manager.getAccounts()).toHaveLength(1);
		expect(manager.getAccount("managed@example.com")).toBeDefined();
		expect(mocks.saveStorage).not.toHaveBeenCalled();
	});

	it("does not import pi auth when startup becomes stale before apply", async () => {
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "fp",
			credentials: {
				access: "pi-access",
				refresh: "pi-refresh",
				expires: Date.now() + 3600_000,
			},
		});

		const manager = new AccountManager();
		await manager.loadPiAuth({ shouldApply: () => false });

		expect(manager.getAccounts()).toHaveLength(0);
		expect(mocks.saveStorage).not.toHaveBeenCalled();
	});
});

describe("AccountManager account deduplication", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storageData.accounts = [];
		mocks.storageData.activeEmail = undefined;
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
	});

	it("creates separate accounts for different emails even with same refresh token", () => {
		mocks.storageData.accounts = [
			{
				email: "old@example.com",
				accessToken: "old-access",
				refreshToken: "shared-refresh",
				expiresAt: 100,
				accountId: "acc-123",
			},
		];

		const manager = new AccountManager();
		const account = manager.addOrUpdateAccount("new@example.com", {
			access: "new-access",
			refresh: "shared-refresh",
			expires: 300,
			accountId: "acc-123",
		});

		expect(account.email).toBe("new@example.com");
		expect(manager.getAccounts()).toHaveLength(2);
		expect(manager.getAccount("old@example.com")).toBeDefined();
		expect(manager.getAccount("new@example.com")).toMatchObject({
			accessToken: "new-access",
			expiresAt: 300,
		});
	});

	it("updates existing account when same email is added again", () => {
		mocks.storageData.accounts = [
			{
				email: "user@example.com",
				accessToken: "old-access",
				refreshToken: "old-refresh",
				expiresAt: 100,
			},
		];

		const manager = new AccountManager();
		const account = manager.addOrUpdateAccount("user@example.com", {
			access: "new-access",
			refresh: "new-refresh",
			expires: 200,
		});

		expect(manager.getAccounts()).toHaveLength(1);
		expect(account.accessToken).toBe("new-access");
		expect(account.refreshToken).toBe("new-refresh");
	});
});

describe("AccountManager auth-failure warnings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storageData.accounts = [];
		mocks.storageData.activeEmail = undefined;
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
	});

	it("warns once per session for a skipped auth-broken account and resets on reauth", () => {
		const manager = new AccountManager();
		const warningHandler = vi.fn();
		manager.setWarningHandler(warningHandler);
		const account = manager.addOrUpdateAccount("warn@example.com", {
			access: "access",
			refresh: "refresh",
			expires: 100,
		});
		account.needsReauth = true;

		manager.notifyRotationSkipForAuthFailure(
			account,
			new Error("refresh failed"),
		);
		manager.notifyRotationSkipForAuthFailure(
			account,
			new Error("refresh failed"),
		);
		expect(warningHandler).toHaveBeenCalledTimes(1);
		expect(warningHandler.mock.calls[0]?.[0]).toContain("warn@example.com");
		expect(warningHandler.mock.calls[0]?.[0]).toContain(
			"/multicodex reauth warn@example.com",
		);

		manager.addOrUpdateAccount("warn@example.com", {
			access: "new-access",
			refresh: "refresh",
			expires: 200,
		});
		manager.notifyRotationSkipForAuthFailure(
			account,
			new Error("refresh failed again"),
		);
		expect(warningHandler).toHaveBeenCalledTimes(2);

		manager.resetSessionWarnings();
		manager.notifyRotationSkipForAuthFailure(
			account,
			new Error("refresh failed third"),
		);
		expect(warningHandler).toHaveBeenCalledTimes(3);
	});

	it("uses the normal multicodex reauth hint for imported pi auth", async () => {
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "fp",
			credentials: {
				access: "pi-access",
				refresh: "pi-refresh",
				expires: Date.now() + 3600_000,
			},
		});

		const manager = new AccountManager();
		await manager.loadPiAuth();
		const warningHandler = vi.fn();
		manager.setWarningHandler(warningHandler);

		const piAccount = manager.getAccount("pi@example.com");
		expect(piAccount).toBeDefined();
		if (!piAccount) return;
		piAccount.needsReauth = true;
		manager.notifyRotationSkipForAuthFailure(piAccount, new Error("expired"));

		expect(warningHandler).toHaveBeenCalledTimes(1);
		expect(warningHandler.mock.calls[0]?.[0]).toContain(
			"/multicodex reauth pi@example.com",
		);
	});
});

describe("AccountManager imported pi auth exhaustion handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storageData.accounts = [];
		mocks.storageData.activeEmail = undefined;
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
	});

	it("persists quota exhaustion on imported pi auth account", async () => {
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "fp",
			credentials: {
				access: "pi-access",
				refresh: "pi-refresh",
				expires: Date.now() + 3600_000,
			},
		});

		const manager = new AccountManager();
		await manager.loadPiAuth();

		const piAccount = manager.getAccount("pi@example.com");
		expect(piAccount).toBeDefined();
		if (!piAccount) return;

		mocks.saveStorage.mockClear();
		manager.markExhausted("pi@example.com", Date.now() + 1000);
		expect(piAccount.quotaExhaustedUntil).toBeGreaterThan(0);
		expect(mocks.saveStorage).toHaveBeenCalled();
	});

	it("clearAllQuotaExhaustion clears imported pi auth like other accounts", async () => {
		mocks.storageData.accounts = [
			{
				email: "managed@example.com",
				accessToken: "managed-access",
				refreshToken: "managed-refresh",
				expiresAt: Date.now() + 3600_000,
				quotaExhaustedUntil: Date.now() + 60_000,
			},
		];
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue({
			identifier: "pi@example.com",
			fingerprint: "fp",
			credentials: {
				access: "pi-access",
				refresh: "pi-refresh",
				expires: Date.now() + 3600_000,
			},
		});

		const manager = new AccountManager();
		await manager.loadPiAuth();

		manager.markExhausted("pi@example.com", Date.now() + 60_000);

		const cleared = manager.clearAllQuotaExhaustion();
		expect(cleared).toBe(2);

		// Both accounts should be clear
		const piAccount = manager.getAccount("pi@example.com");
		const managedAccount = manager.getAccount("managed@example.com");
		expect(piAccount?.quotaExhaustedUntil).toBeUndefined();
		expect(managedAccount?.quotaExhaustedUntil).toBeUndefined();
	});
});

describe("AccountManager quota cooldown reconciliation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storageData.accounts = [
			{
				email: "cooldown@example.com",
				accessToken: "access-token",
				refreshToken: "refresh-token",
				expiresAt: Date.now() + 3600_000,
				quotaExhaustedUntil: Date.now() + 3600_000,
			},
		];
		mocks.storageData.activeEmail = "cooldown@example.com";
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
	});

	it("clears quota cooldown immediately when its reset time elapsed", async () => {
		mocks.storageData.accounts[0] = {
			...mocks.storageData.accounts[0],
			quotaExhaustedUntil: Date.now() - 1000,
		};

		const manager = new AccountManager();
		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(1);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBeUndefined();
		expect(mocks.fetchCodexUsage).not.toHaveBeenCalled();
		expect(mocks.saveStorage).toHaveBeenCalledTimes(1);
	});

	it("clears a stale quota cooldown when fresh usage is strongly healthy", async () => {
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: {
				usedPercent: 0,
				allowed: true,
				limitReached: false,
				resetAt: Date.now() + 3600_000,
			},
			secondary: {
				usedPercent: 0,
				allowed: true,
				limitReached: false,
				resetAt: Date.now() + 7 * 24 * 3600_000,
			},
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(1);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBeUndefined();
		expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(1);
		expect(mocks.saveStorage).toHaveBeenCalledTimes(1);
	});

	it("keeps quota cooldown when the known 5h window is exhausted", async () => {
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: { usedPercent: 100, allowed: false, limitReached: true },
			secondary: { usedPercent: 12, allowed: true, limitReached: false },
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const account = manager.getAccount("cooldown@example.com");
		if (!account) throw new Error("account missing");

		await manager.refreshUsageForAccount(account, { force: true });

		expect(account.quotaExhaustedUntil).toBe(originalCooldown);
		expect(mocks.saveStorage).not.toHaveBeenCalled();
	});

	it("uses the known 5h window before an exhausted weekly window", async () => {
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: { usedPercent: 99, allowed: true, limitReached: false },
			secondary: { usedPercent: 100, allowed: false, limitReached: true },
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const account = manager.getAccount("cooldown@example.com");
		if (!account) throw new Error("account missing");

		await manager.refreshUsageForAccount(account, { force: true });

		expect(account.quotaExhaustedUntil).toBeUndefined();
	});

	it("selects an account immediately when fresh usage proves its cooldown stale", async () => {
		mocks.fetchCodexUsage.mockResolvedValue({
			secondary: { usedPercent: 0, allowed: true, limitReached: false },
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const selected = await manager.activateBestAccount();

		expect(selected?.email).toBe("cooldown@example.com");
		expect(selected?.quotaExhaustedUntil).toBeUndefined();
	});

	it("keeps quota cooldown when healthy-looking usage is only locally available", async () => {
		const sharedCoordination = createInMemoryUsageCoordination();
		vi.spyOn(sharedCoordination, "refresh").mockResolvedValue({
			availability: "locally-available",
			source: "local-fallback",
			snapshot: {
				primary: { usedPercent: 0, allowed: true, limitReached: false },
				secondary: { usedPercent: 0, allowed: true, limitReached: false },
				fetchedAt: Date.now(),
			},
		});
		resetUsageCoordinatorForTests(sharedCoordination);
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
		const manager = new AccountManager();

		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(0);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBe(originalCooldown);
	});

	it.each([
		[
			"primary",
			{ primary: { usedPercent: 0, allowed: true, limitReached: false } },
		],
		[
			"secondary",
			{ secondary: { usedPercent: 0, allowed: true, limitReached: false } },
		],
	])("clears quota cooldown when only the %s window reports remaining usage", async (_windowName, partialUsage) => {
		mocks.fetchCodexUsage.mockResolvedValue({
			...partialUsage,
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(1);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBeUndefined();
		expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(1);
		expect(mocks.saveStorage).toHaveBeenCalledTimes(1);
	});

	it("keeps quota cooldown when fresh usage has no remaining quota", async () => {
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: { usedPercent: 100, allowed: false, limitReached: true },
			secondary: { usedPercent: 100, allowed: false, limitReached: true },
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(0);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBe(originalCooldown);
		expect(mocks.saveStorage).not.toHaveBeenCalled();
	});

	it("keeps quota cooldown when the effective usage percentage is invalid", async () => {
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: { usedPercent: -1, allowed: true, limitReached: false },
			secondary: { usedPercent: 10, allowed: true, limitReached: false },
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(0);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBe(originalCooldown);
		expect(mocks.saveStorage).not.toHaveBeenCalled();
	});

	it("clears quota cooldown when fresh usage has any remaining quota near the limit boundary", async () => {
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: {
				usedPercent: 99.6,
				allowed: true,
				limitReached: false,
				resetAt: Date.now() + 3600_000,
			},
			secondary: {
				usedPercent: 10,
				allowed: true,
				limitReached: false,
				resetAt: Date.now() + 7 * 24 * 3600_000,
			},
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(1);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBeUndefined();
		expect(mocks.saveStorage).toHaveBeenCalledTimes(1);
	});

	it("does not clear cooldown from a previously fresh snapshot after forced refresh failure", async () => {
		const healthySnapshot = {
			primary: { usedPercent: 0, allowed: true, limitReached: false },
			secondary: { usedPercent: 0, allowed: true, limitReached: false },
			fetchedAt: Date.now(),
		};
		mocks.fetchCodexUsage
			.mockResolvedValueOnce(healthySnapshot)
			.mockRejectedValueOnce(new Error("usage unavailable"));
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
		const manager = new AccountManager();
		const account = manager.getAccount("cooldown@example.com");
		if (!account) throw new Error("account missing");
		await manager.refreshUsageForAccount(account);
		manager.markExhausted(account.email, originalCooldown);

		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(0);
		expect(account.quotaExhaustedUntil).toBe(originalCooldown);
	});

	it("does not clear cooldown when a joined forced refresh fails authentication", async () => {
		mocks.fetchCodexUsage.mockReset();
		mocks.fetchCodexUsage.mockResolvedValueOnce({
			primary: { usedPercent: 10, allowed: true, limitReached: false },
			fetchedAt: Date.now(),
		});
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
		const manager = new AccountManager();
		const account = manager.getAccount("cooldown@example.com");
		if (!account) throw new Error("account missing");
		await manager.refreshUsageForAccount(account, { force: true });
		manager.markExhausted(account.email, originalCooldown);

		let rejectRefresh!: (error: unknown) => void;
		mocks.fetchCodexUsage.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectRefresh = reject;
				}),
		);
		const owner = manager.refreshUsageForAccount(account, { force: true });
		const joiner = manager.refreshUsageForAccount(account, { force: true });
		await vi.waitFor(() =>
			expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(2),
		);
		rejectRefresh(new UsageAuthenticationError("expired"));

		const results = await Promise.all([owner, joiner]);
		const joinedResult = results.find(
			(result) => result.source === "joined-work",
		);
		expect(joinedResult?.error).toBeInstanceOf(UsageAuthenticationError);
		expect(account.quotaExhaustedUntil).toBe(originalCooldown);
	});

	it("keeps quota cooldown when usage refresh fails", async () => {
		const warningHandler = vi.fn();
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
		mocks.fetchCodexUsage.mockRejectedValue(new Error("usage unavailable"));

		const manager = new AccountManager();
		const cleared = await manager.reconcileQuotaCooldowns({ warningHandler });

		expect(cleared).toBe(0);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBe(originalCooldown);
		expect(warningHandler).toHaveBeenCalledTimes(1);
		expect(mocks.saveStorage).not.toHaveBeenCalled();
	});
});

describe("AccountManager activation freshness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storageData.accounts = [
			{
				email: "old@example.com",
				accessToken: "old-access",
				refreshToken: "old-refresh",
				expiresAt: Date.now() + 3600_000,
			},
			{
				email: "new@example.com",
				accessToken: "new-access",
				refreshToken: "new-refresh",
				expiresAt: Date.now() + 3600_000,
			},
		];
		mocks.storageData.activeEmail = "old@example.com";
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
	});

	it("does not set active account when startup becomes stale during usage refresh", async () => {
		let current = true;
		mocks.fetchCodexUsage.mockImplementation(async () => {
			current = false;
			return { fetchedAt: Date.now() };
		});

		const manager = new AccountManager();
		const selected = await manager.activateBestAccount({
			shouldApply: () => current,
		});

		expect(selected).toBeUndefined();
		expect(manager.getActiveAccount()?.email).toBe("old@example.com");
	});
});

describe("AccountManager ready-gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storageData.accounts = [];
		mocks.storageData.activeEmail = undefined;
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
	});

	it("resolves immediately when no initialization is in progress", async () => {
		const manager = new AccountManager();
		await manager.waitUntilReady();
	});

	it("blocks until markReady is called", async () => {
		const manager = new AccountManager();
		manager.beginInitialization();

		let resolved = false;
		const waiting = manager.waitUntilReady().then(() => {
			resolved = true;
		});

		// Should not resolve yet
		await Promise.resolve();
		expect(resolved).toBe(false);

		manager.markReady();
		await waiting;
		expect(resolved).toBe(true);
	});

	it("resolves after markReady even if beginInitialization is called again", async () => {
		const manager = new AccountManager();
		manager.beginInitialization();
		manager.markReady();

		// Second initialization cycle
		manager.beginInitialization();

		let resolved = false;
		const waiting = manager.waitUntilReady().then(() => {
			resolved = true;
		});

		await Promise.resolve();
		expect(resolved).toBe(false);

		manager.markReady();
		await waiting;
		expect(resolved).toBe(true);
	});

	it("keeps the ready gate pending until the latest overlapping initialization finishes", async () => {
		const manager = new AccountManager();
		const first = manager.beginInitialization();
		let resolved = false;
		const waiting = manager.waitUntilReady().then(() => {
			resolved = true;
		});
		const second = manager.beginInitialization();

		manager.markReady(first);
		await Promise.resolve();
		expect(resolved).toBe(false);

		manager.markReady(second);
		await waiting;
		expect(resolved).toBe(true);
	});
});

describe("AccountManager usage coordinator facade", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storageData.accounts = [];
		mocks.storageData.activeEmail = undefined;
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
	});

	it("shares snapshots and refresh eligibility across manager instances", async () => {
		mocks.storageData.accounts = [
			{
				email: "first@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: Date.now() + 3_600_000,
				accountId: "account-1",
			},
		];
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: { usedPercent: 12 },
			fetchedAt: Date.now(),
		});

		const first = new AccountManager();
		const second = new AccountManager();
		const firstAccount = first.getAccount("first@example.com");
		const secondAccount = second.getAccount("first@example.com");
		if (!firstAccount || !secondAccount) throw new Error("account missing");

		await first.refreshUsageForAccount(firstAccount);
		expect(
			second.getCachedUsage("first@example.com")?.primary?.usedPercent,
		).toBe(12);
		await second.refreshUsageForAccount(secondAccount);
		expect(mocks.fetchCodexUsage).toHaveBeenCalledOnce();
	});

	it("keeps different normalized emails isolated even when account ids match", async () => {
		mocks.storageData.accounts = [
			{
				email: "first@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: Date.now() + 3_600_000,
				accountId: "account-1",
			},
		];
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: { usedPercent: 7 },
			fetchedAt: Date.now(),
		});
		const first = new AccountManager();
		const firstAccount = first.getAccount("first@example.com");
		if (!firstAccount) throw new Error("account missing");
		await first.refreshUsageForAccount(firstAccount);

		mocks.storageData.accounts = [
			{
				email: "second@example.com",
				accessToken: "access-2",
				refreshToken: "refresh-2",
				expiresAt: Date.now() + 3_600_000,
				accountId: "account-1",
			},
		];
		const second = new AccountManager();
		expect(
			second.getCachedUsage("second@example.com")?.primary?.usedPercent,
		).toBeUndefined();
		const secondAccount = second.getAccount("second@example.com");
		if (!secondAccount) throw new Error("account missing");
		await second.refreshUsageForAccount(secondAccount);
		expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(2);
	});

	it("does not suppress retry after usage endpoint authentication failure", async () => {
		mocks.storageData.accounts = [
			{
				email: "auth-usage@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		];
		mocks.fetchCodexUsage
			.mockRejectedValueOnce(new UsageAuthenticationError("unauthorized"))
			.mockResolvedValueOnce({ fetchedAt: Date.now() });
		const manager = new AccountManager();
		const account = manager.getAccount("auth-usage@example.com");
		if (!account) throw new Error("account missing");

		await manager.refreshUsageForAccount(account);
		await manager.refreshUsageForAccount(account);

		expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(2);
	});

	it("records consumption through active observer without warning on monitor failure", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		mocks.storageData.accounts = [
			{
				email: "consume@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: 3_600_000,
			},
		];
		mocks.fetchCodexUsage
			.mockResolvedValueOnce({ fetchedAt: 1_000 })
			.mockRejectedValueOnce(new Error("monitor unavailable"));
		const manager = new AccountManager();
		const account = manager.getAccount("consume@example.com");
		if (!account) throw new Error("account missing");
		const warningHandler = vi.fn();
		manager.setWarningHandler(warningHandler);
		await manager.refreshUsageForAccount(account);
		const unsubscribe = manager.subscribeUsageObserver();
		manager.recordUsageConsumption(account);
		expect(mocks.fetchCodexUsage).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(30_000);
		await vi.runOnlyPendingTimersAsync();
		expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(2);
		expect(warningHandler).not.toHaveBeenCalled();
		unsubscribe();
		vi.useRealTimers();
	});
	it("binds usage notifications to observer lifecycle without manager state notifications", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		mocks.storageData.accounts = [
			{
				email: "observer@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: 3_600_000,
			},
		];
		mocks.fetchCodexUsage
			.mockResolvedValueOnce({ primary: { usedPercent: 10 }, fetchedAt: 1_000 })
			.mockResolvedValueOnce({ primary: { usedPercent: 20 }, fetchedAt: 2_000 })
			.mockResolvedValueOnce({
				primary: { usedPercent: 30 },
				fetchedAt: 3_000,
			});
		const manager = new AccountManager();
		const account = manager.getAccount("observer@example.com");
		if (!account) throw new Error("account missing");
		const stateHandler = vi.fn();
		manager.onStateChange(stateHandler);
		const usageHandler = vi.fn();
		const unsubscribe = manager.subscribeUsageObserver(usageHandler);

		await manager.refreshUsageForAccount(account);
		expect(usageHandler).toHaveBeenCalledOnce();
		expect(stateHandler).not.toHaveBeenCalled();

		unsubscribe();
		manager.recordUsageConsumption(account);
		await manager.refreshUsageForAccount(account, { force: true });
		expect(usageHandler).toHaveBeenCalledOnce();
		expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(2);
		expect(stateHandler).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("forgets local usage while preserving shared continuity after re-addition", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const sharedCoordination = createInMemoryUsageCoordination();
		resetUsageCoordinatorForTests(sharedCoordination);
		mocks.fetchCodexUsage.mockReset();
		mocks.storageData.accounts = [
			{
				email: "readd@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: 3_600_000,
				accountId: "account-readd",
			},
		];
		mocks.fetchCodexUsage
			.mockResolvedValueOnce({ primary: { usedPercent: 10 }, fetchedAt: 1_000 })
			.mockResolvedValueOnce({
				primary: { usedPercent: 20 },
				fetchedAt: 1_000,
			});
		const manager = new AccountManager();
		const account = manager.getAccount("readd@example.com");
		if (!account) throw new Error("account missing");
		const observer = manager.subscribeUsageObserver();

		await manager.refreshUsageForAccount(account);
		manager.recordUsageConsumption(account);
		await vi.waitFor(async () => {
			expect(
				(await sharedCoordination.read(account.email)).pendingInvalidation,
			).toBeDefined();
		});
		expect(manager.removeAccount(account.email)).toBe(true);
		manager.getAccounts().push({ ...account });

		const readded = manager.getAccount(account.email);
		if (!readded) throw new Error("re-added account missing");
		expect(manager.getCachedUsage(readded.email)).toBeUndefined();
		expect(
			(await sharedCoordination.read(readded.email)).snapshot?.primary
				?.usedPercent,
		).toBe(10);
		const readdedResult = await manager.refreshUsageForAccount(readded);
		expect(readdedResult.source).toBe("existing-fresh");
		expect(manager.getCachedUsage(readded.email)?.primary?.usedPercent).toBe(
			10,
		);
		expect(mocks.fetchCodexUsage).toHaveBeenCalledOnce();

		vi.advanceTimersByTime(USAGE_FRESHNESS_INTERVAL_MS);
		await vi.runOnlyPendingTimersAsync();
		expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(2);
		observer();
		vi.useRealTimers();
	});

	it("does not let an in-flight refresh repopulate a removed account", async () => {
		mocks.fetchCodexUsage.mockReset();
		let release!: (value: { fetchedAt: number }) => void;
		mocks.storageData.accounts = [
			{
				email: "inflight-remove@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: Date.now() + 3_600_000,
				accountId: "account-inflight-remove",
			},
		];
		mocks.fetchCodexUsage.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const manager = new AccountManager();
		const account = manager.getAccount("inflight-remove@example.com");
		if (!account) throw new Error("account missing");
		const refresh = manager.refreshUsageForAccount(account);
		await vi.waitFor(() =>
			expect(mocks.fetchCodexUsage).toHaveBeenCalledOnce(),
		);

		expect(manager.removeAccount(account.email)).toBe(true);
		manager.getAccounts().push({ ...account });
		release({ fetchedAt: Date.now() });
		await refresh;

		expect(manager.getCachedUsage(account.email)).toBeUndefined();
	});

	it("keeps normalized-email freshness when token validation adds account metadata", async () => {
		mocks.storageData.accounts = [
			{
				email: "mutating@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		];
		mocks.fetchCodexUsage.mockResolvedValue({
			primary: { usedPercent: 18 },
			fetchedAt: Date.now(),
		});
		const manager = new AccountManager();
		const account = manager.getAccount("mutating@example.com");
		if (!account) throw new Error("account missing");
		const ensureValidToken = vi
			.spyOn(manager, "ensureValidToken")
			.mockImplementation(async (current) => {
				current.accountId = "account-mutated";
				return "token";
			});

		await manager.refreshUsageForAccount(account);
		expect(
			manager.getCachedUsage("mutating@example.com")?.primary?.usedPercent,
		).toBe(18);
		await manager.refreshUsageForAccount(account);

		expect(mocks.fetchCodexUsage).toHaveBeenCalledOnce();
		ensureValidToken.mockRestore();
	});

	it("records headless consumption without starting a usage request", async () => {
		mocks.storageData.accounts = [
			{
				email: "headless@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		];
		const manager = new AccountManager();
		const account = manager.getAccount("headless@example.com");
		if (!account) throw new Error("account missing");

		manager.recordUsageConsumption(account);

		expect(mocks.fetchCodexUsage).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(mocks.fetchCodexUsage).not.toHaveBeenCalled();
	});

	it("returns normalized-email-keyed typed outcomes for all-account refresh", async () => {
		mocks.storageData.accounts = [
			{
				email: " First@Example.com ",
				accessToken: "access-1",
				refreshToken: "refresh-1",
				expiresAt: Date.now() + 3_600_000,
			},
			{
				email: "second@example.com",
				accessToken: "access-2",
				refreshToken: "refresh-2",
				expiresAt: Date.now() + 3_600_000,
			},
		];
		mocks.fetchCodexUsage.mockResolvedValue({ fetchedAt: Date.now() });
		const manager = new AccountManager();

		const results = await manager.refreshUsageForAllAccounts();

		expect(Object.keys(results).sort()).toEqual([
			"first@example.com",
			"second@example.com",
		]);
		expect(results["first@example.com"]).toMatchObject({
			availability: "fresh",
			source: "owned-fetch",
		});
	});

	it("ignores late consumption from an account object no longer managed", () => {
		mocks.storageData.accounts = [
			{
				email: "late-stream@example.com",
				accessToken: "access",
				refreshToken: "refresh",
				expiresAt: Date.now() + 3_600_000,
			},
		];
		const manager = new AccountManager();
		const account = manager.getAccount("late-stream@example.com");
		if (!account) throw new Error("account missing");
		const observer = manager.subscribeUsageObserver();

		expect(manager.removeAccount(account.email)).toBe(true);
		manager.getAccounts().push({ ...account });
		manager.recordUsageConsumption(account);

		expect(mocks.fetchCodexUsage).not.toHaveBeenCalled();
		expect(manager.getCachedUsage(account.email)).toBeUndefined();
		observer();
	});
});
