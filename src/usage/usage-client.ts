import { createLinkedAbortController } from "./abort-utils";
import { UsageAuthenticationError } from "./coordination/contracts";
import { type CodexUsageSnapshot, parseCodexUsageResponse } from "./usage";

interface WhamUsageResponse {
	plan_type?: string;
	rate_limit?: {
		primary_window?: WhamUsageWindow | null;
		secondary_window?: WhamUsageWindow | null;
	};
}

interface WhamUsageWindow {
	allowed?: boolean;
	limit_reached?: boolean;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
	used_percent?: number;
}

export class CodexUsageRequestTimeoutError extends Error {
	override readonly name = "CodexUsageRequestTimeoutError";
}

export async function fetchCodexUsage(
	accessToken: string,
	accountId: string | undefined,
	options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CodexUsageSnapshot> {
	const controller = createLinkedAbortController(options?.signal);
	const timeoutMs = options?.timeoutMs ?? 10_000;
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	timeout.unref?.();

	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		};
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId;
		}

		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers,
			signal: controller.signal,
		});

		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new UsageAuthenticationError(
					`Usage request authentication failed: ${response.status}`,
				);
			}
			throw new Error(`Usage request failed: ${response.status}`);
		}

		const data = (await response.json()) as WhamUsageResponse;
		return { ...parseCodexUsageResponse(data), fetchedAt: Date.now() };
	} catch (error) {
		if (timedOut) {
			throw new CodexUsageRequestTimeoutError(
				`Usage request timed out after ${timeoutMs}ms.`,
				{ cause: error },
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}
