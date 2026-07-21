import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const cliPath = fileURLToPath(
	new URL(
		"../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		import.meta.url,
	),
);
const execFileAsync = promisify(execFile);
const targetModelId = "gpt-5.6-sol";
const persistedContextWindow = 246_000;
const loaderUrl = new URL(
	"../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
	import.meta.url,
).href;

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-multicodex-extension-loader-"));
	roots.push(root);
	return root;
}

async function seedPersistedModelCatalog(root: string): Promise<void> {
	const model = getBuiltinModels("openai-codex").find(
		(candidate) => candidate.id === targetModelId,
	);
	if (!model) throw new Error(`Missing ${targetModelId} test fixture`);

	const agentDirectory = join(root, "agent");
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(
		join(agentDirectory, "models-store.json"),
		JSON.stringify({
			"openai-codex": {
				models: [{ ...model, contextWindow: persistedContextWindow }],
				checkedAt: Date.now(),
			},
		}),
	);
	await writeFile(
		join(agentDirectory, "auth.json"),
		JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: "test-access",
				refresh: "test-refresh",
				expires: 9_999_999_999_999,
				accountId: "test-account",
			},
		}),
	);
}

async function listTargetModelContext(
	root: string,
	loadMulticodex: boolean,
): Promise<string> {
	const args = [cliPath, "--no-extensions"];
	if (loadMulticodex) args.push("--extension", extensionPath);
	args.push("--list-models", targetModelId);

	const { stdout } = await execFileAsync(process.execPath, args, {
		cwd: root,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PI_OFFLINE: "1",
		},
	});
	const modelLine = stdout
		.split(/\r?\n/u)
		.find((line) =>
			line.trimStart().startsWith(`openai-codex  ${targetModelId}`),
		);
	if (!modelLine) throw new Error(`Missing ${targetModelId} in:\n${stdout}`);
	const context = modelLine.trim().split(/\s+/u)[2];
	if (!context) throw new Error(`Missing context column in:\n${modelLine}`);
	return context;
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("Pi extension loading", () => {
	it("loads the published entry through Pi's extension loader", async () => {
		const root = await temporaryRoot();
		const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");

		try {
			// Vitest resolves package exports normally; use Pi's loader to cover its alias map.
			const { loadExtensions } = await import(loaderUrl);
			const result = await loadExtensions([extensionPath], root);

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		} finally {
			if (previousAgentDirectory === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
			}
		}
	});

	it("preserves Pi's persisted model metadata when composing the provider", async () => {
		const root = await temporaryRoot();
		await seedPersistedModelCatalog(root);

		const baseContext = await listTargetModelContext(root, false);
		const multicodexContext = await listTargetModelContext(root, true);

		expect(baseContext).toBe("246K");
		expect(multicodexContext).toBe(baseContext);
	});
});
