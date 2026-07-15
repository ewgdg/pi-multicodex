import { describe, expect, it, vi } from "vitest";
import type { CodexUsageSnapshot } from "./usage";
import {
	createInMemoryUsageCoordination,
	deriveManagedAccountDigest,
	normalizeManagedAccountIdentity,
	PRODUCTION_USAGE_COORDINATION_POLICY,
	parseSharedUsageState,
	type SharedUsageState,
	UsageAuthenticationError,
} from "./usage-coordination/index";

const snapshot = (fetchedAt: number, usedPercent = 10): CodexUsageSnapshot => ({
	primary: { usedPercent },
	fetchedAt,
});

describe("shared usage coordination pure contracts", () => {
	it("normalizes managed identity and derives a full credential-free digest", () => {
		expect(normalizeManagedAccountIdentity("  Person@Example.COM ")).toBe(
			"person@example.com",
		);
		expect(deriveManagedAccountDigest("  Person@Example.COM ")).toBe(
			"542d240129883c019e106e3b1b2d3f3cb3537c43c425364de8e951d5a3083345",
		);
	});

	it("validates known state fields and preserves unknown additive fields", () => {
		const state = {
			futureMetadata: { preserved: true },
			snapshot: {
				primary: { usedPercent: 25, futureWindowField: "kept" },
				fetchedAt: 100,
				attemptToken: "attempt-1",
			},
			pendingInvalidation: { token: "dirty-1", recordedAt: 101 },
			lastRefresh: {
				token: "attempt-1",
				startedAt: 90,
				completedAt: 100,
				outcome: "success",
			},
			retryNotBefore: 200,
		};

		const parsed = parseSharedUsageState(
			Buffer.from(JSON.stringify(state)),
			PRODUCTION_USAGE_COORDINATION_POLICY,
		);

		expect(parsed.status).toBe("valid");
		expect(parsed.state).toEqual(state);
		expect(parsed.state?.futureMetadata).toEqual({ preserved: true });
	});

	it("rejects malformed known fields and oversized state before parsing", () => {
		const malformed = parseSharedUsageState(
			Buffer.from(JSON.stringify({ snapshot: { fetchedAt: "now" } })),
			PRODUCTION_USAGE_COORDINATION_POLICY,
		);
		expect(malformed.status).toBe("malformed");

		const oversized = parseSharedUsageState(
			Buffer.alloc(
				PRODUCTION_USAGE_COORDINATION_POLICY.maxStateBytes + 1,
				0x20,
			),
			PRODUCTION_USAGE_COORDINATION_POLICY,
		);
		expect(oversized.status).toBe("oversized");
	});
});

describe("in-memory shared usage coordination", () => {
	it("returns a fresh snapshot without calling the network", async () => {
		let now = 1_000;
		const coordination = createInMemoryUsageCoordination({ now: () => now });
		const fetcher = vi.fn(async () => snapshot(now, 30));

		const first = await coordination.refresh("person@example.com", fetcher);
		expect(first).toMatchObject({
			availability: "fresh",
			source: "owned-fetch",
			snapshot: { fetchedAt: 1_000 },
		});

		now += 10_000;
		const second = await coordination.refresh("PERSON@example.com", fetcher);
		expect(second).toMatchObject({
			availability: "fresh",
			source: "existing-fresh",
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("normally coalesces compatible work and lets forced work join automatic work", async () => {
		const coordination = createInMemoryUsageCoordination();
		let release!: (value: CodexUsageSnapshot) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					release = resolve;
				}),
		);

		const automatic = coordination.refresh("person@example.com", fetcher);
		const forced = coordination.refresh("person@example.com", fetcher, {
			force: true,
		});
		expect(fetcher).toHaveBeenCalledOnce();
		release(snapshot(Date.now(), 40));

		const [owned, joined] = await Promise.all([automatic, forced]);
		expect(owned.source).toBe("owned-fetch");
		expect(joined.source).toBe("joined-work");
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("clears only the invalidation captured before a successful fetch", async () => {
		let tokenIndex = 0;
		const coordination = createInMemoryUsageCoordination({
			token: () => `token-${++tokenIndex}`,
		});
		await coordination.invalidate("person@example.com");
		let release!: (value: CodexUsageSnapshot) => void;
		const refresh = coordination.refresh(
			"person@example.com",
			() =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					release = resolve;
				}),
		);
		await coordination.invalidate("person@example.com");
		release(snapshot(Date.now()));
		await refresh;

		const view = await coordination.read("person@example.com");
		expect(view.pendingInvalidation?.token).toBe("token-3");
	});

	it("preserves stale data and suppresses automatic retry after network failure", async () => {
		let now = 0;
		const coordination = createInMemoryUsageCoordination({ now: () => now });
		await coordination.refresh("person@example.com", async () => snapshot(now));
		now = PRODUCTION_USAGE_COORDINATION_POLICY.freshnessIntervalMs + 1;
		const failure = await coordination.refresh(
			"person@example.com",
			async () => {
				throw new Error("network down");
			},
			{ force: true },
		);
		expect(failure).toMatchObject({
			availability: "stale",
			source: "failure",
			error: expect.any(Error),
		});

		const fetcher = vi.fn(async () => snapshot(now, 50));
		const suppressed = await coordination.refresh(
			"person@example.com",
			fetcher,
		);
		expect(suppressed).toMatchObject({
			availability: "stale",
			source: "retry-suppressed",
		});
		expect(fetcher).not.toHaveBeenCalled();

		const forced = await coordination.refresh("person@example.com", fetcher, {
			force: true,
		});
		expect(forced).toMatchObject({
			availability: "fresh",
			source: "owned-fetch",
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("does not publish retry suppression for authentication failure", async () => {
		let now = 0;
		const coordination = createInMemoryUsageCoordination({ now: () => now });
		const failed = await coordination.refresh(
			"person@example.com",
			async () => {
				throw new UsageAuthenticationError("expired credentials");
			},
		);
		expect(failed.source).toBe("failure");
		now += 1;

		const fetcher = vi.fn(async () => snapshot(now));
		await coordination.refresh("person@example.com", fetcher);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("preserves unknown state fields across invalidation mutations", async () => {
		const coordination = createInMemoryUsageCoordination();
		coordination.seedStateForTests("person@example.com", {
			futureMetadata: { preserved: true },
		} satisfies SharedUsageState);

		await coordination.invalidate("person@example.com");

		expect(
			coordination.getStateForTests("person@example.com")?.futureMetadata,
		).toEqual({ preserved: true });
	});
});
