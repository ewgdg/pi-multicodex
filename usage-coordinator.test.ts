import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexUsageSnapshot } from "./usage";
import { createInMemoryUsageCoordination } from "./usage-coordination/index";
import { createUsageCoordinator, type UsageAccount } from "./usage-coordinator";

const account = (email: string, accountId?: string): UsageAccount => ({
	email,
	...(accountId ? { accountId } : {}),
});

const snapshot = (fetchedAt: number, usedPercent = 10): CodexUsageSnapshot => ({
	primary: { usedPercent },
	fetchedAt,
});

async function expectNoUnhandledRejection(
	work: () => Promise<void>,
): Promise<void> {
	const rejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandledRejection);
	try {
		await work();
		await Promise.resolve();
		await Promise.resolve();
		expect(rejections).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
	}
}

describe("UsageCoordinator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses normalized email identity and never merges different emails by account id", async () => {
		const shared = createInMemoryUsageCoordination();
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const fetchUsage = vi
			.fn()
			.mockResolvedValueOnce(snapshot(0, 10))
			.mockResolvedValueOnce(snapshot(0, 20));

		await coordinator.refresh(
			account(" First@Example.com ", "shared-account-id"),
			fetchUsage,
		);
		await coordinator.refresh(
			account("second@example.com", "shared-account-id"),
			fetchUsage,
		);

		expect(
			coordinator.getCachedUsage("first@example.com")?.primary?.usedPercent,
		).toBe(10);
		expect(
			coordinator.getCachedUsage("second@example.com")?.primary?.usedPercent,
		).toBe(20);
		expect(fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("measures freshness only from accepted snapshot fetchedAt", async () => {
		const shared = createInMemoryUsageCoordination();
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const fetchUsage = vi
			.fn()
			.mockResolvedValueOnce(snapshot(0))
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValueOnce(snapshot(60_001, 30));
		const value = account("person@example.com");

		await coordinator.refresh(value, fetchUsage);
		vi.setSystemTime(30_001);
		const failure = await coordinator.refresh(value, fetchUsage, {
			force: true,
		});
		expect(failure.availability).toBe("stale");
		expect(coordinator.isRefreshEligible(value)).toBe(true);

		vi.setSystemTime(60_001);
		await coordinator.refresh(value, fetchUsage, { force: true });
		expect(fetchUsage).toHaveBeenCalledTimes(3);
	});

	it("single-flights one account, runs different accounts concurrently, and lets force join", async () => {
		const shared = createInMemoryUsageCoordination();
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const releases = new Map<string, (value: CodexUsageSnapshot) => void>();
		const fetchUsage = vi.fn(
			(value: UsageAccount) =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					releases.set(value.email, resolve);
				}),
		);

		const a = account("a@example.com");
		const b = account("b@example.com");
		const a1 = coordinator.refresh(a, fetchUsage);
		const a2 = coordinator.refresh(a, fetchUsage, { force: true });
		const b1 = coordinator.refresh(b, fetchUsage);
		await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(2));
		releases.get(a.email)?.(snapshot(0));
		releases.get(b.email)?.(snapshot(0));

		const [owned, joined] = await Promise.all([a1, a2, b1]);
		expect(owned.source).toBe("owned-fetch");
		expect(joined.source).toBe("joined-work");
		expect(fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("records headless consumption durably without starting network work", async () => {
		const shared = createInMemoryUsageCoordination();
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const fetchUsage = vi.fn(async () => snapshot(Date.now()));

		coordinator.recordUsageConsumption(
			account("headless@example.com"),
			fetchUsage,
		);
		await vi.waitFor(async () => {
			expect(
				(await shared.read("headless@example.com")).pendingInvalidation,
			).toBeDefined();
		});
		expect(fetchUsage).not.toHaveBeenCalled();
	});

	it("uses active observer demand to refresh once invalidated data loses freshness", async () => {
		const shared = createInMemoryUsageCoordination();
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const fetchUsage = vi
			.fn()
			.mockResolvedValueOnce(snapshot(0, 10))
			.mockResolvedValueOnce(snapshot(30_000, 20));
		const value = account("observed@example.com");
		await coordinator.refresh(value, fetchUsage);
		const unsubscribe = coordinator.subscribeActiveObserver();

		coordinator.recordUsageConsumption(value, fetchUsage);
		await Promise.resolve();
		expect(fetchUsage).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(2));
		expect(coordinator.getCachedUsage(value)?.primary?.usedPercent).toBe(20);
		unsubscribe();
	});

	it("imports newer shared snapshots through validated subscription views", async () => {
		const shared = createInMemoryUsageCoordination();
		const first = createUsageCoordinator({ sharedCoordination: shared });
		const second = createUsageCoordinator({ sharedCoordination: shared });
		const value = account("shared@example.com");
		const changed = vi.fn();
		second.onUsageChange(changed);
		const unsubscribe = second.subscribeActiveObserver();
		await second.reconcile(value);

		await first.refresh(value, async () => snapshot(0, 66));
		await vi.waitFor(() =>
			expect(second.getCachedUsage(value)?.primary?.usedPercent).toBe(66),
		);
		expect(changed).toHaveBeenCalled();
		unsubscribe();
	});

	it("does not downgrade a newer in-memory snapshot after late shared publication", async () => {
		const shared = createInMemoryUsageCoordination();
		const current = createUsageCoordinator({ sharedCoordination: shared });
		const lateOwner = createUsageCoordinator({ sharedCoordination: shared });
		const value = account("late@example.com");
		const unsubscribe = current.subscribeActiveObserver();
		await current.refresh(value, async () => snapshot(100, 70));

		await lateOwner.refresh(value, async () => snapshot(50, 20), {
			force: true,
		});

		expect(current.getCachedUsage(value)).toEqual(snapshot(100, 70));
		unsubscribe();
	});

	it("stops shared subscription and safety reconciliation after the last observer leaves", async () => {
		const shared = createInMemoryUsageCoordination();
		const read = vi.spyOn(shared, "read");
		const originalSubscribe = shared.subscribe.bind(shared);
		const subscriptionStopped = vi.fn();
		vi.spyOn(shared, "subscribe").mockImplementation((email, handler) => {
			const unsubscribe = originalSubscribe(email, handler);
			return () => {
				subscriptionStopped();
				unsubscribe();
			};
		});
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		await coordinator.reconcile(account("idle@example.com"));
		const unsubscribe = coordinator.subscribeActiveObserver();
		await Promise.resolve();
		const readsWhileObserved = read.mock.calls.length;

		unsubscribe();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(subscriptionStopped).toHaveBeenCalledOnce();
		expect(read).toHaveBeenCalledTimes(readsWhileObserved);
	});

	it("repairs missed watcher hints during likely-sleep safety reconciliation", async () => {
		const shared = createInMemoryUsageCoordination();
		vi.spyOn(shared, "subscribe").mockReturnValue(() => undefined);
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const fetchUsage = vi
			.fn()
			.mockResolvedValueOnce(snapshot(0, 10))
			.mockResolvedValueOnce(snapshot(100_000, 20));
		const value = account("sleep@example.com");
		await coordinator.refresh(value, fetchUsage);
		const unsubscribe = coordinator.subscribeActiveObserver();
		await shared.invalidate(value.email);

		vi.setSystemTime(shared.policy.sleepDetectionMs + 1);
		await vi.advanceTimersByTimeAsync(shared.policy.freshnessIntervalMs);
		await vi.runOnlyPendingTimersAsync();

		expect(fetchUsage).toHaveBeenCalledTimes(2);
		expect(coordinator.getCachedUsage(value)?.primary?.usedPercent).toBe(20);
		unsubscribe();
	});

	it("keeps unpublished local snapshots distinct from shared freshness", async () => {
		const shared = createInMemoryUsageCoordination();
		vi.spyOn(shared, "refresh").mockResolvedValue({
			availability: "locally-available",
			source: "local-fallback",
			snapshot: snapshot(0, 55),
		});
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const value = account("local@example.com");

		await coordinator.refresh(value, async () => snapshot(0));

		expect(coordinator.getCachedResult(value)).toMatchObject({
			availability: "locally-available",
			snapshot: { primary: { usedPercent: 55 } },
		});
	});

	it("deduplicates persistent credential-free coordination warnings", async () => {
		const shared = createInMemoryUsageCoordination();
		vi.spyOn(shared, "read").mockResolvedValue({
			status: "unavailable",
			warning: {
				code: "permission",
				message: "Shared usage coordination storage is not accessible.",
			},
		});
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const warning = vi.fn();
		coordinator.onWarning(warning);

		await coordinator.reconcile(account("warning@example.com"));
		await coordinator.reconcile(account("warning@example.com"));

		expect(warning).toHaveBeenCalledOnce();
	});

	it("detaches an aborted waiter while owned work continues to publication", async () => {
		const shared = createInMemoryUsageCoordination();
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		let release!: (value: CodexUsageSnapshot) => void;
		const fetchUsage = vi.fn(
			() =>
				new Promise<CodexUsageSnapshot>((resolve) => {
					release = resolve;
				}),
		);
		const controller = new AbortController();
		const value = account("cancel@example.com");

		const cancelled = coordinator.refresh(value, fetchUsage, {
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledOnce());
		controller.abort();
		await expect(cancelled).resolves.toMatchObject({ source: "cancellation" });
		release(snapshot(0, 70));
		await vi.waitFor(() =>
			expect(coordinator.getCachedUsage(value)?.primary?.usedPercent).toBe(70),
		);
	});

	it("forgets only local state and reimports shared continuity after re-addition", async () => {
		const shared = createInMemoryUsageCoordination();
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });
		const value = account("readd@example.com");
		await coordinator.refresh(value, async () => snapshot(0, 44));

		coordinator.forget(value);
		expect(coordinator.getCachedUsage(value)).toBeUndefined();
		await coordinator.reconcile(account(" READD@example.com "));
		expect(coordinator.getCachedUsage(value)?.primary?.usedPercent).toBe(44);
	});

	it("preserves foreground refresh rejection while handling detached cleanup", async () => {
		const shared = createInMemoryUsageCoordination();
		const error = new Error("shared refresh failed");
		vi.spyOn(shared, "refresh").mockRejectedValue(error);
		vi.spyOn(shared, "read").mockRejectedValue(error);
		const coordinator = createUsageCoordinator({ sharedCoordination: shared });

		await expectNoUnhandledRejection(async () => {
			await expect(
				coordinator.refresh(account("failure@example.com"), async () =>
					snapshot(0),
				),
			).rejects.toBe(error);
		});
	});
});
