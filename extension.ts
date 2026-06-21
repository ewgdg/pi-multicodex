import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { AccountManager } from "./account-manager";
import { registerCommands } from "./commands";
import { handleNewSessionSwitch, handleSessionStart } from "./hooks";
import { buildMulticodexProviderConfig, PROVIDER_ID } from "./provider";
import { createUsageStatusController } from "./status";

export default function multicodexExtension(pi: ExtensionAPI) {
	const accountManager = new AccountManager();
	const statusController = createUsageStatusController(accountManager);
	let activeSessionKey: string | undefined;
	let lifecycleVersion = 0;

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

	function notifyWarning(ctx: ExtensionContext, message: string): void {
		ctx.ui.notify(message, "warning");
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

	pi.registerProvider(
		PROVIDER_ID,
		buildMulticodexProviderConfig(accountManager),
	);

	registerCommands(pi, accountManager, statusController);

	pi.on(
		"session_start",
		async (event: SessionStartEvent, ctx: ExtensionContext) => {
			activeSessionKey = getSessionKey(ctx);
			lifecycleVersion += 1;
			const version = lifecycleVersion;
			accountManager.resetSessionWarnings();
			const rotationContext = {
				ctx,
				reason: event.reason,
				isCurrent: () => isCurrentContext(ctx, version),
			};
			if (event.reason === "new") {
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

	pi.on("model_select", (_event: unknown, ctx: ExtensionContext) => {
		if (!activeSessionKey || getSessionKey(ctx) !== activeSessionKey) return;
		statusController.scheduleModelSelectRefresh(ctx);
	});

	pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
		if (!activeSessionKey || getSessionKey(ctx) !== activeSessionKey) return;
		lifecycleVersion += 1;
		activeSessionKey = undefined;
		statusController.stopAutoRefresh(ctx);
	});
}
