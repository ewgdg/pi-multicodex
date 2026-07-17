import { type FSWatcher, watch, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loadImportedOpenAICodexAuth,
	parseImportedOpenAICodexAuth,
	watchImportedOpenAICodexAuth,
} from "./auth";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-multicodex-auth-"));
	temporaryDirectories.push(directory);
	return directory;
}

function waitForFileEvent(
	directory: string,
	expectedFilename: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let watcher: FSWatcher;
		watcher = watch(
			directory,
			{ persistent: false },
			(_eventType, filename) => {
				if (filename && filename.toString() !== expectedFilename) return;
				watcher.close();
				resolve();
			},
		);
		watcher.on("error", (error) => {
			watcher.close();
			reject(error);
		});
		watcher.unref();
	});
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("parseImportedOpenAICodexAuth", () => {
	it("prefers the email embedded in the access token profile", () => {
		const header = Buffer.from(
			JSON.stringify({ alg: "none", typ: "JWT" }),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/profile": {
					email: "victor.araujo105@gmail.com",
				},
			}),
		).toString("base64url");
		const accessToken = `${header}.${payload}.sig`;
		const parsed = parseImportedOpenAICodexAuth({
			"openai-codex": {
				type: "oauth",
				access: accessToken,
				refresh: "refresh-token",
				expires: 123,
				accountId: "acct-1234567890",
			},
		});

		expect(parsed).toEqual({
			identifier: "victor.araujo105@gmail.com",
			fingerprint: JSON.stringify({
				access: accessToken,
				refresh: "refresh-token",
				expires: 123,
				accountId: "acct-1234567890",
			}),
			credentials: {
				access: accessToken,
				refresh: "refresh-token",
				expires: 123,
				accountId: "acct-1234567890",
			},
		});
	});

	it("falls back to the account-id label when email cannot be derived", () => {
		const parsed = parseImportedOpenAICodexAuth({
			"openai-codex": {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: 123,
				accountId: "acct-1234567890",
			},
		});

		expect(parsed).toEqual({
			identifier: "OpenAI Codex acct-123",
			fingerprint: JSON.stringify({
				access: "access-token",
				refresh: "refresh-token",
				expires: 123,
				accountId: "acct-1234567890",
			}),
			credentials: {
				access: "access-token",
				refresh: "refresh-token",
				expires: 123,
				accountId: "acct-1234567890",
			},
		});
	});

	it("returns undefined for missing or invalid oauth data", () => {
		expect(parseImportedOpenAICodexAuth({})).toBeUndefined();
		expect(
			parseImportedOpenAICodexAuth({
				"openai-codex": { type: "oauth", access: "", refresh: "x", expires: 1 },
			}),
		).toBeUndefined();
		expect(
			parseImportedOpenAICodexAuth({
				"openai-codex": {
					type: "api-key",
					access: "x",
					refresh: "y",
					expires: 1,
				},
			}),
		).toBeUndefined();
	});
});

describe("auth file watcher", () => {
	it("ignores settings-only writes", async () => {
		vi.useFakeTimers();
		const directory = await createTemporaryDirectory();
		const authFile = join(directory, "auth.json");
		const onChange = vi.fn();
		const dispose = watchImportedOpenAICodexAuth(onChange, { authFile });
		const settingsEvent = waitForFileEvent(directory, "settings.json");

		writeFileSync(join(directory, "settings.json"), "{}");
		await settingsEvent;
		vi.runAllTimers();

		expect(onChange).not.toHaveBeenCalled();
		dispose();
	});

	it("debounces rapid auth writes and filters other files", async () => {
		vi.useFakeTimers();
		const directory = await createTemporaryDirectory();
		const authFile = join(directory, "auth.json");
		const onChange = vi.fn();
		const dispose = watchImportedOpenAICodexAuth(onChange, { authFile });
		const authEvent = waitForFileEvent(directory, "auth.json");

		writeFileSync(join(directory, "settings.json"), "{}");
		writeFileSync(authFile, "{}");
		writeFileSync(authFile, '{"openai-codex": null}');
		writeFileSync(authFile, "{}");

		await authEvent;
		vi.runAllTimers();

		expect(onChange).toHaveBeenCalledOnce();
		dispose();
	});

	it("disposal prevents callbacks from later auth writes", async () => {
		vi.useFakeTimers();
		const directory = await createTemporaryDirectory();
		const authFile = join(directory, "auth.json");
		const onChange = vi.fn();
		const dispose = watchImportedOpenAICodexAuth(onChange, { authFile });
		dispose();
		const authEvent = waitForFileEvent(directory, "auth.json");

		writeFileSync(authFile, "{}");
		await authEvent;
		vi.runAllTimers();

		expect(onChange).not.toHaveBeenCalled();
	});

	it("recovers when a missing nested auth directory is created", async () => {
		const directory = await createTemporaryDirectory();
		const authFile = join(directory, "missing", "nested", "auth.json");
		const onChange = vi.fn();
		let dispose: (() => void) | undefined;
		const changed = new Promise<void>((resolve) => {
			dispose = watchImportedOpenAICodexAuth(
				() => {
					onChange();
					resolve();
				},
				{ authFile },
			);
		});

		expect(dispose).toEqual(expect.any(Function));
		await mkdir(join(directory, "missing", "nested"), { recursive: true });
		writeFileSync(authFile, "{}");

		await changed;
		expect(onChange).toHaveBeenCalledOnce();
		dispose?.();
	});

	it("loads auth from an injected filesystem path", async () => {
		const directory = await createTemporaryDirectory();
		const authFile = join(directory, "auth.json");
		await mkdir(directory, { recursive: true });
		writeFileSync(
			authFile,
			JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: "access-token",
					refresh: "refresh-token",
					expires: 123,
				},
			}),
		);

		expect(await loadImportedOpenAICodexAuth({ authFile })).toMatchObject({
			identifier: "OpenAI Codex default",
		});
	});

	it("keeps a missing auth file as no imported auth for watcher loads", async () => {
		const directory = await createTemporaryDirectory();
		const authFile = join(directory, "missing-auth.json");

		await expect(
			loadImportedOpenAICodexAuth({
				authFile,
				throwOnNonEnoentError: true,
			}),
		).resolves.toBeUndefined();
	});

	it("only throws malformed auth for watcher loads", async () => {
		const directory = await createTemporaryDirectory();
		const authFile = join(directory, "auth.json");
		writeFileSync(authFile, "{ malformed");

		await expect(
			loadImportedOpenAICodexAuth({ authFile }),
		).resolves.toBeUndefined();
		await expect(
			loadImportedOpenAICodexAuth({
				authFile,
				throwOnNonEnoentError: true,
			}),
		).rejects.toThrow(SyntaxError);
	});

	it("reports watcher setup errors when no usable ancestor exists", async () => {
		const directory = await createTemporaryDirectory();
		const blocker = join(directory, "not-a-directory");
		writeFileSync(blocker, "");
		const onError = vi.fn();
		const dispose = watchImportedOpenAICodexAuth(vi.fn(), {
			authFile: join(blocker, "missing", "auth.json"),
			onError,
		});

		expect(onError).toHaveBeenCalledOnce();
		expect(dispose).toBeUndefined();
	});
});
