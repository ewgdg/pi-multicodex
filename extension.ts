import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { AccountManager } from "./account-manager";
import { registerCommands } from "./commands";
import { handleNewSessionSwitch, handleSessionStart } from "./hooks";
import { buildMulticodexProviderConfig, PROVIDER_ID } from "./provider";
import { normalizeUnknownError } from "./shared/streams";
import { createUsageStatusController } from "./status";

export default function multicodexExtension(pi: ExtensionAPI) {
	const accountManager = new AccountManager();
	const statusController = createUsageStatusController(accountManager);
	let activeSessionKey: string | undefined;
	let lifecycleVersion = 0;
	let activeModelProvider: string | undefined;
	let managedStartupInitialized = false;

	function getSessionKey(ctx: ExtensionContext): string | undefined {
		try {
			// Pi creates a fresh ctx object for each event, so object identity cannot
			// define session ownership. Stale ctx getters throw; treat that as non-current.
			return (
				ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId()
			);
		} catch {
			return undefined;
		}
	}

	function isCurrentContext(ctx: ExtensionContext, version: number): boolean {
		const sessionKey = getSessionKey(ctx);
		return (
			Boolean(sessionKey) &&
			activeSessionKey === sessionKey &&
			lifecycleVersion === version
		);
	}

	function isCurrentManagedContext(
		ctx: ExtensionContext,
		version: number,
	): boolean {
		return (
			isCurrentContext(ctx, version) &&
			activeModelProvider === PROVIDER_ID &&
			isManagedModel(ctx.model)
		);
	}

	function notifyWarning(ctx: ExtensionContext, message: string): void {
		ctx.ui.notify(message, "warning");
	}

	function isManagedModel(model: ExtensionContext["model"]): boolean {
		return model?.provider === PROVIDER_ID;
	}

	function getSelectedModel(event: unknown): ExtensionContext["model"] {
		if (event && typeof event === "object" && "model" in event) {
			return event.model as ExtensionContext["model"];
		}
		return undefined;
	}

	function notifyIfCurrent(
		ctx: ExtensionContext,
		version: number,
		message: string,
	): void {
		if (isCurrentContext(ctx, version)) {
			notifyWarning(ctx, message);
		}
	}

	function notifyManagedWarningIfCurrent(
		ctx: ExtensionContext,
		version: number,
		error: unknown,
	): void {
		if (isCurrentManagedContext(ctx, version)) {
			notifyWarning(
				ctx,
				`Multicodex: failed to sync pi auth: ${normalizeUnknownError(error)}`,
			);
		}
	}

	async function initializeManagedStartup(
		ctx: ExtensionContext,
		version: number,
		reason: SessionStartEvent["reason"],
	): Promise<void> {
		const rotationContext = {
			ctx,
			reason,
			isCurrent: () => isCurrentManagedContext(ctx, version),
		};
		if (reason === "new") {
			await handleNewSessionSwitch(
				accountManager,
				(msg) => notifyIfCurrent(ctx, version, msg),
				rotationContext,
			);
		} else {
			await handleSessionStart(
				accountManager,
				(msg) => notifyIfCurrent(ctx, version, msg),
				rotationContext,
			);
		}
		if (isCurrentManagedContext(ctx, version)) {
			managedStartupInitialized = true;
		}
	}

	pi.registerProvider(
		PROVIDER_ID,
		buildMulticodexProviderConfig(accountManager),
	);

	registerCommands(pi, accountManager, statusController);

	pi.on(
		"session_start",
		async (event: SessionStartEvent, ctx: ExtensionContext) => {
			activeSessionKey = getSessionKey(ctx);
			activeModelProvider = ctx.model?.provider;
			lifecycleVersion += 1;
			managedStartupInitialized = false;
			const version = lifecycleVersion;
			accountManager.resetSessionWarnings();
			// Never touch account rotation while another provider is active. Registering
			// MultiCodex makes Codex available, but it must not pull non-Codex sessions
			// back to Codex through startup side effects.
			if (isManagedModel(ctx.model)) {
				accountManager.startPiAuthWatch({
					shouldApply: () => isCurrentManagedContext(ctx, version),
					onError: (error) =>
						notifyManagedWarningIfCurrent(ctx, version, error),
				});
				await initializeManagedStartup(ctx, version, event.reason);
			} else {
				accountManager.stopPiAuthWatch();
			}
			if (!isCurrentContext(ctx, version)) return;
			statusController.startAutoRefresh();
			await statusController.loadPreferences(ctx);
			if (!isCurrentContext(ctx, version)) return;
			await statusController.refreshFor(ctx);
		},
	);

	pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
		if (!activeSessionKey || getSessionKey(ctx) !== activeSessionKey) return;
		void statusController.refreshFor(ctx);
	});

	pi.on("model_select", async (event: unknown, ctx: ExtensionContext) => {
		if (!activeSessionKey || getSessionKey(ctx) !== activeSessionKey) return;
		const version = lifecycleVersion;
		statusController.scheduleModelSelectRefresh(ctx);
		const selectedModel = getSelectedModel(event) ?? ctx.model;
		activeModelProvider = selectedModel?.provider;
		if (!isManagedModel(selectedModel)) {
			accountManager.stopPiAuthWatch();
			return;
		}
		accountManager.startPiAuthWatch({
			shouldApply: () => isCurrentManagedContext(ctx, version),
			onError: (error) => notifyManagedWarningIfCurrent(ctx, version, error),
		});
		if (managedStartupInitialized) return;
		await initializeManagedStartup(ctx, version, "resume");
		if (!isCurrentContext(ctx, version)) return;
		await statusController.refreshFor(ctx);
	});

	pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
		if (!activeSessionKey || getSessionKey(ctx) !== activeSessionKey) return;
		lifecycleVersion += 1;
		activeSessionKey = undefined;
		activeModelProvider = undefined;
		managedStartupInitialized = false;
		accountManager.stopPiAuthWatch();
		statusController.stopAutoRefresh(ctx);
	});
}
