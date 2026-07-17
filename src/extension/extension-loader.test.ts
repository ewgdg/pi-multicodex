import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const loaderUrl = new URL(
	"../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
	import.meta.url,
).href;

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-multicodex-extension-loader-"));
	roots.push(root);
	return root;
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
});
