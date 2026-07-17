import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageCoordinator } from "../usage-coordinator";
import { createFilesystemUsageCoordination } from "./filesystem";
import { PRODUCTION_USAGE_COORDINATION_POLICY } from "./policy";

interface WorkerMessage {
	type: "ready" | "fetch-started" | "state-write-held" | "result" | "error";
	result?: { source?: string; availability?: string };
	message?: string;
}

class WorkerHarness {
	readonly messages: WorkerMessage[] = [];
	private readonly waiters: Array<{
		predicate: (message: WorkerMessage) => boolean;
		resolve: (message: WorkerMessage) => void;
	}> = [];

	constructor(readonly child: ChildProcess) {
		child.on("message", (value: unknown) => {
			const message = value as WorkerMessage;
			this.messages.push(message);
			const waiterIndex = this.waiters.findIndex(({ predicate }) =>
				predicate(message),
			);
			if (waiterIndex < 0) return;
			const [waiter] = this.waiters.splice(waiterIndex, 1);
			waiter?.resolve(message);
		});
	}

	waitFor(
		predicate: (message: WorkerMessage) => boolean,
		timeoutMs = 5_000,
	): Promise<WorkerMessage> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("worker message timeout")),
				timeoutMs,
			);
			timer.unref?.();
			this.waiters.push({
				predicate,
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
		});
	}

	send(type: "go" | "release"): void {
		this.child.send?.({ type });
	}
}

const roots: string[] = [];
const workers: WorkerHarness[] = [];
const workerPath = fileURLToPath(
	new URL(
		"../../../test/fixtures/usage-coordination-process-worker.ts",
		import.meta.url,
	),
);

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-multicodex-process-"));
	roots.push(root);
	return root;
}

function silentWatcher(): FSWatcher {
	const watcher = new EventEmitter() as FSWatcher;
	watcher.close = () => undefined;
	return watcher;
}

async function waitUntil(
	assertion: () => void | Promise<void>,
	timeoutMs = 2_000,
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

function startWorker(
	root: string,
	email = "person@example.com",
	leaseMilliseconds = 500,
	force = true,
	action: "refresh" | "state-writer" = "refresh",
	usagePercent = 42,
): WorkerHarness {
	const child = fork(
		workerPath,
		[
			root,
			email,
			String(leaseMilliseconds),
			String(force),
			action,
			String(usagePercent),
		],
		{
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	const worker = new WorkerHarness(child);
	workers.push(worker);
	return worker;
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

afterEach(async () => {
	for (const worker of workers.splice(0)) {
		if (worker.child.exitCode === null && worker.child.signalCode === null) {
			worker.child.kill("SIGKILL");
		}
		await waitForExit(worker.child);
	}
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("filesystem coordination across real processes", () => {
	it("normally coalesces simultaneous compatible refreshes into one fetch", async () => {
		const root = await temporaryRoot();
		const first = startWorker(root, "person@example.com", 500, false);
		const second = startWorker(root);
		await Promise.all([
			first.waitFor(({ type }) => type === "ready"),
			second.waitFor(({ type }) => type === "ready"),
		]);

		first.send("go");
		second.send("go");
		const owner = await Promise.race([
			first.waitFor(({ type }) => type === "fetch-started").then(() => first),
			second.waitFor(({ type }) => type === "fetch-started").then(() => second),
		]);
		owner.send("release");

		const results = await Promise.all([
			first.waitFor(({ type }) => type === "result"),
			second.waitFor(({ type }) => type === "result"),
		]);
		const fetchCount = [...first.messages, ...second.messages].filter(
			({ type }) => type === "fetch-started",
		).length;
		expect(fetchCount).toBe(1);
		expect(results.map(({ result }) => result?.source).sort()).toEqual([
			"joined-work",
			"owned-fetch",
		]);
	});

	it("recovers refresh work after the owning process terminates", async () => {
		const root = await temporaryRoot();
		const owner = startWorker(root, "person@example.com", 250);
		await owner.waitFor(({ type }) => type === "ready");
		owner.send("go");
		await owner.waitFor(({ type }) => type === "fetch-started");
		owner.child.kill("SIGKILL");
		await waitForExit(owner.child);

		const successor = startWorker(root, "person@example.com", 250);
		await successor.waitFor(({ type }) => type === "ready");
		successor.send("go");
		await successor.waitFor(({ type }) => type === "fetch-started");
		successor.send("release");
		const result = await successor.waitFor(({ type }) => type === "result");

		expect(result.result).toMatchObject({
			source: "owned-fetch",
			availability: "fresh",
		});
	});

	it.skipIf(process.platform === "win32")(
		"recovers from a suspended owner and repairs its late publication",
		async () => {
			const root = await temporaryRoot();
			const suspended = startWorker(
				root,
				"person@example.com",
				250,
				true,
				"refresh",
				11,
			);
			await suspended.waitFor(({ type }) => type === "ready");
			suspended.send("go");
			await suspended.waitFor(({ type }) => type === "fetch-started");
			suspended.child.kill("SIGSTOP");

			const recovery = startWorker(
				root,
				"person@example.com",
				250,
				true,
				"refresh",
				88,
			);
			await recovery.waitFor(({ type }) => type === "ready");
			recovery.send("go");
			await recovery.waitFor(({ type }) => type === "fetch-started");
			recovery.send("release");
			await recovery.waitFor(({ type }) => type === "result");

			suspended.child.kill("SIGCONT");
			suspended.send("release");
			await suspended.waitFor(({ type }) => type === "result");
			const reconciler = createFilesystemUsageCoordination({ root });
			expect(
				(await reconciler.read("person@example.com")).snapshot?.primary
					?.usedPercent,
			).toBe(11);

			await reconciler.refresh(
				"person@example.com",
				async () => ({ primary: { usedPercent: 99 }, fetchedAt: Date.now() }),
				{ force: true },
			);
			expect(
				(await reconciler.read("person@example.com")).snapshot?.primary
					?.usedPercent,
			).toBe(99);
			reconciler.dispose();
		},
	);

	it("recovers after a state writer process exits before canonical replacement", async () => {
		const root = await temporaryRoot();
		const writer = startWorker(
			root,
			"person@example.com",
			500,
			true,
			"state-writer",
		);
		await writer.waitFor(({ type }) => type === "ready");
		writer.send("go");
		await writer.waitFor(({ type }) => type === "state-write-held");
		writer.child.kill("SIGKILL");
		await waitForExit(writer.child);
		const successor = createFilesystemUsageCoordination({
			root,
			policy: {
				...PRODUCTION_USAGE_COORDINATION_POLICY,
				stateWriteLeaseMs: 300,
				stateWriteAcquisitionTimeoutMs: 2_000,
				refreshJoinPollMs: 10,
				leaseInitializationGraceMs: 20,
			},
		});

		const recovered = await successor.invalidate("person@example.com");

		expect(recovered).toMatchObject({
			status: "valid",
			pendingInvalidation: expect.any(Object),
		});
		expect(successor.getDiagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "lease-recovery" }),
			]),
		);
		successor.dispose();
	});

	it("lets different managed accounts refresh concurrently in one scope", async () => {
		const root = await temporaryRoot();
		const first = startWorker(root, "first@example.com");
		const second = startWorker(root, "second@example.com");
		await Promise.all([
			first.waitFor(({ type }) => type === "ready"),
			second.waitFor(({ type }) => type === "ready"),
		]);

		first.send("go");
		second.send("go");
		await Promise.all([
			first.waitFor(({ type }) => type === "fetch-started"),
			second.waitFor(({ type }) => type === "fetch-started"),
		]);
		first.send("release");
		second.send("release");
		await Promise.all([
			first.waitFor(({ type }) => type === "result"),
			second.waitFor(({ type }) => type === "result"),
		]);

		expect(
			[...first.messages, ...second.messages].filter(
				({ type }) => type === "fetch-started",
			),
		).toHaveLength(2);
	});

	it("preserves invalidation published by another process during refresh", async () => {
		const root = await temporaryRoot();
		const owner = startWorker(root);
		await owner.waitFor(({ type }) => type === "ready");
		owner.send("go");
		await owner.waitFor(({ type }) => type === "fetch-started");
		const invalidator = createFilesystemUsageCoordination({ root });

		const invalidated = await invalidator.invalidate("person@example.com");
		owner.send("release");
		await owner.waitFor(({ type }) => type === "result");
		const final = await invalidator.read("person@example.com");
		invalidator.dispose();

		expect(final.pendingInvalidation).toEqual(invalidated.pendingInvalidation);
	});

	it("repairs a deliberately missed watcher hint through canonical reconciliation", async () => {
		const root = await temporaryRoot();
		const sharedCoordination = createFilesystemUsageCoordination({
			root,
			policy: {
				...PRODUCTION_USAGE_COORDINATION_POLICY,
				freshnessIntervalMs: 50,
				sleepDetectionMs: 100,
			},
			fsFaultHooks: { watchFactory: () => silentWatcher() },
		});
		const reconciler = createUsageCoordinator({ sharedCoordination });
		const account = { email: "person@example.com" };
		await reconciler.reconcile(account);
		const unsubscribe = reconciler.subscribeActiveObserver();
		const writer = startWorker(root);
		await writer.waitFor(({ type }) => type === "ready");
		writer.send("go");
		await writer.waitFor(({ type }) => type === "fetch-started");
		writer.send("release");
		await writer.waitFor(({ type }) => type === "result");

		await waitUntil(() =>
			expect(reconciler.getCachedUsage(account)).toMatchObject({
				primary: { usedPercent: 42 },
			}),
		);
		unsubscribe();
		reconciler.dispose();
	});

	it("keeps separate agent-directory scopes independent", async () => {
		const firstRoot = await temporaryRoot();
		const secondRoot = await temporaryRoot();
		const first = startWorker(firstRoot);
		const second = startWorker(secondRoot);
		await Promise.all([
			first.waitFor(({ type }) => type === "ready"),
			second.waitFor(({ type }) => type === "ready"),
		]);

		first.send("go");
		second.send("go");
		await Promise.all([
			first.waitFor(({ type }) => type === "fetch-started"),
			second.waitFor(({ type }) => type === "fetch-started"),
		]);
		first.send("release");
		second.send("release");
		await Promise.all([
			first.waitFor(({ type }) => type === "result"),
			second.waitFor(({ type }) => type === "result"),
		]);

		expect(
			[...first.messages, ...second.messages].filter(
				({ type }) => type === "fetch-started",
			),
		).toHaveLength(2);
	});
});
