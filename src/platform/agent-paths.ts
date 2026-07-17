import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function getAgentPath(...segments: string[]): string {
	return join(getAgentDir(), ...segments);
}

export function getAgentSettingsPath(): string {
	return getAgentPath("settings.json");
}

export function getAgentAuthPath(): string {
	return getAgentPath("auth.json");
}

export function ensureParentDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o755 });
	}
}

export async function ensureParentDirAsync(filePath: string): Promise<void> {
	const dir = dirname(filePath);
	try {
		await stat(dir);
	} catch {
		await mkdir(dir, { recursive: true, mode: 0o755 });
	}
}

export function readJsonObjectFile(filePath: string): Record<string, unknown> {
	try {
		if (!existsSync(filePath)) {
			return {};
		}
		const raw = readFileSync(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

export function writeJsonObjectFile(
	filePath: string,
	data: Record<string, unknown>,
): void {
	ensureParentDir(filePath);
	writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function readJsonObjectFileAsync(
	filePath: string,
): Promise<Record<string, unknown>> {
	try {
		const stats = await stat(filePath).catch(() => undefined);
		if (!stats) {
			return {};
		}
		const raw = await readFile(filePath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

export async function writeJsonObjectFileAsync(
	filePath: string,
	data: Record<string, unknown>,
): Promise<void> {
	await ensureParentDirAsync(filePath);
	await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}
