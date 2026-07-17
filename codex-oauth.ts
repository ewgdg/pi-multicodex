import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

function getOpenAICodexOAuth() {
	const oauth = openaiCodexProvider().auth.oauth;
	if (!oauth) {
		throw new Error("OpenAI Codex OAuth is unavailable in this version of pi.");
	}
	return oauth;
}

export function loginOpenAICodex(
	interaction: Parameters<ReturnType<typeof getOpenAICodexOAuth>["login"]>[0],
) {
	return getOpenAICodexOAuth().login(interaction);
}

export function refreshOpenAICodexToken(refreshToken: string) {
	return getOpenAICodexOAuth().refresh({
		type: "oauth",
		access: "",
		refresh: refreshToken,
		expires: 0,
	});
}
