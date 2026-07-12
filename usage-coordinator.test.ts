import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexUsageSnapshot } from "./usage";
import {
	createUsageCoordinator,
	USAGE_FRESHNESS_INTERVAL_MS,
	type UsageAccount,
} from "./usage-coordinator";

const account = (email: string, accountId?: string): UsageAccount => ({
	email,
	...(accountId ? { accountId } : {}),
});

const snapshot = (fetchedAt: number, usedPercent = 10): CodexUsageSnapshot => ({
	primary: { usedPercent },
	fetchedAt,
});

describe("UsageCoordinator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shares snapshots by account id and normalized email fallback", async () => {
		const coordinator = createUsageCoordinator();
		const fetchUsage = vi.fn(async () => snapshot(Date.now()));

		await coordinator.refresh(
			account("First@Example.com", "acct-1"),
			fetchUsage,
		);
		expect(
			coordinator.getCachedUsage(account("other@example.com", "acct-1")),
		).toEqual(snapshot(0));

		await coordinator.refresh(account("  User@Example.com "), fetchUsage);
		expect(coordinator.getCachedUsage("user@example.com")).toEqual(snapshot(0));
		expect(fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("uses thirty seconds from completed success or failure as eligibility", async () => {
		const coordinator = createUsageCoordinator();
		const fetchUsage =
			vi.fn<(account: UsageAccount) => Promise<CodexUsageSnapshot>>();
		fetchUsage.mockImplementation(async (value) =>
			value.email === "failure@example.com"
				? Promise.reject(new Error("down"))
				: Promise.resolve(snapshot(Date.now())),
		);

		await coordinator.refresh(account("success@example.com"), fetchUsage);
		await coordinator.refresh(account("success@example.com"), fetchUsage);
		expect(fetchUsage).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(USAGE_FRESHNESS_INTERVAL_MS);
		await coordinator.refresh(account("success@example.com"), fetchUsage);
		expect(fetchUsage).toHaveBeenCalledTimes(2);
		await expect(
			coordinator.refresh(account("failure@example.com"), fetchUsage),
		).rejects.toThrow("down");
		await expect(
			coordinator.refresh(account("failure@example.com"), fetchUsage),
		).resolves.toBeUndefined();
		expect(fetchUsage).toHaveBeenCalledTimes(3);
	});

	it("measures success freshness from fetch completion, not snapshot timestamp", async () => {
		const coordinator = createUsageCoordinator();
		let release!: (value: CodexUsageSnapshot) => void;
		const fetchUsage = vi
			.fn<() => Promise<CodexUsageSnapshot>>()
			.mockImplementationOnce(
				() =>
					new Promise<CodexUsageSnapshot>((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValue(snapshot(40_000));

		const pending = coordinator.refresh(
			account("delayed@example.com"),
			fetchUsage,
		);
		expect(fetchUsage).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(10_000);
		release(snapshot(0));
		await pending;

		vi.advanceTimersByTime(USAGE_FRESHNESS_INTERVAL_MS - 1);
		await coordinator.refresh(account("delayed@example.com"), fetchUsage);
		expect(fetchUsage).toHaveBeenCalledOnce();

		vi.advanceTimersByTime(1);
		await coordinator.refresh(account("delayed@example.com"), fetchUsage);
		expect(fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("runs different accounts concurrently and single-flights one account", async () => {
		const coordinator = createUsageCoordinator();
		let releaseA!: (value: CodexUsageSnapshot) => void;
		let releaseB!: (value: CodexUsageSnapshot) => void;
		const fetchUsage = vi.fn((value: UsageAccount) => {
			return new Promise<CodexUsageSnapshot>((resolve) => {
				if (value.email === "a@example.com") releaseA = resolve;
				else releaseB = resolve;
			});
		});

		const a1 = coordinator.refresh(account("a@example.com"), fetchUsage);
		const a2 = coordinator.refresh(account("a@example.com"), fetchUsage);
		const b = coordinator.refresh(account("b@example.com"), fetchUsage);
		expect(fetchUsage).toHaveBeenCalledTimes(2);
		releaseA(snapshot(0));
		releaseB(snapshot(0));
		await Promise.all([a1, a2, b]);
		expect(fetchUsage).toHaveBeenCalledTimes(2);
	});

	it("coalesces dirty consumption events into one trailing refresh", async () => {
		const coordinator = createUsageCoordinator();
		const observer = coordinator.subscribeActiveObserver();
		let release!: (value: CodexUsageSnapshot) => void;
		const fetchUsage = vi.fn((_value: UsageAccount) => {
			if (fetchUsage.mock.calls.length === 1) {
				return new Promise<CodexUsageSnapshot>((resolve) => {
					release = resolve;
				});
			}
			return Promise.resolve(snapshot(Date.now(), 20));
		});

		coordinator.recordUsageConsumption(account("a@example.com"), fetchUsage);
		coordinator.recordUsageConsumption(account("a@example.com"), fetchUsage);
		expect(fetchUsage).toHaveBeenCalledTimes(1);
		release(snapshot(0));
		await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
		vi.advanceTimersByTime(USAGE_FRESHNESS_INTERVAL_MS);
		await vi.runOnlyPendingTimersAsync();
		expect(fetchUsage).toHaveBeenCalledTimes(2);
		observer();
	});

	it("forces one immediate follow-up when force arrives during ordinary flight", async () => {
		const coordinator = createUsageCoordinator();
		let releaseFirst!: (value: CodexUsageSnapshot) => void;
		const fetchUsage = vi.fn(() => {
			if (fetchUsage.mock.calls.length === 1) {
				return new Promise<CodexUsageSnapshot>((resolve) => {
					releaseFirst = resolve;
				});
			}
			return Promise.resolve(snapshot(Date.now(), 30));
		});

		const ordinary = coordinator.refresh(account("a@example.com"), fetchUsage);
		const forced = coordinator.refresh(account("a@example.com"), fetchUsage, {
			force: true,
		});
		expect(fetchUsage).toHaveBeenCalledTimes(1);
		releaseFirst(snapshot(0));
		await Promise.all([ordinary, forced]);
		expect(fetchUsage).toHaveBeenCalledTimes(2);
		expect(
			coordinator.getCachedUsage("a@example.com")?.primary?.usedPercent,
		).toBe(30);
	});

	it("cancels consumption-only trailing work when last observer leaves", async () => {
		const coordinator = createUsageCoordinator();
		const unsubscribe = coordinator.subscribeActiveObserver();
		const fetchUsage = vi.fn(async () => snapshot(Date.now()));

		await coordinator.refresh(account("a@example.com"), fetchUsage);
		coordinator.recordUsageConsumption(account("a@example.com"), fetchUsage);
		unsubscribe();
		vi.advanceTimersByTime(USAGE_FRESHNESS_INTERVAL_MS);
		await vi.runOnlyPendingTimersAsync();

		expect(fetchUsage).toHaveBeenCalledTimes(1);
	});

	it("migrates a successful refresh when account identity becomes available", async () => {
		const coordinator = createUsageCoordinator();
		const value = account("mutable@example.com");
		const fetchUsage = vi.fn(async (current: UsageAccount) => {
			current.accountId = "acct-mutable";
			return snapshot(Date.now(), 42);
		});

		await coordinator.refresh(value, fetchUsage);

		expect(coordinator.getCachedUsage(value)?.primary?.usedPercent).toBe(42);
		await coordinator.refresh(value, fetchUsage);
		expect(fetchUsage).toHaveBeenCalledOnce();
	});

	it("does not repopulate an invalidated in-flight refresh after account identity mutation", async () => {
		const coordinator = createUsageCoordinator();
		const value = account("invalidated-mutable@example.com");
		let release!: (result: CodexUsageSnapshot) => void;
		const fetchUsage = vi.fn(async (current: UsageAccount) => {
			current.accountId = "acct-invalidated";
			return new Promise<CodexUsageSnapshot>((resolve) => {
				release = resolve;
			});
		});

		const refresh = coordinator.refresh(value, fetchUsage);
		await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledOnce());
		coordinator.invalidate(value);
		release(snapshot(1, 99));
		await refresh;

		expect(coordinator.getCachedUsage(value)).toBeUndefined();
	});

	it("settles queued forced refreshes on invalidation without starting them", async () => {
		const coordinator = createUsageCoordinator();
		let release!: (result: CodexUsageSnapshot) => void;
		const fetchUsage = vi.fn(() =>
			fetchUsage.mock.calls.length === 1
				? new Promise<CodexUsageSnapshot>((resolve) => {
						release = resolve;
					})
				: Promise.resolve(snapshot(1)),
		);
		const value = account("queued-invalidation@example.com");

		const ordinary = coordinator.refresh(value, fetchUsage);
		const forced = coordinator.refresh(value, fetchUsage, { force: true });
		coordinator.invalidate(value);

		await expect(forced).resolves.toBeUndefined();
		release(snapshot(0));
		await ordinary;
		expect(fetchUsage).toHaveBeenCalledOnce();
	});
});
