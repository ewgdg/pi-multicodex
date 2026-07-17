import {
	existsSync,
	type FSWatcher,
	promises as fs,
	statSync,
	watch,
} from "node:fs";
import path from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { getAgentAuthPath } from "../platform/agent-paths";

const AUTH_CHANGE_DEBOUNCE_MS = 50;
const IMPORTED_ACCOUNT_PREFIX = "OpenAI Codex";

interface AuthEntry {
	type?: string;
	access?: string | null;
	refresh?: string | null;
	expires?: number | null;
	accountId?: string | null;
	account_id?: string | null;
}

export interface ImportedOpenAICodexAuth {
	identifier: string;
	fingerprint: string;
	credentials: OAuthCredentials;
}

export interface LoadImportedOpenAICodexAuthOptions {
	authFile?: string;
	throwOnNonEnoentError?: boolean;
}

export interface WatchImportedOpenAICodexAuthOptions {
	authFile?: string;
	onError?: (error: unknown) => void;
}

function isEnoentError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function asAuthEntry(value: unknown): AuthEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as AuthEntry;
}

function getAccountId(entry: AuthEntry): string | undefined {
	const accountId = entry.accountId ?? entry.account_id;
	return typeof accountId === "string" && accountId.trim()
		? accountId.trim()
		: undefined;
}

function getRequiredString(
	value: string | null | undefined,
): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			"=",
		);
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(decoded) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function getProfileEmail(accessToken: string): string | undefined {
	const payload = decodeJwtPayload(accessToken);
	const profile = payload?.["https://api.openai.com/profile"];
	if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
		return undefined;
	}
	const email = (profile as Record<string, unknown>).email;
	return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

function createImportedIdentifier(
	accessToken: string,
	accountId: string,
): string {
	const email = getProfileEmail(accessToken);
	if (email) return email;
	return `${IMPORTED_ACCOUNT_PREFIX} ${accountId.slice(0, 8)}`;
}

function createFingerprint(entry: {
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
}): string {
	return JSON.stringify({
		access: entry.access,
		refresh: entry.refresh,
		expires: entry.expires,
		accountId: entry.accountId ?? null,
	});
}

export function parseImportedOpenAICodexAuth(
	auth: Record<string, unknown>,
): ImportedOpenAICodexAuth | undefined {
	const entry = asAuthEntry(auth["openai-codex"]);
	if (entry?.type !== "oauth") return undefined;

	const access = getRequiredString(entry.access);
	const refresh = getRequiredString(entry.refresh);
	const accountId = getAccountId(entry);
	const expires = entry.expires;
	if (!access || !refresh || typeof expires !== "number") {
		return undefined;
	}

	const credentials: OAuthCredentials = {
		access,
		refresh,
		expires,
		accountId,
	};
	return {
		identifier: createImportedIdentifier(access, accountId ?? "default"),
		fingerprint: createFingerprint({ access, refresh, expires, accountId }),
		credentials,
	};
}

export async function loadImportedOpenAICodexAuth(
	options?: LoadImportedOpenAICodexAuthOptions,
): Promise<ImportedOpenAICodexAuth | undefined> {
	const authFile = options?.authFile ?? getAgentAuthPath();
	try {
		const raw = await fs.readFile(authFile, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parseImportedOpenAICodexAuth(parsed as Record<string, unknown>);
	} catch (error) {
		if (options?.throwOnNonEnoentError && !isEnoentError(error)) {
			throw error;
		}
		// Missing or invalid auth is normal during startup and file replacement.
		return undefined;
	}
}

export function watchImportedOpenAICodexAuth(
	onChange: () => void,
	options?: WatchImportedOpenAICodexAuthOptions,
): (() => void) | undefined {
	const authFile = options?.authFile ?? getAgentAuthPath();
	const authDirectory = path.dirname(authFile);
	const authFilename = path.basename(authFile);
	let watcher: FSWatcher | undefined;
	let watchedDirectory: string | undefined;
	let watchingTarget = false;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const closeCurrentWatcher = (): void => {
		const currentWatcher = watcher;
		watcher = undefined;
		watchedDirectory = undefined;
		watchingTarget = false;
		currentWatcher?.close();
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = undefined;
		closeCurrentWatcher();
	};

	const reportError = (error: unknown): void => {
		if (disposed) return;
		dispose();
		options?.onError?.(error);
	};

	const scheduleChange = (): void => {
		if (disposed) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			if (!disposed) onChange();
		}, AUTH_CHANGE_DEBOUNCE_MS);
		debounceTimer.unref?.();
	};

	const findNearestExistingAncestor = (): string | undefined => {
		let current = path.resolve(authDirectory);
		while (true) {
			try {
				return statSync(current).isDirectory() ? current : undefined;
			} catch (error) {
				if (!isEnoentError(error)) throw error;
				const parent = path.dirname(current);
				if (parent === current) return undefined;
				current = parent;
			}
		}
	};

	const installWatcher = (
		nextWatcher: FSWatcher,
		directory: string,
		target: boolean,
	): void => {
		watcher = nextWatcher;
		watchedDirectory = directory;
		watchingTarget = target;
		nextWatcher.on("error", (error) => {
			if (watcher === nextWatcher) reportError(error);
		});
		nextWatcher.unref();
	};

	const watchAncestor = (ancestor: string): void => {
		if (!watchingTarget && watcher && watchedDirectory === ancestor) {
			return;
		}

		let nextWatcher: FSWatcher;
		try {
			nextWatcher = watch(ancestor, { persistent: false }, () => {
				if (!disposed) tryBindTarget(true);
			});
		} catch (error) {
			reportError(error);
			return;
		}

		closeCurrentWatcher();
		installWatcher(nextWatcher, ancestor, false);
	};

	function tryBindTarget(recovering: boolean): void {
		if (disposed) return;

		let nextWatcher: FSWatcher;
		try {
			nextWatcher = watch(
				authDirectory,
				{ persistent: false },
				(_eventType, filename) => {
					if (filename && filename.toString() !== authFilename) return;
					scheduleChange();
				},
			);
		} catch (error) {
			if (!isEnoentError(error)) {
				reportError(error);
				return;
			}

			let ancestor: string | undefined;
			try {
				ancestor = findNearestExistingAncestor();
			} catch (ancestorError) {
				reportError(ancestorError);
				return;
			}
			if (!ancestor) {
				reportError(error);
				return;
			}
			watchAncestor(ancestor);
			return;
		}

		closeCurrentWatcher();
		installWatcher(nextWatcher, authDirectory, true);
		if (recovering && existsSync(authFile)) scheduleChange();
	}

	tryBindTarget(false);
	if (disposed) return undefined;
	return dispose;
}
