import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	registerCommands: vi.fn(),
	handleSessionStart: vi.fn(),
	handleNewSessionSwitch: vi.fn(),
	buildMulticodexProviderConfig: vi.fn(() => ({ mocked: true })),
	resetSessionWarnings: vi.fn(),
	startPiAuthWatch: vi.fn(),
	stopPiAuthWatch: vi.fn(),
	statusRefreshFor: vi.fn(),
	statusStartSession: vi.fn(),
	statusStopSession: vi.fn(),
	statusLoadPreferences: vi.fn().mockResolvedValue(undefined),
	statusScheduleModelSelectRefresh: vi.fn(),
}));

vi.mock("./account-manager", () => ({
	AccountManager: class MockAccountManager {
		resetSessionWarnings = mocks.resetSessionWarnings;
		startPiAuthWatch = mocks.startPiAuthWatch;
		stopPiAuthWatch = mocks.stopPiAuthWatch;
	},
}));

vi.mock("./commands", () => ({
	registerCommands: mocks.registerCommands,
}));

vi.mock("./hooks", () => ({
	handleNewSessionSwitch: mocks.handleNewSessionSwitch,
	handleSessionStart: mocks.handleSessionStart,
}));

vi.mock("./provider", () => ({
	PROVIDER_ID: "openai-codex",
	buildMulticodexProviderConfig: mocks.buildMulticodexProviderConfig,
}));

vi.mock("./status", () => ({
	createUsageStatusController: () => ({
		loadPreferences: mocks.statusLoadPreferences,
		refreshFor: mocks.statusRefreshFor,
		scheduleModelSelectRefresh: mocks.statusScheduleModelSelectRefresh,
		startSession: mocks.statusStartSession,
		stopSession: mocks.statusStopSession,
	}),
}));

import multicodexExtension from "./extension";

function createMockContext(
	sessionKey = "session-a",
	provider = "openai-codex",
) {
	return {
		ui: { notify: vi.fn() },
		model: { provider },
		sessionManager: {
			getSessionFile: () => sessionKey,
			getSessionId: () => sessionKey,
		},
	};
}

describe("multicodexExtension", () => {
	beforeEach(() => {
		mocks.registerCommands.mockClear();
		mocks.handleSessionStart.mockReset();
		mocks.handleSessionStart.mockResolvedValue(undefined);
		mocks.handleNewSessionSwitch.mockReset();
		mocks.handleNewSessionSwitch.mockResolvedValue(undefined);
		mocks.buildMulticodexProviderConfig.mockClear();
		mocks.resetSessionWarnings.mockClear();
		mocks.startPiAuthWatch.mockClear();
		mocks.stopPiAuthWatch.mockClear();
		mocks.statusRefreshFor.mockClear();
		mocks.statusStartSession.mockClear();
		mocks.statusStopSession.mockClear();
		mocks.statusLoadPreferences.mockClear();
		mocks.statusScheduleModelSelectRefresh.mockClear();
	});

	it("registers provider, commands, and lifecycle hooks", () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const registerProvider = vi.fn();
		const on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			handlers.set(event, handler);
		});

		multicodexExtension({
			registerProvider,
			on,
		} as never);

		expect(mocks.buildMulticodexProviderConfig).toHaveBeenCalledOnce();
		expect(registerProvider).toHaveBeenCalledWith("openai-codex", {
			mocked: true,
		});
		expect(mocks.registerCommands).toHaveBeenCalledOnce();
		expect(on).toHaveBeenCalledTimes(4);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("turn_end")).toBe(true);
		expect(handlers.has("model_select")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
	});

	it("awaits startup session work before continuing", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.handleSessionStart.mockImplementation(async () => {
			await started;
		});

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		const ctx = createMockContext();
		const sessionStart = handlers.get("session_start");
		expect(sessionStart).toBeTypeOf("function");

		const running = sessionStart?.({ reason: "resume" }, ctx as never);
		expect(mocks.handleSessionStart).toHaveBeenCalledOnce();
		expect(mocks.statusLoadPreferences).not.toHaveBeenCalled();
		release();
		await running;
		expect(mocks.statusLoadPreferences).toHaveBeenCalledOnce();
	});

	it("guards auth sync by the current managed model and surfaces current errors", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const ctx = createMockContext();

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		await handlers.get("session_start")?.({ reason: "resume" }, ctx as never);
		const watchOptions = mocks.startPiAuthWatch.mock.calls[0]?.[0] as {
			shouldApply: () => boolean;
			onError: (error: unknown) => void;
		};
		expect(watchOptions.shouldApply()).toBe(true);

		ctx.model = { provider: "anthropic" };
		expect(watchOptions.shouldApply()).toBe(false);
		watchOptions.onError(new Error("stale watcher failure"));
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		ctx.model = { provider: "openai-codex" };
		expect(watchOptions.shouldApply()).toBe(true);
		watchOptions.onError(new Error("current watcher failure"));
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Multicodex: failed to sync pi auth: current watcher failure",
			"warning",
		);
	});

	it("skips managed startup when current model is not codex", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const ctx = createMockContext("session-a", "anthropic");

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		await handlers.get("session_start")?.({ reason: "resume" }, ctx as never);

		expect(mocks.resetSessionWarnings).toHaveBeenCalledOnce();
		expect(mocks.handleSessionStart).not.toHaveBeenCalled();
		expect(mocks.handleNewSessionSwitch).not.toHaveBeenCalled();
		expect(mocks.statusStartSession).toHaveBeenCalledOnce();
		expect(mocks.statusRefreshFor).toHaveBeenCalledWith(ctx);
	});

	it("initializes managed startup when user later selects codex", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const ctx = createMockContext("session-a", "anthropic");
		const codexModel = { provider: "openai-codex" };

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		await handlers.get("session_start")?.({ reason: "resume" }, ctx as never);
		mocks.statusRefreshFor.mockClear();
		ctx.model = codexModel;

		await handlers.get("model_select")?.(
			{ type: "model_select", model: codexModel, source: "set" },
			ctx as never,
		);

		expect(mocks.statusScheduleModelSelectRefresh).toHaveBeenCalledWith(ctx);
		expect(mocks.handleSessionStart).toHaveBeenCalledOnce();
		expect(mocks.handleNewSessionSwitch).not.toHaveBeenCalled();
		expect(mocks.statusRefreshFor).toHaveBeenCalledWith(ctx);
	});

	it("does not resume startup side effects after session shutdown", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.handleSessionStart.mockImplementation(async () => {
			await started;
		});

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		const ctx = createMockContext();
		const running = handlers.get("session_start")?.(
			{ reason: "resume" },
			ctx as never,
		);
		handlers.get("session_shutdown")?.({}, ctx as never);
		release();
		await running;

		expect(mocks.statusStartSession).not.toHaveBeenCalled();
		expect(mocks.statusLoadPreferences).not.toHaveBeenCalled();
	});

	it("ignores stale shutdown from previous session", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const ctxA = createMockContext("session-a");
		const ctxB = createMockContext("session-b");

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		await handlers.get("session_start")?.({ reason: "resume" }, ctxA as never);
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.handleSessionStart.mockImplementationOnce(async () => {
			await started;
		});

		const runningB = handlers.get("session_start")?.(
			{ reason: "resume" },
			ctxB as never,
		);
		handlers.get("session_shutdown")?.({}, ctxA as never);
		release();
		await runningB;

		expect(mocks.statusStopSession).not.toHaveBeenCalled();
		expect(mocks.statusStartSession).toHaveBeenCalledTimes(2);
		expect(mocks.statusLoadPreferences).toHaveBeenCalledTimes(2);
	});

	it("ignores stale turn and model events from previous session", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const ctxA = createMockContext("session-a");
		const ctxB = createMockContext("session-b");

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		await handlers.get("session_start")?.({ reason: "resume" }, ctxA as never);
		await handlers.get("session_start")?.({ reason: "resume" }, ctxB as never);
		handlers.get("turn_end")?.({}, ctxA as never);
		handlers.get("model_select")?.({}, ctxA as never);
		handlers.get("session_shutdown")?.({}, ctxB as never);

		expect(mocks.statusRefreshFor).toHaveBeenCalledTimes(2);
		expect(mocks.statusScheduleModelSelectRefresh).not.toHaveBeenCalled();
		expect(mocks.statusStopSession).toHaveBeenCalledWith(ctxB);
	});

	it("ignores stale ctx events whose session getters throw", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const currentCtx = createMockContext("session-a");
		const staleCtx = {
			ui: { notify: vi.fn() },
			get sessionManager() {
				throw new Error("stale ctx");
			},
		};

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		await handlers.get("session_start")?.(
			{ reason: "resume" },
			currentCtx as never,
		);
		handlers.get("turn_end")?.({}, staleCtx as never);
		handlers.get("model_select")?.({}, staleCtx as never);
		handlers.get("session_shutdown")?.({}, staleCtx as never);

		expect(mocks.statusRefreshFor).toHaveBeenCalledOnce();
		expect(mocks.statusScheduleModelSelectRefresh).not.toHaveBeenCalled();
		expect(mocks.statusStopSession).not.toHaveBeenCalled();
	});

	it("ignores stale ctx events after active session is cleared", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const currentCtx = createMockContext("session-a");
		const staleCtx = {
			ui: { notify: vi.fn() },
			get sessionManager() {
				throw new Error("stale ctx");
			},
		};

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		await handlers.get("session_start")?.(
			{ reason: "resume" },
			currentCtx as never,
		);
		handlers.get("session_shutdown")?.({}, currentCtx as never);
		handlers.get("turn_end")?.({}, staleCtx as never);
		handlers.get("model_select")?.({}, staleCtx as never);
		handlers.get("session_shutdown")?.({}, staleCtx as never);

		expect(mocks.statusRefreshFor).toHaveBeenCalledOnce();
		expect(mocks.statusScheduleModelSelectRefresh).not.toHaveBeenCalled();
		expect(mocks.statusStopSession).toHaveBeenCalledOnce();
	});

	it("drops async warnings after session shutdown", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const ctx = createMockContext();

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		await handlers.get("session_start")?.({ reason: "resume" }, ctx as never);
		const sessionStartWarning = mocks.handleSessionStart.mock.calls[0]?.[1] as
			| ((message: string) => void)
			| undefined;

		sessionStartWarning?.("active hook warning");
		expect(ctx.ui.notify).toHaveBeenCalledOnce();

		handlers.get("session_shutdown")?.({}, ctx as never);
		sessionStartWarning?.("stale hook warning");

		expect(ctx.ui.notify).toHaveBeenCalledOnce();
	});

	it("routes session and status events to the helpers", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const ctx = createMockContext();

		multicodexExtension({
			registerProvider: vi.fn(),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as never);

		const sessionStart = handlers.get("session_start");
		const turnEnd = handlers.get("turn_end");
		const modelSelect = handlers.get("model_select");
		const sessionShutdown = handlers.get("session_shutdown");
		expect(sessionStart).toBeTypeOf("function");
		expect(turnEnd).toBeTypeOf("function");
		expect(modelSelect).toBeTypeOf("function");
		expect(sessionShutdown).toBeTypeOf("function");

		await sessionStart?.({ reason: "resume" }, ctx as never);
		expect(mocks.resetSessionWarnings).toHaveBeenCalledTimes(1);
		expect(mocks.handleSessionStart).toHaveBeenCalledOnce();
		expect(mocks.handleNewSessionSwitch).not.toHaveBeenCalled();
		expect(mocks.statusStartSession).toHaveBeenCalledOnce();
		await vi.waitFor(() => {
			expect(mocks.statusLoadPreferences).toHaveBeenCalledTimes(1);
			expect(mocks.statusRefreshFor).toHaveBeenCalledTimes(1);
		});

		await sessionStart?.({ reason: "new" }, ctx as never);
		expect(mocks.resetSessionWarnings).toHaveBeenCalledTimes(2);
		expect(mocks.handleNewSessionSwitch).toHaveBeenCalledOnce();
		expect(mocks.statusStartSession).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => {
			expect(mocks.statusLoadPreferences).toHaveBeenCalledTimes(2);
			expect(mocks.statusRefreshFor).toHaveBeenCalledTimes(2);
		});

		turnEnd?.({}, ctx as never);
		modelSelect?.({}, ctx as never);
		expect(mocks.statusRefreshFor).toHaveBeenCalledTimes(3);
		expect(mocks.statusScheduleModelSelectRefresh).toHaveBeenCalledWith(ctx);

		sessionShutdown?.({}, ctx as never);
		expect(mocks.statusStopSession).toHaveBeenCalledWith(ctx);
	});
});
