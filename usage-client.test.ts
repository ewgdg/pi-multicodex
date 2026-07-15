import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexUsageRequestTimeoutError, fetchCodexUsage } from "./usage-client";
import { UsageAuthenticationError } from "./usage-coordination/index";

function abortingFetch(): typeof fetch {
	return vi.fn(
		(_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			}),
	) as unknown as typeof fetch;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("fetchCodexUsage cancellation classification", () => {
	it("classifies usage endpoint 401 and 403 responses as authentication failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(new Response(null, { status: 401 }))
				.mockResolvedValueOnce(new Response(null, { status: 403 })),
		);

		await expect(fetchCodexUsage("token", undefined)).rejects.toBeInstanceOf(
			UsageAuthenticationError,
		);
		await expect(fetchCodexUsage("token", undefined)).rejects.toBeInstanceOf(
			UsageAuthenticationError,
		);
	});

	it("reports its request deadline as a network timeout", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", abortingFetch());

		const request = fetchCodexUsage("token", undefined, { timeoutMs: 100 });
		const rejection = expect(request).rejects.toBeInstanceOf(
			CodexUsageRequestTimeoutError,
		);
		await vi.advanceTimersByTimeAsync(100);

		await rejection;
	});

	it("preserves caller cancellation as AbortError", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", abortingFetch());
		const controller = new AbortController();

		const request = fetchCodexUsage("token", undefined, {
			signal: controller.signal,
			timeoutMs: 100,
		});
		controller.abort();

		await expect(request).rejects.toMatchObject({ name: "AbortError" });
	});
});
