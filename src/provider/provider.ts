import type { AccountManager } from "../accounts/account-manager";
import {
	getOpenAICodexProvider,
	OPENAI_CODEX_PROVIDER_ID,
} from "./codex-provider";
import { createStreamWrapper } from "./stream-wrapper";

export const PROVIDER_ID = OPENAI_CODEX_PROVIDER_ID;

type CodexBaseProvider = Parameters<typeof createStreamWrapper>[1];
type CodexStreamSimple = CodexBaseProvider["streamSimple"];
type MulticodexStreamMetadata = {
	baseStreamSimple: CodexStreamSimple | undefined;
};

const MULTICODEX_STREAM_METADATA = Symbol.for(
	"@ewgdg/pi-multicodex/stream-metadata/v1",
);

function getMulticodexStreamMetadata(
	streamSimple: CodexStreamSimple,
): MulticodexStreamMetadata | undefined {
	return (
		streamSimple as unknown as Record<
			symbol,
			MulticodexStreamMetadata | undefined
		>
	)[MULTICODEX_STREAM_METADATA];
}

function unwrapMulticodexStream(
	streamSimple: CodexStreamSimple | undefined,
): CodexStreamSimple | undefined {
	let current = streamSimple;
	const visited = new Set<CodexStreamSimple>();
	while (current) {
		if (visited.has(current)) {
			throw new Error("Multicodex provider wrapper metadata contains a cycle");
		}
		visited.add(current);
		const metadata = getMulticodexStreamMetadata(current);
		if (!metadata) return current;
		current = metadata.baseStreamSimple;
	}
	return undefined;
}

function markMulticodexStream<T extends CodexStreamSimple>(
	streamSimple: T,
	baseStreamSimple: CodexStreamSimple | undefined,
): T {
	Object.defineProperty(streamSimple, MULTICODEX_STREAM_METADATA, {
		value: { baseStreamSimple } satisfies MulticodexStreamMetadata,
	});
	return streamSimple;
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

export function buildMulticodexProviderConfig(
	accountManager: AccountManager,
	baseStreamSimple?: CodexBaseProvider["streamSimple"],
) {
	const unwrappedBaseStreamSimple = unwrapMulticodexStream(baseStreamSimple);
	const codexProvider = unwrappedBaseStreamSimple
		? { streamSimple: unwrappedBaseStreamSimple }
		: getOpenAICodexProvider();
	return {
		...buildMulticodexProviderBootstrapConfig(accountManager),
		streamSimple: markMulticodexStream(
			createStreamWrapper(accountManager, codexProvider),
			unwrappedBaseStreamSimple,
		),
	};
}

export function buildMulticodexProviderBootstrapConfig(
	accountManager: AccountManager,
) {
	return {
		apiKey: getActiveApiKey(accountManager),
		api: "openai-codex-responses" as const,
	};
}
