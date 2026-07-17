import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export function getOpenAICodexProvider() {
	const provider = builtinProviders().find(
		(candidate) => candidate.id === OPENAI_CODEX_PROVIDER_ID,
	);
	if (!provider) {
		throw new Error("OpenAI Codex is unavailable in this version of pi.");
	}
	return provider;
}
