import type {
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { AccountManager } from "./account-manager";
import { PROVIDER_ID } from "./provider";
import type { CacheAffinityContext } from "./selection";

type WarningHandler = (message: string) => void;
type SessionStartReason = SessionStartEvent["reason"];

interface StartupRotationContext {
	ctx: ExtensionContext;
	reason: SessionStartReason;
	isCurrent?: () => boolean;
}

interface LastCodexAssistantInfo {
	ageMs: number;
	usageTokens?: number;
}

function getEntryTimestampMs(entryTimestamp: string): number | undefined {
	const timestamp = Date.parse(entryTimestamp);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function getLastCodexAssistantInfo(
	ctx: ExtensionContext,
): LastCodexAssistantInfo | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry || entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		if (message.provider !== PROVIDER_ID) continue;

		const timestampMs =
			typeof message.timestamp === "number"
				? message.timestamp
				: getEntryTimestampMs(entry.timestamp);
		if (timestampMs === undefined || !Number.isFinite(timestampMs)) continue;

		const usageTokens =
			typeof message.usage?.input === "number"
				? message.usage.input
				: message.usage?.totalTokens;
		return {
			ageMs: Math.max(0, Date.now() - timestampMs),
			usageTokens:
				typeof usageTokens === "number" && Number.isFinite(usageTokens)
					? usageTokens
					: undefined,
		};
	}
	return undefined;
}

function getContextTokenEstimate(
	ctx: ExtensionContext,
	lastCodexAssistantInfo: LastCodexAssistantInfo,
): number | undefined {
	const contextTokens = ctx.getContextUsage()?.tokens;
	if (typeof contextTokens === "number" && Number.isFinite(contextTokens)) {
		return contextTokens;
	}
	return lastCodexAssistantInfo.usageTokens;
}

function isStartupCurrent(rotationContext?: StartupRotationContext): boolean {
	return rotationContext?.isCurrent?.() ?? true;
}

function getStartupCacheAffinity(
	rotationContext?: StartupRotationContext,
): Omit<CacheAffinityContext, "activeEmail"> | undefined {
	if (
		!rotationContext ||
		rotationContext.reason === "new" ||
		!isStartupCurrent(rotationContext)
	) {
		return undefined;
	}
	const lastCodexAssistantInfo = getLastCodexAssistantInfo(rotationContext.ctx);
	if (!lastCodexAssistantInfo) return undefined;
	const contextTokens = getContextTokenEstimate(
		rotationContext.ctx,
		lastCodexAssistantInfo,
	);
	if (contextTokens === undefined) return undefined;
	return {
		ageMs: lastCodexAssistantInfo.ageMs,
		contextTokens,
	};
}

async function refreshAndActivateBestAccount(
	accountManager: AccountManager,
	warningHandler?: WarningHandler,
	rotationContext?: StartupRotationContext,
): Promise<void> {
	const initializationToken = accountManager.beginInitialization();
	try {
		await accountManager.loadPiAuth({
			shouldApply: () => isStartupCurrent(rotationContext),
		});
		if (!isStartupCurrent(rotationContext)) return;
		// Pi auth is ephemeral, so it only appears after loadPiAuth runs.
		if (accountManager.getAccounts().length === 0) return;

		await accountManager.refreshUsageForAllAccounts(
			warningHandler ? { force: true, warningHandler } : { force: true },
		);
		if (!isStartupCurrent(rotationContext)) return;

		const needsReauth = accountManager.getAccountsNeedingReauth();
		if (needsReauth.length > 0) {
			const hints = needsReauth.map(
				(a) => `${a.email} (/multicodex use ${a.email})`,
			);
			warningHandler?.(
				`Multicodex: ${needsReauth.length} account(s) need re-authentication: ${hints.join(", ")}`,
			);
		}

		const manual = accountManager.getAvailableManualAccount();
		if (manual) return;
		if (!isStartupCurrent(rotationContext)) return;
		if (accountManager.hasManualAccount()) {
			accountManager.clearManualAccount();
		}
		if (!isStartupCurrent(rotationContext)) return;
		await accountManager.activateBestAccount({
			cacheAffinity: getStartupCacheAffinity(rotationContext),
			shouldApply: () => isStartupCurrent(rotationContext),
			...(warningHandler ? { warningHandler } : {}),
		});
	} finally {
		accountManager.markReady(initializationToken);
	}
}

export async function handleSessionStart(
	accountManager: AccountManager,
	warningHandler?: WarningHandler,
	rotationContext?: StartupRotationContext,
): Promise<void> {
	try {
		await refreshAndActivateBestAccount(
			accountManager,
			warningHandler,
			rotationContext,
		);
	} catch {
		// Startup refresh is best-effort; session still needs to come up.
	}
}

export async function handleNewSessionSwitch(
	accountManager: AccountManager,
	warningHandler?: WarningHandler,
	rotationContext?: StartupRotationContext,
): Promise<void> {
	try {
		await refreshAndActivateBestAccount(
			accountManager,
			warningHandler,
			rotationContext,
		);
	} catch {
		// Startup refresh is best-effort; session still needs to come up.
	}
}
