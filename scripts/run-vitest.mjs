#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((arg) => arg !== "--runInBand");
const result = spawnSync("vitest", ["run", "-c", "vitest.config.ts", ...args], {
	stdio: "inherit",
	shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
