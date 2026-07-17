import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AccountManager } from "./account-manager";
import {
	getOpenAICodexProvider,
	OPENAI_CODEX_PROVIDER_ID,
} from "./codex-provider";
import { createStreamWrapper } from "./stream-wrapper";

export const PROVIDER_ID = OPENAI_CODEX_PROVIDER_ID;

export type ProviderModelDef = ProviderModelConfig;

export function getOpenAICodexMirror(): {
	baseUrl: string;
	models: ProviderModelConfig[];
} {
	const sourceModels = getBuiltinModels("openai-codex");
	return {
		baseUrl: sourceModels[0]?.baseUrl ?? "https://chatgpt.com/backend-api",
		models: sourceModels.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			baseUrl: m.baseUrl,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap
				? { ...m.thinkingLevelMap }
				: undefined,
			input: [...m.input],
			cost: { ...m.cost },
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			headers: m.headers ? { ...m.headers } : undefined,
			compat: m.compat,
		})),
	};
}

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
	const mirror = getOpenAICodexMirror();
	const codexProvider = getOpenAICodexProvider();
	return {
		baseUrl: mirror.baseUrl,
		apiKey: getActiveApiKey(accountManager),
		api: "openai-codex-responses" as const,
		streamSimple: createStreamWrapper(accountManager, codexProvider),
		models: mirror.models,
	};
}
