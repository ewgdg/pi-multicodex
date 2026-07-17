import { describe, expect, it, vi } from "vitest";
import { handleNewSessionSwitch, handleSessionStart } from "./hooks";

describe("handleSessionStart", () => {
	it("loads pi auth and activates even when no managed accounts exist", async () => {
		const loadPiAuth = vi.fn().mockResolvedValue(undefined);
		const refreshUsageForAllAccounts = vi.fn().mockResolvedValue(undefined);
		const getAvailableManualAccount = vi.fn().mockReturnValue(undefined);
		const hasManualAccount = vi.fn().mockReturnValue(false);
		const clearManualAccount = vi.fn();
		const activateBestAccount = vi.fn().mockResolvedValue(undefined);
		const beginInitialization = vi.fn();
		const markReady = vi.fn();
		let piAuthLoaded = false;
		loadPiAuth.mockImplementation(async () => {
			piAuthLoaded = true;
		});

		handleSessionStart({
			getAccounts: () => (piAuthLoaded ? [{ email: "pi@example.com" }] : []),
			loadPiAuth,
			refreshUsageForAllAccounts,
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount,
			hasManualAccount,
			clearManualAccount,
			activateBestAccount,
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(beginInitialization).toHaveBeenCalled();
			expect(loadPiAuth).toHaveBeenCalled();
			expect(refreshUsageForAllAccounts).toHaveBeenCalledWith(undefined);
			expect(getAvailableManualAccount).toHaveBeenCalled();
			expect(hasManualAccount).toHaveBeenCalled();
			expect(clearManualAccount).not.toHaveBeenCalled();
			expect(activateBestAccount).toHaveBeenCalled();
			expect(markReady).toHaveBeenCalled();
		});
	});

	it("refreshes and activates when accounts exist and no manual account is available", async () => {
		const loadPiAuth = vi.fn().mockResolvedValue(undefined);
		const refreshUsageForAllAccounts = vi.fn().mockResolvedValue(undefined);
		const getAvailableManualAccount = vi.fn().mockReturnValue(undefined);
		const hasManualAccount = vi.fn().mockReturnValue(false);
		const clearManualAccount = vi.fn();
		const activateBestAccount = vi.fn().mockResolvedValue(undefined);
		const beginInitialization = vi.fn();
		const markReady = vi.fn();

		handleSessionStart({
			getAccounts: () => [{ email: "a@example.com" }],
			loadPiAuth,
			refreshUsageForAllAccounts,
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount,
			hasManualAccount,
			clearManualAccount,
			activateBestAccount,
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(beginInitialization).toHaveBeenCalled();
			expect(loadPiAuth).toHaveBeenCalled();
			expect(refreshUsageForAllAccounts).toHaveBeenCalledWith(undefined);
			expect(getAvailableManualAccount).toHaveBeenCalled();
			expect(hasManualAccount).toHaveBeenCalled();
			expect(clearManualAccount).not.toHaveBeenCalled();
			expect(activateBestAccount).toHaveBeenCalled();
			expect(markReady).toHaveBeenCalled();
		});
	});

	it("passes cache affinity context for existing conversations", async () => {
		const loadPiAuth = vi.fn().mockResolvedValue(undefined);
		const refreshUsageForAllAccounts = vi.fn().mockResolvedValue(undefined);
		const activateBestAccount = vi.fn().mockResolvedValue(undefined);
		const now = Date.now();
		const ctx = {
			getContextUsage: () => ({ tokens: 256_000 }),
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						timestamp: new Date(now - 60_000).toISOString(),
						message: {
							role: "assistant",
							provider: "openai-codex",
							timestamp: now - 60_000,
							usage: { input: 128_000 },
						},
					},
				],
			},
		};

		handleSessionStart(
			{
				getAccounts: () => [{ email: "a@example.com" }],
				loadPiAuth,
				refreshUsageForAllAccounts,
				getAccountsNeedingReauth: () => [],
				getAvailableManualAccount: vi.fn().mockReturnValue(undefined),
				hasManualAccount: vi.fn().mockReturnValue(false),
				clearManualAccount: vi.fn(),
				activateBestAccount,
				beginInitialization: vi.fn(),
				markReady: vi.fn(),
			} as never,
			undefined,
			{ ctx: ctx as never, reason: "resume" },
		);

		await vi.waitFor(() => {
			expect(activateBestAccount).toHaveBeenCalledWith(
				expect.objectContaining({
					cacheAffinity: {
						ageMs: expect.any(Number),
						contextTokens: 256_000,
					},
				}),
			);
		});
	});

	it("skips malformed Codex assistant timestamps when building cache affinity", async () => {
		const activateBestAccount = vi.fn().mockResolvedValue(undefined);
		const now = Date.now();
		const ctx = {
			getContextUsage: () => undefined,
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						timestamp: new Date(now - 120_000).toISOString(),
						message: {
							role: "assistant",
							provider: "openai-codex",
							timestamp: now - 120_000,
							usage: { input: 64_000 },
						},
					},
					{
						type: "message",
						timestamp: "not-a-date",
						message: {
							role: "assistant",
							provider: "openai-codex",
							timestamp: Number.NaN,
							usage: { input: 256_000 },
						},
					},
				],
			},
		};

		handleSessionStart(
			{
				getAccounts: () => [{ email: "a@example.com" }],
				loadPiAuth: vi.fn().mockResolvedValue(undefined),
				refreshUsageForAllAccounts: vi.fn().mockResolvedValue(undefined),
				getAccountsNeedingReauth: () => [],
				getAvailableManualAccount: vi.fn().mockReturnValue(undefined),
				hasManualAccount: vi.fn().mockReturnValue(false),
				clearManualAccount: vi.fn(),
				activateBestAccount,
				beginInitialization: vi.fn(),
				markReady: vi.fn(),
			} as never,
			undefined,
			{ ctx: ctx as never, reason: "reload" },
		);

		await vi.waitFor(() => {
			expect(activateBestAccount).toHaveBeenCalledWith(
				expect.objectContaining({
					cacheAffinity: {
						ageMs: expect.any(Number),
						contextTokens: 64_000,
					},
				}),
			);
		});
	});

	it("does not pass cache affinity for a new conversation", async () => {
		const activateBestAccount = vi.fn().mockResolvedValue(undefined);
		const ctx = {
			getContextUsage: () => ({ tokens: 256_000 }),
			sessionManager: { getBranch: () => [] },
		};

		handleNewSessionSwitch(
			{
				getAccounts: () => [{ email: "a@example.com" }],
				loadPiAuth: vi.fn().mockResolvedValue(undefined),
				refreshUsageForAllAccounts: vi.fn().mockResolvedValue(undefined),
				getAccountsNeedingReauth: () => [],
				getAvailableManualAccount: vi.fn().mockReturnValue(undefined),
				hasManualAccount: vi.fn().mockReturnValue(false),
				clearManualAccount: vi.fn(),
				activateBestAccount,
				beginInitialization: vi.fn(),
				markReady: vi.fn(),
			} as never,
			undefined,
			{ ctx: ctx as never, reason: "new" },
		);

		await vi.waitFor(() => {
			expect(activateBestAccount).toHaveBeenCalledWith(
				expect.objectContaining({
					cacheAffinity: undefined,
				}),
			);
		});
	});

	it("does not mutate active account when startup becomes stale before activation", async () => {
		let current = true;
		const refreshUsageForAllAccounts = vi.fn().mockImplementation(async () => {
			current = false;
		});
		const clearManualAccount = vi.fn();
		const activateBestAccount = vi.fn().mockResolvedValue(undefined);

		await handleSessionStart(
			{
				getAccounts: () => [{ email: "a@example.com" }],
				loadPiAuth: vi.fn().mockResolvedValue(undefined),
				refreshUsageForAllAccounts,
				getAccountsNeedingReauth: () => [],
				getAvailableManualAccount: vi.fn().mockReturnValue(undefined),
				hasManualAccount: vi.fn().mockReturnValue(true),
				clearManualAccount,
				activateBestAccount,
				beginInitialization: vi.fn(() => Symbol("init")),
				markReady: vi.fn(),
			} as never,
			undefined,
			{
				ctx: { sessionManager: { getBranch: () => [] } } as never,
				reason: "resume",
				isCurrent: () => current,
			},
		);

		expect(clearManualAccount).not.toHaveBeenCalled();
		expect(activateBestAccount).not.toHaveBeenCalled();
	});

	it("keeps the manual account when one is available", async () => {
		const loadPiAuth = vi.fn().mockResolvedValue(undefined);
		const refreshUsageForAllAccounts = vi.fn().mockResolvedValue(undefined);
		const getAvailableManualAccount = vi
			.fn()
			.mockReturnValue({ email: "manual@example.com" });
		const hasManualAccount = vi.fn();
		const clearManualAccount = vi.fn();
		const activateBestAccount = vi.fn();
		const beginInitialization = vi.fn();
		const markReady = vi.fn();

		handleSessionStart({
			getAccounts: () => [{ email: "manual@example.com" }],
			loadPiAuth,
			refreshUsageForAllAccounts,
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount,
			hasManualAccount,
			clearManualAccount,
			activateBestAccount,
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(beginInitialization).toHaveBeenCalled();
			expect(loadPiAuth).toHaveBeenCalled();
			expect(refreshUsageForAllAccounts).toHaveBeenCalledWith(undefined);
			expect(getAvailableManualAccount).toHaveBeenCalled();
			expect(hasManualAccount).not.toHaveBeenCalled();
			expect(clearManualAccount).not.toHaveBeenCalled();
			expect(activateBestAccount).not.toHaveBeenCalled();
			expect(markReady).toHaveBeenCalled();
		});
	});
});

describe("handleNewSessionSwitch", () => {
	it("refreshes and clears stale manual state before activating the best account", async () => {
		const loadPiAuth = vi.fn().mockResolvedValue(undefined);
		const refreshUsageForAllAccounts = vi.fn().mockResolvedValue(undefined);
		const getAvailableManualAccount = vi.fn().mockReturnValue(undefined);
		const hasManualAccount = vi.fn().mockReturnValue(true);
		const clearManualAccount = vi.fn();
		const activateBestAccount = vi.fn().mockResolvedValue(undefined);
		const beginInitialization = vi.fn();
		const markReady = vi.fn();

		handleNewSessionSwitch({
			getAccounts: () => [{ email: "a@example.com" }],
			loadPiAuth,
			refreshUsageForAllAccounts,
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount,
			hasManualAccount,
			clearManualAccount,
			activateBestAccount,
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(beginInitialization).toHaveBeenCalled();
			expect(loadPiAuth).toHaveBeenCalled();
			expect(refreshUsageForAllAccounts).toHaveBeenCalledWith(undefined);
			expect(getAvailableManualAccount).toHaveBeenCalled();
			expect(hasManualAccount).toHaveBeenCalled();
			expect(clearManualAccount).toHaveBeenCalled();
			expect(activateBestAccount).toHaveBeenCalled();
			expect(markReady).toHaveBeenCalled();
		});
	});

	it("marks ready even when the refresh throws", async () => {
		const loadPiAuth = vi.fn().mockRejectedValue(new Error("network failure"));
		const beginInitialization = vi.fn();
		const markReady = vi.fn();

		handleNewSessionSwitch({
			loadPiAuth,
			refreshUsageForAllAccounts: vi.fn(),
			getAccountsNeedingReauth: () => [],
			getAvailableManualAccount: vi.fn(),
			hasManualAccount: vi.fn(),
			clearManualAccount: vi.fn(),
			activateBestAccount: vi.fn(),
			beginInitialization,
			markReady,
		} as never);

		await vi.waitFor(() => {
			expect(markReady).toHaveBeenCalled();
		});
	});
});
