import type { AccountManager } from "../accounts/account-manager";
import {
	getOpenAICodexProvider,
	OPENAI_CODEX_PROVIDER_ID,
} from "./codex-provider";
import { createStreamWrapper } from "./stream-wrapper";

export const PROVIDER_ID = OPENAI_CODEX_PROVIDER_ID;

function getActiveApiKey(accountManager: AccountManager): string {
	const active = accountManager.getActiveAccount();
	if (active && !active.needsReauth) {
		return active.accessToken;
	}
	// Fallback: first available account with a valid token.
	for (const account of accountManager.getAccounts()) {
		if (!account.needsReauth && account.accessToken) {
			return account.accessToken;
		}
	}
	// Fallback placeholder until MultiCodex resolves a usable managed account.
	return "pending-login";
}

export function buildMulticodexProviderConfig(accountManager: AccountManager) {
	const codexProvider = getOpenAICodexProvider();
	return {
		apiKey: getActiveApiKey(accountManager),
		api: "openai-codex-responses" as const,
		streamSimple: createStreamWrapper(accountManager, codexProvider),
	};
}
