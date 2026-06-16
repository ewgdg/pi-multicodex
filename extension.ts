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
	let activeContext: ExtensionContext | undefined;
	let lifecycleVersion = 0;

	function isCurrentContext(ctx: ExtensionContext, version: number): boolean {
		return activeContext === ctx && lifecycleVersion === version;
	}

	function notifyWarning(ctx: ExtensionContext, message: string): void {
		try {
			ctx.ui.notify(message, "warning");
		} catch (error) {
			// UI warnings are best-effort; stale session-bound ctx must not break streaming.
			activeContext = undefined;
			console.warn("[multicodex] Failed to show warning:", error);
		}
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

	accountManager.setWarningHandler((message) => {
		if (activeContext) {
			notifyWarning(activeContext, message);
		}
	});

	pi.registerProvider(
		PROVIDER_ID,
		buildMulticodexProviderConfig(accountManager),
	);

	registerCommands(pi, accountManager, statusController);

	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		activeContext = ctx;
		lifecycleVersion += 1;
		const version = lifecycleVersion;
		accountManager.resetSessionWarnings();
		const rotationContext = { ctx, reason: event.reason };
		if (event.reason === "new") {
			handleNewSessionSwitch(
				accountManager,
				(msg) => notifyIfCurrent(ctx, version, msg),
				rotationContext,
			);
		} else {
			handleSessionStart(
				accountManager,
				(msg) => notifyIfCurrent(ctx, version, msg),
				rotationContext,
			);
		}
		statusController.startAutoRefresh();
		void (async () => {
			await statusController.loadPreferences(ctx);
			if (!isCurrentContext(ctx, version)) return;
			await statusController.refreshFor(ctx);
		})();
	});

	pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
		activeContext = ctx;
		void statusController.refreshFor(ctx);
	});

	pi.on("model_select", (_event: unknown, ctx: ExtensionContext) => {
		activeContext = ctx;
		statusController.scheduleModelSelectRefresh(ctx);
	});

	pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
		lifecycleVersion += 1;
		activeContext = undefined;
		statusController.stopAutoRefresh(ctx);
	});
}
