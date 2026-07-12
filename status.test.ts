import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createUsageStatusController,
	type FooterPreferences,
	formatActiveAccountStatus,
	isManagedModel,
} from "./status";

const defaultPreferences: FooterPreferences = {
	usageMode: "left",
	resetWindow: "both",
	showAccount: true,
	showReset: true,
	order: "account-first",
};

function createContext(overrides?: {
	provider?: string;
	setStatus?: ReturnType<typeof vi.fn>;
	notify?: ReturnType<typeof vi.fn>;
	color?: (token: string, text: string) => string;
}) {
	const setStatus = overrides?.setStatus ?? vi.fn();
	const notify = overrides?.notify ?? vi.fn();
	const color = overrides?.color ?? ((_token: string, text: string) => text);
	return {
		hasUI: true,
		model: {
			provider: overrides?.provider ?? "openai-codex",
		},
		ui: {
			setStatus,
			notify,
			theme: {
				fg: color,
				bold: (text: string) => text,
			},
		},
	} as never;
}

describe("isManagedModel", () => {
	it("matches the overridden openai-codex provider", () => {
		expect(isManagedModel({ provider: "openai-codex" } as never)).toBe(true);
		expect(isManagedModel({ provider: "anthropic" } as never)).toBe(false);
		expect(isManagedModel(undefined)).toBe(false);
	});
});

describe("formatActiveAccountStatus", () => {
	it("renders account, usage, and both reset countdowns beside their matching periods", () => {
		const ctx = createContext();
		const text = formatActiveAccountStatus(
			ctx,
			"a@example.com",
			{
				primary: { usedPercent: 25, resetAt: Date.now() + 60_000 },
				secondary: { usedPercent: 60, resetAt: Date.now() + 3_600_000 },
				fetchedAt: 0,
			},
			defaultPreferences,
		);

		expect(text).toContain("Codex");
		expect(text).toContain("a@example.com");
		expect(text).toContain("5h:75% left (↺");
		expect(text).toContain("7d:40% left (↺");
		expect(text).not.toContain("(5h:↺");
		expect(text).not.toContain("(7d:↺");
	});

	it("supports hiding the account and moving it after the usage fields", () => {
		const ctx = createContext();
		const text = formatActiveAccountStatus(
			ctx,
			"a@example.com",
			{
				primary: { usedPercent: 10, resetAt: 1 },
				secondary: { usedPercent: 20, resetAt: 2 },
				fetchedAt: 0,
			},
			{
				...defaultPreferences,
				showAccount: false,
				showReset: false,
				order: "usage-first",
				usageMode: "used",
			},
		);

		expect(text).toContain("5h:10% used");
		expect(text).toContain("7d:20% used");
		expect(text).not.toContain("a@example.com");
		expect(text).not.toContain("↺");
	});

	it("colors full usage windows by severity, adds muted separators, and lifts the account text", () => {
		const ctx = createContext({
			color: (token: string, text: string) => `[${token}:${text}]`,
		});
		const text = formatActiveAccountStatus(
			ctx,
			"a@example.com",
			{
				primary: { usedPercent: 25, resetAt: Date.now() + 60_000 },
				secondary: { usedPercent: 95, resetAt: Date.now() + 120_000 },
				fetchedAt: 0,
			},
			defaultPreferences,
		);

		expect(text).toContain("[muted:Codex]");
		expect(text).toContain("[text:a@example.com]");
		expect(text).toContain("[success:5h:75% left (↺");
		expect(text).toContain("[error:7d:5% left (↺");
		expect(text).toContain("[muted:·]");
	});

	it("uses thinkingMedium for neutral used windows", () => {
		const ctx = createContext({
			color: (token: string, text: string) => `[${token}:${text}]`,
		});
		const text = formatActiveAccountStatus(
			ctx,
			"a@example.com",
			{
				primary: { usedPercent: 52, resetAt: Date.now() + 60_000 },
				secondary: { usedPercent: 96, resetAt: Date.now() + 120_000 },
				fetchedAt: 0,
			},
			{ ...defaultPreferences, usageMode: "used" },
		);

		expect(text).toContain("[thinkingMedium:5h:52% used (↺");
		expect(text).toContain("[error:7d:96% used (↺");
	});

	it("uses muted loading text and dim unknown usage windows", () => {
		const ctx = createContext({
			color: (token: string, text: string) => `[${token}:${text}]`,
		});
		const loading = formatActiveAccountStatus(
			ctx,
			"a@example.com",
			undefined,
			defaultPreferences,
		);
		const unknown = formatActiveAccountStatus(
			ctx,
			"a@example.com",
			{
				primary: { resetAt: Date.now() + 60_000 },
				secondary: { resetAt: Date.now() + 120_000 },
				fetchedAt: 0,
			},
			defaultPreferences,
		);

		expect(loading).toContain("[muted:Codex]");
		expect(loading).toContain("[muted:loading...]");
		expect(unknown).toContain("[dim:5h:-- (↺");
		expect(unknown).toContain("[dim:7d:-- (↺");
	});
});

describe("createUsageStatusController", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("clears the footer when the selected model is not managed by multicodex", async () => {
		const setStatus = vi.fn();
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
		} as never);

		await controller.refreshFor(
			createContext({ provider: "anthropic", setStatus }),
		);

		expect(setStatus).toHaveBeenCalledWith("multicodex-usage", undefined);
	});

	it("renders selecting-account status while account manager initializes", async () => {
		const setStatus = vi.fn();
		const refreshUsageForAccount = vi.fn();
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			isInitializing: () => true,
			getActiveAccount: () => ({ email: "old@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount,
		} as never);

		await controller.refreshFor(createContext({ setStatus }));

		expect(setStatus).toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("selecting account..."),
		);
		expect(setStatus).not.toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("old@example.com"),
		);
		expect(refreshUsageForAccount).not.toHaveBeenCalled();
	});

	it("renders active-account usage for managed models", async () => {
		const setStatus = vi.fn();
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount: vi.fn().mockResolvedValue({
				primary: { usedPercent: 10, resetAt: 1 },
				secondary: { usedPercent: 20, resetAt: 2 },
				fetchedAt: 0,
			}),
		} as never);

		await controller.refreshFor(createContext({ setStatus }));

		expect(setStatus).toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("a@example.com"),
		);
		expect(setStatus).toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("5h:90% left"),
		);
		expect(setStatus).toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("7d:80% left"),
		);
	});
	it("shows reauth warning instead of stale usage for expired active account", async () => {
		const setStatus = vi.fn();
		const refreshUsageForAccount = vi.fn();
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({
				email: "expired@example.com",
				needsReauth: true,
			}),
			getCachedUsage: () => ({
				primary: { usedPercent: 10, resetAt: 1 },
				secondary: { usedPercent: 20, resetAt: 2 },
				fetchedAt: 0,
			}),
			refreshUsageForAccount,
		} as never);

		await controller.refreshFor(createContext({ setStatus }));

		expect(setStatus).toHaveBeenLastCalledWith(
			"multicodex-usage",
			expect.stringContaining("Multicodex expired@example.com needs reauth"),
		);
		expect(setStatus).not.toHaveBeenLastCalledWith(
			"multicodex-usage",
			expect.stringContaining("5h:90% left"),
		);
		expect(refreshUsageForAccount).not.toHaveBeenCalled();
	});

	it("falls back to cached usage when refreshing fails", async () => {
		const setStatus = vi.fn();
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: () => ({
				primary: { usedPercent: 30, resetAt: 1 },
				secondary: { usedPercent: 40, resetAt: 2 },
				fetchedAt: 0,
			}),
			refreshUsageForAccount: vi.fn().mockResolvedValue(undefined),
		} as never);

		await controller.refreshFor(createContext({ setStatus }));

		expect(setStatus).toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("5h:70% left"),
		);
		expect(setStatus).toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("7d:60% left"),
		);
	});

	it("debounces model-select refreshes while rendering cached usage immediately", async () => {
		vi.useFakeTimers();
		const setStatus = vi.fn();
		const refreshUsageForAccount = vi.fn().mockResolvedValue({
			primary: { usedPercent: 10, resetAt: 1 },
			secondary: { usedPercent: 20, resetAt: 2 },
			fetchedAt: 0,
		});
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: () => ({
				primary: { usedPercent: 30, resetAt: 1 },
				secondary: { usedPercent: 40, resetAt: 2 },
				fetchedAt: 0,
			}),
			refreshUsageForAccount,
		} as never);
		const ctx = createContext({ setStatus });

		controller.scheduleModelSelectRefresh(ctx);
		controller.scheduleModelSelectRefresh(ctx);

		expect(setStatus).toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("5h:70% left"),
		);
		expect(refreshUsageForAccount).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(250);

		expect(refreshUsageForAccount).toHaveBeenCalledTimes(1);
	});

	it("clears the footer immediately on model-select when the selected model is not codex", () => {
		vi.useFakeTimers();
		const setStatus = vi.fn();
		const refreshUsageForAccount = vi.fn();
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: () => ({
				primary: { usedPercent: 30, resetAt: 1 },
				secondary: { usedPercent: 40, resetAt: 2 },
				fetchedAt: 0,
			}),
			refreshUsageForAccount,
		} as never);
		const ctx = createContext({ provider: "anthropic", setStatus });

		controller.scheduleModelSelectRefresh(ctx);

		expect(setStatus).toHaveBeenCalledWith("multicodex-usage", undefined);
		expect(refreshUsageForAccount).not.toHaveBeenCalled();
	});

	it("does not poll status while idle", async () => {
		vi.useFakeTimers();
		const setStatus = vi.fn();
		const refreshUsageForAccount = vi.fn().mockResolvedValue({ fetchedAt: 0 });
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount,
		} as never);
		const ctx = createContext({ setStatus });

		await controller.refreshFor(ctx);
		expect(refreshUsageForAccount).toHaveBeenCalledOnce();
		controller.startSession();
		setStatus.mockClear();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(refreshUsageForAccount).toHaveBeenCalledOnce();
		expect(setStatus).not.toHaveBeenCalled();
	});

	it("ignores account state changes when the stored context is stale", async () => {
		let stateChangeHandler: (() => void) | undefined;
		let stale = false;
		const setStatus = vi.fn();
		const ctx = {
			get hasUI() {
				if (stale) throw new Error("stale ctx");
				return true;
			},
			get model() {
				if (stale) throw new Error("stale ctx");
				return { provider: "openai-codex" };
			},
			ui: {
				setStatus,
				notify: vi.fn(),
				theme: {
					fg: (_token: string, text: string) => text,
					bold: (text: string) => text,
				},
			},
		};
		const controller = createUsageStatusController({
			onStateChange: (handler: () => void) => {
				stateChangeHandler = handler;
				return () => undefined;
			},
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount: vi.fn().mockResolvedValue({ fetchedAt: 0 }),
		} as never);

		await controller.refreshFor(ctx as never);
		stale = true;
		setStatus.mockClear();

		expect(() => stateChangeHandler?.()).not.toThrow();
		expect(setStatus).not.toHaveBeenCalled();
	});

	it("does not touch a stale context after session shutdown during refresh", async () => {
		const setStatus = vi.fn();
		let resolveUsage:
			| ((value: {
					primary: { usedPercent: number; resetAt: number };
					secondary: { usedPercent: number; resetAt: number };
					fetchedAt: number;
			  }) => void)
			| undefined;
		const refreshUsageForAccount = vi.fn(
			() =>
				new Promise<{
					primary: { usedPercent: number; resetAt: number };
					secondary: { usedPercent: number; resetAt: number };
					fetchedAt: number;
				}>((resolve) => {
					resolveUsage = resolve;
				}),
		);
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount,
		} as never);
		const ctx = createContext({ setStatus });

		const refresh = controller.refreshFor(ctx);
		await vi.waitFor(() =>
			expect(refreshUsageForAccount).toHaveBeenCalledOnce(),
		);
		controller.stopSession(ctx);
		setStatus.mockClear();
		resolveUsage?.({
			primary: { usedPercent: 10, resetAt: 1 },
			secondary: { usedPercent: 20, resetAt: 2 },
			fetchedAt: 0,
		});
		await refresh;

		expect(setStatus).not.toHaveBeenCalled();
	});

	it("re-renders from cached state when the account manager reports a state change", async () => {
		const setStatus = vi.fn();
		let stateChangeHandler: (() => void) | undefined;
		let activeEmail = "a@example.com";
		const usages = new Map([
			[
				"a@example.com",
				{
					primary: { usedPercent: 30, resetAt: 1 },
					secondary: { usedPercent: 40, resetAt: 2 },
					fetchedAt: 0,
				},
			],
			[
				"b@example.com",
				{
					primary: { usedPercent: 5, resetAt: 1 },
					secondary: { usedPercent: 10, resetAt: 2 },
					fetchedAt: 0,
				},
			],
		]);
		const controller = createUsageStatusController({
			onStateChange: (handler: () => void) => {
				stateChangeHandler = handler;
				return () => undefined;
			},
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: activeEmail }),
			getCachedUsage: (email: string) => usages.get(email),
			refreshUsageForAccount: vi
				.fn()
				.mockImplementation(async () => usages.get(activeEmail)),
		} as never);
		const ctx = createContext({ setStatus });

		await controller.refreshFor(ctx);
		activeEmail = "b@example.com";
		stateChangeHandler?.();

		expect(setStatus).toHaveBeenLastCalledWith(
			"multicodex-usage",
			expect.stringContaining("b@example.com"),
		);
		expect(setStatus).toHaveBeenLastCalledWith(
			"multicodex-usage",
			expect.stringContaining("5h:95% left"),
		);
	});

	it("does not restore footer when model switches away during usage refresh", async () => {
		const setStatus = vi.fn();
		let provider = "openai-codex";
		let resolveUsage:
			| ((value: {
					primary: { usedPercent: number };
					fetchedAt: number;
			  }) => void)
			| undefined;
		const refreshUsageForAccount = vi.fn(
			() =>
				new Promise<{ primary: { usedPercent: number }; fetchedAt: number }>(
					(resolve) => {
						resolveUsage = resolve;
					},
				),
		);
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount,
		} as never);
		const ctx = {
			hasUI: true,
			get model() {
				return { provider };
			},
			ui: {
				setStatus,
				notify: vi.fn(),
				theme: {
					fg: (_token: string, value: string) => value,
					bold: (value: string) => value,
				},
			},
		} as never;

		const refresh = controller.refreshFor(ctx);
		await vi.waitFor(() =>
			expect(refreshUsageForAccount).toHaveBeenCalledOnce(),
		);
		setStatus.mockClear();
		provider = "anthropic";
		controller.setUsageObserverActive(ctx, false);
		setStatus.mockClear();
		resolveUsage?.({ primary: { usedPercent: 10 }, fetchedAt: 1 });
		await refresh;

		expect(setStatus).not.toHaveBeenCalledWith(
			"multicodex-usage",
			expect.stringContaining("10%"),
		);
	});

	it("unsubscribes the usage observer when rendering the live context fails", async () => {
		const setStatus = vi.fn(() => {
			throw new Error("stale ui");
		});
		const unsubscribe = vi.fn();
		let stateChangeHandler: (() => void) | undefined;
		const controller = createUsageStatusController({
			onStateChange: (handler: () => void) => {
				stateChangeHandler = handler;
				return () => undefined;
			},
			subscribeUsageObserver: () => unsubscribe,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount: vi.fn().mockResolvedValue({ fetchedAt: 1 }),
		} as never);
		const ctx = createContext({ setStatus });

		await expect(controller.refreshFor(ctx)).resolves.toBeUndefined();
		stateChangeHandler?.();

		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("clears stale context before new-session startup can report state changes", async () => {
		const setStatus = vi.fn();
		let stateChangeHandler: (() => void) | undefined;
		const controller = createUsageStatusController({
			onStateChange: (handler: () => void) => {
				stateChangeHandler = handler;
				return () => undefined;
			},
			subscribeUsageObserver: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount: vi.fn().mockResolvedValue({ fetchedAt: 1 }),
		} as never);
		const ctx = createContext({ setStatus });

		await controller.refreshFor(ctx);
		controller.startSession();
		setStatus.mockClear();
		stateChangeHandler?.();

		expect(setStatus).not.toHaveBeenCalled();
	});
});

describe("active usage observer lifecycle", () => {
	it("observes only interactive managed sessions and unsubscribes on model switch/shutdown", async () => {
		const setStatus = vi.fn();
		const unsubscribe = vi.fn();
		const subscribeUsageObserver = vi.fn(() => unsubscribe);
		const refreshUsageForAccount = vi
			.fn()
			.mockResolvedValue({ fetchedAt: Date.now() });
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount,
			subscribeUsageObserver,
		} as never);
		const ctx = createContext({ setStatus });

		await controller.refreshFor(ctx);
		expect(subscribeUsageObserver).toHaveBeenCalledOnce();

		controller.setUsageObserverActive(ctx, false);
		expect(unsubscribe).toHaveBeenCalledOnce();

		controller.setUsageObserverActive(ctx, true);
		expect(subscribeUsageObserver).toHaveBeenCalledTimes(2);
		controller.stopSession(ctx);
		expect(unsubscribe).toHaveBeenCalledTimes(2);
	});

	it("propagates observer registration errors", async () => {
		const registrationError = new Error("observer registration failed");
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: vi.fn(),
			refreshUsageForAccount: vi.fn(),
			subscribeUsageObserver: () => {
				throw registrationError;
			},
		} as never);
		const ctx = createContext();

		expect(() => controller.setUsageObserverActive(ctx, true)).toThrow(
			registrationError,
		);
		await expect(controller.refreshFor(ctx)).rejects.toThrow(registrationError);
	});
	it("re-renders current cached footer when shared usage snapshot changes", async () => {
		const setStatus = vi.fn();
		let usageHandler: (() => void) | undefined;
		const activeEmail = "a@example.com";
		const usages = new Map([
			[
				"a@example.com",
				{
					primary: { usedPercent: 30, resetAt: 1 },
					secondary: { usedPercent: 40, resetAt: 2 },
					fetchedAt: 0,
				},
			],
		]);
		const subscribeUsageObserver = vi.fn((handler: () => void) => {
			usageHandler = handler;
			return () => {
				usageHandler = undefined;
			};
		});
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			getActiveAccount: () => ({ email: activeEmail }),
			getCachedUsage: (email: string) => usages.get(email),
			refreshUsageForAccount: vi
				.fn()
				.mockImplementation(async () => usages.get(activeEmail)),
			subscribeUsageObserver,
		} as never);
		const ctx = createContext({ setStatus });

		await controller.refreshFor(ctx);
		expect(subscribeUsageObserver).toHaveBeenCalledWith(expect.any(Function));
		setStatus.mockClear();
		usages.set("a@example.com", {
			primary: { usedPercent: 65, resetAt: 1 },
			secondary: { usedPercent: 75, resetAt: 2 },
			fetchedAt: 1,
		});
		usageHandler?.();

		expect(setStatus).toHaveBeenLastCalledWith(
			"multicodex-usage",
			expect.stringContaining("5h:35% left"),
		);

		controller.stopSession(ctx);
		setStatus.mockClear();
		usageHandler?.();
		expect(setStatus).not.toHaveBeenCalled();
	});

	it("renders usage updates in latest same-session context without duplicating observer", async () => {
		const setStatusA = vi.fn();
		const setStatusB = vi.fn();
		let usageHandler: (() => void) | undefined;
		const usages = new Map([
			[
				"a@example.com",
				{
					primary: { usedPercent: 30, resetAt: 1 },
					secondary: { usedPercent: 40, resetAt: 2 },
					fetchedAt: 0,
				},
			],
		]);
		const subscribeUsageObserver = vi.fn((handler: () => void) => {
			usageHandler = handler;
			return () => undefined;
		});
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			getActiveAccount: () => ({ email: "a@example.com" }),
			getCachedUsage: (email: string) => usages.get(email),
			refreshUsageForAccount: vi
				.fn()
				.mockImplementation(async () => usages.get("a@example.com")),
			subscribeUsageObserver,
		} as never);
		const ctxA = createContext({ setStatus: setStatusA });
		const ctxB = createContext({ setStatus: setStatusB });

		await controller.refreshFor(ctxA);
		await controller.refreshFor(ctxB);

		expect(subscribeUsageObserver).toHaveBeenCalledOnce();
		setStatusA.mockClear();
		setStatusB.mockClear();
		usages.set("a@example.com", {
			primary: { usedPercent: 65, resetAt: 1 },
			secondary: { usedPercent: 75, resetAt: 2 },
			fetchedAt: 1,
		});
		usageHandler?.();

		expect(setStatusA).not.toHaveBeenCalled();
		expect(setStatusB).toHaveBeenLastCalledWith(
			"multicodex-usage",
			expect.stringContaining("5h:35% left"),
		);
	});

	it("rebinds usage observer when a new session starts before old shutdown", async () => {
		const setStatus = vi.fn();
		let activeEmail = "a@example.com";
		const usages = new Map([
			[
				"a@example.com",
				{
					primary: { usedPercent: 10 },
					secondary: { usedPercent: 20 },
					fetchedAt: 0,
				},
			],
			[
				"b@example.com",
				{
					primary: { usedPercent: 30 },
					secondary: { usedPercent: 40 },
					fetchedAt: 0,
				},
			],
		]);
		const subscriptions: Array<{ handler: () => void; active: boolean }> = [];
		const subscribeUsageObserver = vi.fn((handler: () => void) => {
			const subscription = { handler, active: true };
			subscriptions.push(subscription);
			return () => {
				subscription.active = false;
			};
		});
		const controller = createUsageStatusController({
			onStateChange: () => () => undefined,
			getActiveAccount: () => ({ email: activeEmail }),
			getCachedUsage: (email: string) => usages.get(email),
			refreshUsageForAccount: vi
				.fn()
				.mockImplementation(async () => usages.get(activeEmail)),
			subscribeUsageObserver,
		} as never);
		const firstContext = createContext({ setStatus });
		const secondContext = createContext({ setStatus });

		await controller.refreshFor(firstContext);
		controller.startSession();
		activeEmail = "b@example.com";
		await controller.refreshFor(secondContext);

		expect(subscribeUsageObserver).toHaveBeenCalledTimes(2);
		expect(subscriptions[0]?.active).toBe(false);
		setStatus.mockClear();
		subscriptions[0]?.handler();
		expect(setStatus).not.toHaveBeenCalled();
		subscriptions[1]?.handler();
		expect(setStatus).toHaveBeenLastCalledWith(
			"multicodex-usage",
			expect.stringContaining("b@example.com"),
		);
	});
});
