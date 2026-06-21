import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storageData: {
		accounts: [] as Array<Record<string, unknown>>,
		activeEmail: undefined as string | undefined,
	},
	loadImportedOpenAICodexAuth: vi.fn(),
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
}));

vi.mock("@earendil-works/pi-ai/oauth", () => ({
	refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("./usage-client", () => ({
	fetchCodexUsage: mocks.fetchCodexUsage,
}));

import { AccountManager } from "./account-manager";

describe("AccountManager pi auth import", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.storageData.accounts = [];
		mocks.storageData.activeEmail = undefined;
		mocks.loadImportedOpenAICodexAuth.mockResolvedValue(undefined);
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

	it.each([
		[
			"primary",
			{ primary: { usedPercent: 0, allowed: true, limitReached: false } },
		],
		[
			"secondary",
			{ secondary: { usedPercent: 0, allowed: true, limitReached: false } },
		],
	])("keeps quota cooldown when fresh usage is missing the %s window", async (_windowName, partialUsage) => {
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
		mocks.fetchCodexUsage.mockResolvedValue({
			...partialUsage,
			fetchedAt: Date.now(),
		});

		const manager = new AccountManager();
		const cleared = await manager.reconcileQuotaCooldowns();

		expect(cleared).toBe(0);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBe(originalCooldown);
		expect(mocks.fetchCodexUsage).toHaveBeenCalledTimes(1);
		expect(mocks.saveStorage).not.toHaveBeenCalled();
	});

	it("keeps quota cooldown when fresh usage remains near the limit boundary", async () => {
		const originalCooldown = mocks.storageData.accounts[0]
			?.quotaExhaustedUntil as number;
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

		expect(cleared).toBe(0);
		expect(
			manager.getAccount("cooldown@example.com")?.quotaExhaustedUntil,
		).toBe(originalCooldown);
		expect(mocks.saveStorage).not.toHaveBeenCalled();
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
