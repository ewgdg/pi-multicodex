import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexUsageSnapshot } from "./usage";
import {
	UsageAuthenticationError,
	UsageCoordinationCancellationError,
} from "./usage-coordination/contracts";
import {
	createFilesystemUsageCoordination,
	type FilesystemUsageCoordination,
} from "./usage-coordination/filesystem";
import { deriveManagedAccountDigest } from "./usage-coordination/identity";
import {
	PRODUCTION_USAGE_COORDINATION_POLICY,
	type UsageCoordinationPolicy,
} from "./usage-coordination/policy";

const instances: FilesystemUsageCoordination[] = [];
const roots: string[] = [];

function policy(
	overrides: Partial<UsageCoordinationPolicy> = {},
): UsageCoordinationPolicy {
	return {
		...PRODUCTION_USAGE_COORDINATION_POLICY,
		usageRequestTimeoutMs: 2_000,
		stateWriteLeaseMs: 500,
		refreshLeaseMs: 1_000,
		leaseInitializationGraceMs: 20,
		stateWriteAcquisitionTimeoutMs: 1_000,
		refreshJoinPollMs: 5,
		publicationRetryDelaysMs: [1, 2],
		watchDebounceMs: 5,
		debrisGraceMs: 20,
		...overrides,
	};
}

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-multicodex-usage-"));
	roots.push(root);
	return root;
}

function coordination(
	root: string,
	options: Omit<
		ConstructorParameters<typeof FilesystemUsageCoordination>[0],
		"root"
	> = {},
): FilesystemUsageCoordination {
	const instance = createFilesystemUsageCoordination({ root, ...options });
	instances.push(instance);
	return instance;
}

function snapshot(fetchedAt: number, usedPercent = 10): CodexUsageSnapshot {
	return { primary: { usedPercent }, fetchedAt };
}

function fakeWatcher(): FSWatcher {
	const watcher = new EventEmitter() as FSWatcher;
	watcher.close = vi.fn();
	return watcher;
}

async function waitUntil(
	assertion: () => void | Promise<void>,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			await assertion();
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

afterEach(async () => {
	for (const instance of instances.splice(0)) instance.dispose();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("filesystem shared usage coordination", () => {
	it("uses only the full identity digest in paths and returns a fresh canonical read", async () => {
		const root = await temporaryRoot();
		const adapter = coordination(root);
		const email = "  Private.Person@Example.COM ";
		const now = Date.now();

		const refreshed = await adapter.refresh(email, async () =>
			snapshot(now, 37),
		);
		expect(refreshed).toMatchObject({
			availability: "fresh",
			source: "owned-fetch",
			snapshot: { primary: { usedPercent: 37 }, fetchedAt: now },
		});
		expect(await adapter.read("private.person@example.com")).toMatchObject({
			status: "valid",
			snapshot: { primary: { usedPercent: 37 }, fetchedAt: now },
		});

		const digest = deriveManagedAccountDigest(email);
		expect(await readdir(root)).toEqual([digest]);
		expect(digest).toHaveLength(64);
		const canonical = await readFile(join(root, digest, "state.json"), "utf8");
		expect(canonical.toLowerCase()).not.toContain("private.person@example.com");
		expect(canonical).not.toMatch(/Bearer|access-token|refresh-token/i);
		expect((await readdir(join(root, digest))).sort()).toEqual(["state.json"]);
	});

	it("preserves unknown canonical fields across read-merge-publish mutations", async () => {
		const root = await temporaryRoot();
		const adapter = coordination(root, { policy: policy() });
		await adapter.refresh("person@example.com", async () =>
			snapshot(Date.now()),
		);
		const statePath = join(
			root,
			deriveManagedAccountDigest("person@example.com"),
			"state.json",
		);
		const state = JSON.parse(await readFile(statePath, "utf8"));
		state.futureMetadata = { preserved: true };
		await writeFile(statePath, JSON.stringify(state), "utf8");

		await adapter.invalidate("person@example.com");

		const updated = JSON.parse(await readFile(statePath, "utf8"));
		expect(updated.futureMetadata).toEqual({ preserved: true });
	});

	it("recovers stale state-write and refresh leases with additive fields by quarantine", async () => {
		const root = await temporaryRoot();
		const now = 10_000;
		const adapter = coordination(root, { now: () => now, policy: policy() });
		const scope = join(root, deriveManagedAccountDigest("person@example.com"));
		await mkdir(scope, { recursive: true });
		const staleLease = {
			token: "stale-owner",
			acquiredAt: now - 100,
			expiresAt: now - 1,
			futureLeaseMetadata: { allowed: true },
		};
		const futureMtime = new Date(now + 60_000);
		const stateWriteLeasePath = join(scope, "state-write.lease");
		await writeFile(stateWriteLeasePath, JSON.stringify(staleLease), "utf8");
		await utimes(stateWriteLeasePath, futureMtime, futureMtime);

		expect(await adapter.invalidate("person@example.com")).toMatchObject({
			status: "valid",
		});

		const refreshLeasePath = join(scope, "refresh.lease");
		await writeFile(refreshLeasePath, JSON.stringify(staleLease), "utf8");
		await utimes(refreshLeasePath, futureMtime, futureMtime);
		expect(
			await adapter.refresh(
				"person@example.com",
				async () => snapshot(now, 61),
				{ force: true },
			),
		).toMatchObject({ source: "owned-fetch" });

		const names = await readdir(scope);
		expect(
			names.filter((name) => name.startsWith("state-write.lease.quarantine-")),
		).toHaveLength(1);
		expect(
			names.filter((name) => name.startsWith("refresh.lease.quarantine-")),
		).toHaveLength(1);
		expect(adapter.getDiagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "lease-recovery",
					scopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			]),
		);
		expect(JSON.stringify(adapter.getDiagnostics())).not.toContain(
			"person@example.com",
		);
	});

	it("bounds waiting for compatible refresh work without duplicating the fetch", async () => {
		const root = await temporaryRoot();
		const owner = coordination(root, { policy: policy() });
		const waiter = coordination(root, {
			policy: policy({ refreshAcquisitionTimeoutMs: 20 }),
		});
		let release!: (usage: CodexUsageSnapshot) => void;
		const owned = owner.refresh(
			"person@example.com",
			() =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					release = resolve;
				}),
			{ force: true },
		);
		await waitUntil(async () => {
			expect(
				await readdir(
					join(root, deriveManagedAccountDigest("person@example.com")),
				),
			).toContain("refresh.lease");
		});
		const duplicateFetcher = vi.fn(async () => snapshot(Date.now(), 99));

		const result = await waiter.refresh(
			"person@example.com",
			duplicateFetcher,
			{ force: true },
		);

		expect(result).toMatchObject({
			source: "failure",
			warning: { code: "coordination-unavailable" },
		});
		expect(duplicateFetcher).not.toHaveBeenCalled();
		release(snapshot(Date.now(), 42));
		await owned;
	});

	it("coalesces compatible refresh contention across adapter instances", async () => {
		const root = await temporaryRoot();
		const first = coordination(root, { policy: policy() });
		const second = coordination(root, { policy: policy() });
		let release!: (snapshot: CodexUsageSnapshot) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					release = resolve;
				}),
		);

		const owned = first.refresh("person@example.com", fetcher);
		await waitUntil(() => expect(fetcher).toHaveBeenCalledOnce());
		const joined = second.refresh("PERSON@example.com", fetcher, {
			force: true,
		});
		await waitUntil(() =>
			expect(second.getDiagnostics()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ action: "refresh-contention" }),
				]),
			),
		);
		expect(fetcher).toHaveBeenCalledOnce();
		release(snapshot(Date.now(), 44));

		const outcomes = await Promise.all([owned, joined]);
		expect(outcomes.map(({ source }) => source).sort()).toEqual([
			"joined-work",
			"owned-fetch",
		]);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("clears only the invalidation captured by successful refresh work", async () => {
		const root = await temporaryRoot();
		let tokenIndex = 0;
		const tokens = () => `token-${++tokenIndex}`;
		const owner = coordination(root, { policy: policy(), token: tokens });
		const invalidator = coordination(root, { policy: policy(), token: tokens });
		const captured = await owner.invalidate("person@example.com");
		let release!: (snapshot: CodexUsageSnapshot) => void;
		const refresh = owner.refresh(
			"person@example.com",
			() =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					release = resolve;
				}),
			{ force: true },
		);
		await waitUntil(async () => {
			const names = await readdir(
				join(root, deriveManagedAccountDigest("person@example.com")),
			);
			expect(names).toContain("refresh.lease");
		});
		const refreshLease = await readFile(
			join(
				root,
				deriveManagedAccountDigest("person@example.com"),
				"refresh.lease",
			),
			"utf8",
		);
		expect(refreshLease).not.toMatch(
			/person@example\.com|Bearer|access-token|refresh-token/i,
		);
		const newer = await invalidator.invalidate("person@example.com");
		expect(newer.pendingInvalidation?.token).not.toBe(
			captured.pendingInvalidation?.token,
		);
		release(snapshot(Date.now(), 51));
		await refresh;

		const final = await owner.read("person@example.com");
		expect(final.pendingInvalidation).toEqual(newer.pendingInvalidation);
	});

	it("shares retry suppression for network failures but not authentication or cancellation", async () => {
		const root = await temporaryRoot();
		let now = 0;
		const adapter = coordination(root, { now: () => now, policy: policy() });
		await adapter.refresh("network@example.com", async () => snapshot(now));
		now += adapter.policy.freshnessIntervalMs + 1;
		await adapter.refresh(
			"network@example.com",
			async () => {
				throw new Error("network unavailable");
			},
			{ force: true },
		);
		const networkRetry = vi.fn(async () => snapshot(now));
		expect(
			await adapter.refresh("network@example.com", networkRetry),
		).toMatchObject({ source: "retry-suppressed" });
		expect(networkRetry).not.toHaveBeenCalled();

		for (const [email, error] of [
			["auth@example.com", new UsageAuthenticationError("expired")],
			[
				"cancel@example.com",
				new UsageCoordinationCancellationError("cancelled"),
			],
		] as const) {
			await adapter.refresh(email, async () => {
				throw error;
			});
			const retry = vi.fn(async () => snapshot(now));
			await adapter.refresh(email, retry);
			expect(retry).toHaveBeenCalledOnce();
		}
	});

	it("diagnoses resumed stale-owner late publication and allows later reconciliation", async () => {
		const root = await temporaryRoot();
		let now = 0;
		const adapterPolicy = policy({ refreshLeaseMs: 100 });
		const suspendedOwner = coordination(root, {
			now: () => now,
			policy: adapterPolicy,
		});
		const recoveryOwner = coordination(root, {
			now: () => now,
			policy: adapterPolicy,
		});
		let releaseSuspended!: (usage: CodexUsageSnapshot) => void;
		const suspendedRefresh = suspendedOwner.refresh(
			"person@example.com",
			() =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					releaseSuspended = resolve;
				}),
			{ force: true },
		);
		await waitUntil(async () => {
			expect(
				await readdir(
					join(root, deriveManagedAccountDigest("person@example.com")),
				),
			).toContain("refresh.lease");
		});

		now = 200;
		await recoveryOwner.refresh(
			"person@example.com",
			async () => snapshot(200, 80),
			{ force: true },
		);
		releaseSuspended(snapshot(0, 10));
		await suspendedRefresh;

		expect(suspendedOwner.getDiagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "duplicate-fetch" }),
				expect.objectContaining({ action: "late-publication" }),
			]),
		);
		expect(
			(await recoveryOwner.read("person@example.com")).snapshot?.primary
				?.usedPercent,
		).toBe(10);

		now = 300;
		await recoveryOwner.refresh(
			"person@example.com",
			async () => snapshot(300, 90),
			{ force: true },
		);
		expect(
			(await recoveryOwner.read("person@example.com")).snapshot?.primary
				?.usedPercent,
		).toBe(90);
	});

	it("diagnoses duplicate stale-owner work even when its snapshot timestamp is newer", async () => {
		const root = await temporaryRoot();
		let now = 0;
		const adapterPolicy = policy({ refreshLeaseMs: 100 });
		const resumedOwner = coordination(root, {
			now: () => now,
			policy: adapterPolicy,
		});
		const recoveryOwner = coordination(root, {
			now: () => now,
			policy: adapterPolicy,
		});
		let releaseResumed!: (usage: CodexUsageSnapshot) => void;
		const resumedRefresh = resumedOwner.refresh(
			"person@example.com",
			() =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					releaseResumed = resolve;
				}),
			{ force: true },
		);
		await waitUntil(async () => {
			expect(
				await readdir(
					join(root, deriveManagedAccountDigest("person@example.com")),
				),
			).toContain("refresh.lease");
		});

		now = 200;
		await recoveryOwner.refresh(
			"person@example.com",
			async () => snapshot(200, 80),
			{ force: true },
		);
		releaseResumed(snapshot(300, 30));
		await resumedRefresh;

		expect(resumedOwner.getDiagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "duplicate-fetch" }),
			]),
		);
		expect(resumedOwner.getDiagnostics()).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "late-publication" }),
			]),
		);
	});

	it("reports malformed and oversized canonical state without consuming it", async () => {
		const root = await temporaryRoot();
		const adapterPolicy = policy({ maxStateBytes: 128 });
		const adapter = coordination(root, { policy: adapterPolicy });
		const scope = join(root, deriveManagedAccountDigest("person@example.com"));
		await mkdir(scope, { recursive: true });
		await writeFile(join(scope, "state.json"), "{not-json", "utf8");

		expect(await adapter.read("person@example.com")).toMatchObject({
			status: "unavailable",
			warning: { code: "malformed-state" },
		});

		await writeFile(
			join(scope, "state.json"),
			Buffer.alloc(adapterPolicy.maxStateBytes + 1, 0x20),
		);
		expect(await adapter.read("person@example.com")).toMatchObject({
			status: "unavailable",
			warning: { code: "malformed-state" },
		});
	});

	it("preserves the canonical file and returns local data when every rename retry fails", async () => {
		const root = await temporaryRoot();
		let now = 1_000;
		let failReplacement = false;
		let replacementAttempts = 0;
		const adapter = coordination(root, {
			now: () => now,
			policy: policy(),
			fsFaultHooks: {
				beforeStateRename: () => {
					if (!failReplacement) return;
					replacementAttempts += 1;
					const error = new Error(
						"injected sharing violation",
					) as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				},
			},
		});
		await adapter.refresh("person@example.com", async () => snapshot(now, 10));
		const statePath = join(
			root,
			deriveManagedAccountDigest("person@example.com"),
			"state.json",
		);
		const previousCanonical = await readFile(statePath, "utf8");
		now += adapter.policy.freshnessIntervalMs + 1;
		failReplacement = true;

		const result = await adapter.refresh(
			"person@example.com",
			async () => snapshot(now, 88),
			{ force: true },
		);
		expect(result).toMatchObject({
			availability: "locally-available",
			source: "local-fallback",
			snapshot: { primary: { usedPercent: 88 } },
			warning: { code: "replacement-failed" },
		});
		expect(replacementAttempts).toBe(3);
		expect(await readFile(statePath, "utf8")).toBe(previousCanonical);
		expect(
			(await adapter.read("person@example.com")).snapshot?.primary?.usedPercent,
		).toBe(10);
		expect(adapter.getDiagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "local-fallback" }),
			]),
		);
	});

	it("degrades shared-state read permission failure to a visible process-local fetch", async () => {
		const root = await temporaryRoot();
		const fetcher = vi.fn(async () => snapshot(Date.now(), 73));
		const adapter = coordination(root, {
			policy: policy(),
			fsFaultHooks: {
				beforeStateRead: () => {
					const error = new Error("permission denied") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				},
			},
		});

		const result = await adapter.refresh("person@example.com", fetcher);

		expect(fetcher).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			availability: "locally-available",
			source: "local-fallback",
			snapshot: { primary: { usedPercent: 73 } },
			warning: { code: "permission" },
		});
		expect((await adapter.read("person@example.com")).snapshot).toBeUndefined();
	});

	it("rethrows unexpected orchestration defects instead of hiding them with fallback", async () => {
		const root = await temporaryRoot();
		const fetcher = vi.fn(async () => snapshot(Date.now()));
		const adapter = coordination(root, {
			policy: policy(),
			fsFaultHooks: {
				beforeLeaseCreate: ({ name }) => {
					if (name === "refresh.lease") {
						const error = new Error(
							"unexpected invariant defect",
						) as NodeJS.ErrnoException;
						error.code = "ERR_INVALID_ARG_TYPE";
						throw error;
					}
				},
			},
		});

		await expect(
			adapter.refresh("person@example.com", fetcher),
		).rejects.toThrow("unexpected invariant defect");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("cleans only a bounded number of aged recognized debris entries", async () => {
		const root = await temporaryRoot();
		const adapter = coordination(root, {
			policy: policy({ maxDebrisEntriesPerPass: 2, debrisGraceMs: 10 }),
		});
		const scope = join(root, deriveManagedAccountDigest("person@example.com"));
		await mkdir(scope, { recursive: true });
		const recognized = ["1", "2", "3"].map(
			(value) => `state.json.tmp-${value.repeat(64)}`,
		);
		const unrelated = "state.json.tmp-not-protocol-debris";
		for (const name of [...recognized, unrelated]) {
			await writeFile(join(scope, name), "debris", "utf8");
			await utimes(join(scope, name), new Date(0), new Date(0));
		}

		await adapter.read("person@example.com");
		const remaining = await readdir(scope);
		expect(recognized.filter((name) => remaining.includes(name))).toHaveLength(
			1,
		);
		expect(remaining).toContain(unrelated);
	});

	it("treats root watcher events as debounced hints and validates subscribed state", async () => {
		const root = await temporaryRoot();
		const observer = coordination(root, { policy: policy() });
		const writer = coordination(root, { policy: policy() });
		const observed = vi.fn();
		const unsubscribe = observer.subscribe("person@example.com", observed);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const invalidated = await writer.invalidate("person@example.com");
		await waitUntil(() =>
			expect(observed).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "valid",
					pendingInvalidation: invalidated.pendingInvalidation,
				}),
			),
		);
		unsubscribe();
	});

	it("watches an existing parent until the coordination root appears, then rebinds", async () => {
		const parent = await temporaryRoot();
		const root = join(parent, "missing", "usage-coordination");
		const observer = coordination(root, { policy: policy() });
		const writer = coordination(root, { policy: policy() });
		const observed = vi.fn();
		const unsubscribe = observer.subscribe("person@example.com", observed);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });

		await writer.invalidate("person@example.com");

		await waitUntil(() =>
			expect(observer.getDiagnostics()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ action: "watcher-recovery" }),
				]),
			),
		);
		expect(observed).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "valid",
				pendingInvalidation: expect.any(Object),
			}),
		);
		unsubscribe();
	});

	it("reports watcher failure and recovers through the injected watcher seam", async () => {
		const root = await temporaryRoot();
		let attempts = 0;
		const observed = vi.fn();
		const adapter = coordination(root, {
			policy: policy({ freshnessIntervalMs: 10 }),
			fsFaultHooks: {
				watchFactory: () => {
					attempts += 1;
					const watcher = fakeWatcher();
					if (attempts === 1) {
						queueMicrotask(() =>
							watcher.emit("error", new Error("watcher failed")),
						);
					}
					return watcher;
				},
			},
		});
		const unsubscribe = adapter.subscribe("person@example.com", observed);

		await waitUntil(() =>
			expect(observed).toHaveBeenCalledWith(
				expect.objectContaining({
					warning: expect.objectContaining({ code: "watcher-failed" }),
				}),
			),
		);
		await waitUntil(() => expect(attempts).toBe(2));
		expect(adapter.getDiagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "watcher-recovery" }),
			]),
		);
		unsubscribe();
	});
});
