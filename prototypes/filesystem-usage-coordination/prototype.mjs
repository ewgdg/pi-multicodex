#!/usr/bin/env node

/**
 * THROWAWAY PROTOTYPE — not production code.
 *
 * Question: Can short filesystem leases plus atomic state replacement usually
 * coalesce cross-process usage refreshes while recovering inspectably from
 * crashes, suspension, malformed state, missed hints, and rename failure?
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const QUESTION =
	"Can short filesystem leases plus atomic state replacement usually coalesce cross-process usage refreshes while recovering inspectably from crashes, suspension, malformed state, missed hints, and rename failure?";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_EMAIL = "person@example.com";
const DEFAULT_WRITE_LEASE_MS = 300;
const LEASE_INITIALIZATION_GRACE_MS = 150;
const DEBRIS_GRACE_MS = 2_000;
const SNAPSHOT_FRESH_MS = 5_000;

const sleep = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeEmail(email) {
	return email.trim().toLowerCase();
}

function scopeDirectory(root, email) {
	const digest = createHash("sha256")
		.update(normalizeEmail(email))
		.digest("hex");
	return join(root, "state", "multicodex", "usage-coordination", digest);
}

function parseArguments(values) {
	const result = {};
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (!value.startsWith("--")) continue;
		const key = value.slice(2);
		const next = values[index + 1];
		if (next === undefined || next.startsWith("--")) {
			result[key] = true;
		} else {
			result[key] = next;
			index += 1;
		}
	}
	return result;
}

function numberArgument(arguments_, key, fallback) {
	const value = arguments_[key];
	return typeof value === "string" ? Number(value) : fallback;
}

async function readState(scope) {
	try {
		const raw = await readFile(join(scope, "state.json"), "utf8");
		const parsed = JSON.parse(raw);
		if (!validKnownState(parsed)) {
			return { state: undefined, status: "malformed", raw };
		}
		return { state: parsed, status: "valid", raw };
	} catch (error) {
		if (error?.code === "ENOENT") return { state: undefined, status: "absent" };
		if (error instanceof SyntaxError) {
			return {
				state: undefined,
				status: "malformed",
				raw: await readFile(join(scope, "state.json"), "utf8"),
			};
		}
		throw error;
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function validKnownState(value) {
	if (!isRecord(value)) return false;
	if (
		"snapshot" in value &&
		(!isRecord(value.snapshot) ||
			!isFiniteNumber(value.snapshot.fetchedAt) ||
			typeof value.snapshot.attemptToken !== "string" ||
			("usagePercent" in value.snapshot &&
				!isFiniteNumber(value.snapshot.usagePercent)))
	) {
		return false;
	}
	if (
		"pendingInvalidation" in value &&
		(!isRecord(value.pendingInvalidation) ||
			typeof value.pendingInvalidation.token !== "string" ||
			!isFiniteNumber(value.pendingInvalidation.recordedAt))
	) {
		return false;
	}
	if (
		"lastRefresh" in value &&
		(!isRecord(value.lastRefresh) ||
			typeof value.lastRefresh.token !== "string" ||
			!isFiniteNumber(value.lastRefresh.startedAt) ||
			!isFiniteNumber(value.lastRefresh.completedAt) ||
			!["success", "failure"].includes(value.lastRefresh.outcome))
	) {
		return false;
	}
	if ("retryNotBefore" in value && !isFiniteNumber(value.retryNotBefore)) {
		return false;
	}
	return true;
}

async function filesystemView(scope) {
	let names = [];
	try {
		names = (await readdir(scope)).sort();
	} catch (error) {
		if (error?.code === "ENOENT") return { scope, files: {} };
		throw error;
	}

	const files = {};
	for (const name of names) {
		const path = join(scope, name);
		try {
			const raw = await readFile(path, "utf8");
			try {
				files[name] = JSON.parse(raw);
			} catch {
				files[name] = { raw };
			}
		} catch (error) {
			files[name] = { unreadable: error?.code ?? String(error) };
		}
	}
	return { scope, files };
}

async function emitEvent(eventsPath, scope, action, details = {}) {
	if (!eventsPath) return;
	const event = {
		at: Date.now(),
		pid: process.pid,
		action,
		...details,
		view: await filesystemView(scope),
	};
	await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

function isRecognizedDebris(name) {
	return (
		name.startsWith("state.json.tmp-") ||
		name.startsWith("state-write.lease.quarantine-") ||
		name.startsWith("refresh.lease.quarantine-")
	);
}

async function cleanAgedDebris(scope, eventsPath) {
	let names;
	try {
		names = await readdir(scope);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}

	for (const name of names.filter(isRecognizedDebris).slice(0, 20)) {
		const path = join(scope, name);
		try {
			const metadata = await stat(path);
			if (Date.now() - metadata.mtimeMs <= DEBRIS_GRACE_MS) continue;
			await unlink(path);
			await emitEvent(eventsPath, scope, "aged-debris-cleaned", { name });
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
}

function validLease(value, name) {
	if (
		!isRecord(value) ||
		typeof value.token !== "string" ||
		!isFiniteNumber(value.acquiredAt) ||
		!isFiniteNumber(value.expiresAt)
	) {
		return false;
	}
	const allowedKeys = new Set(["token", "acquiredAt", "expiresAt"]);
	if (name === "refresh.lease") allowedKeys.add("capturedInvalidationToken");
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
	return (
		!("capturedInvalidationToken" in value) ||
		typeof value.capturedInvalidationToken === "string"
	);
}

async function inspectExistingLease(path, name) {
	try {
		const metadata = await stat(path);
		try {
			const lease = JSON.parse(await readFile(path, "utf8"));
			return {
				lease: validLease(lease, name) ? lease : undefined,
				stale: validLease(lease, name)
					? Date.now() > lease.expiresAt
					: Date.now() - metadata.mtimeMs > LEASE_INITIALIZATION_GRACE_MS,
			};
		} catch {
			return {
				lease: undefined,
				stale: Date.now() - metadata.mtimeMs > LEASE_INITIALIZATION_GRACE_MS,
			};
		}
	} catch (error) {
		if (error?.code === "ENOENT") return { missing: true, stale: false };
		throw error;
	}
}

async function tryAcquireLease(
	scope,
	name,
	durationMs,
	eventsPath,
	{ mode, capturedInvalidationToken } = {},
) {
	await mkdir(scope, { recursive: true });
	const path = join(scope, name);
	const token = randomUUID();
	const acquiredAt = Date.now();
	const record = {
		token,
		acquiredAt,
		expiresAt: acquiredAt + durationMs,
	};
	if (name === "refresh.lease" && capturedInvalidationToken) {
		record.capturedInvalidationToken = capturedInvalidationToken;
	}

	try {
		const handle = await open(path, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await emitEvent(eventsPath, scope, "lease-acquired", { name, token, mode });
		return { owner: true, path, record };
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}

	const existing = await inspectExistingLease(path, name);
	if (!existing.stale) return { owner: false, path, record: existing.lease };

	const quarantineName = `${name}.quarantine-${randomUUID()}`;
	try {
		await rename(path, join(scope, quarantineName));
		await emitEvent(eventsPath, scope, "stale-lease-quarantined", {
			name,
			observedToken: existing.lease?.token,
			quarantineName,
		});
	} catch (error) {
		if (error?.code !== "ENOENT") {
			await emitEvent(eventsPath, scope, "stale-lease-race-lost", {
				name,
				code: error?.code,
			});
		}
	}
	return { owner: false, path, record: existing.lease, recoveredStale: true };
}

async function releaseLease(scope, lease, eventsPath) {
	try {
		const current = JSON.parse(await readFile(lease.path, "utf8"));
		if (current.token !== lease.record.token) {
			await emitEvent(eventsPath, scope, "lease-release-token-mismatch", {
				name: basename(lease.path),
				ownerToken: lease.record.token,
				currentToken: current.token,
			});
			return;
		}
		await unlink(lease.path);
		await emitEvent(eventsPath, scope, "lease-released", {
			name: basename(lease.path),
			token: lease.record.token,
		});
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		await emitEvent(eventsPath, scope, "lease-release-found-missing", {
			name: basename(lease.path),
			token: lease.record.token,
		});
	}
}

async function acquireStateWriteLease(scope, durationMs, eventsPath) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const lease = await tryAcquireLease(
			scope,
			"state-write.lease",
			durationMs,
			eventsPath,
		);
		if (lease.owner) return lease;
		await sleep(20);
	}
	throw new Error("timed out acquiring state-write lease");
}

async function syncDirectoryBestEffort(directory) {
	let handle;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch {
		// Directory sync is not uniformly available (notably on Windows).
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function publishState(scope, state, injectRenameFailure, eventsPath) {
	if (!validKnownState(state)) {
		throw new Error(
			"prototype refused to publish malformed known state fields",
		);
	}
	const canonicalPath = join(scope, "state.json");
	const temporaryPath = join(scope, `state.json.tmp-${randomUUID()}`);
	let handle;
	try {
		handle = await open(temporaryPath, "wx");
		await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		if (injectRenameFailure) {
			await emitEvent(eventsPath, scope, "rename-failure-injected", {
				temporaryFile: basename(temporaryPath),
			});
			const error = new Error("prototype injected rename failure");
			error.code = "EACCES";
			throw error;
		}
		await rename(temporaryPath, canonicalPath);
		await syncDirectoryBestEffort(scope);
	} catch (error) {
		await unlink(temporaryPath).catch(() => {});
		throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function mutateState(
	scope,
	mutator,
	{
		eventsPath,
		writeLeaseMs = DEFAULT_WRITE_LEASE_MS,
		injectRenameFailure = false,
	},
) {
	await mkdir(scope, { recursive: true });
	await cleanAgedDebris(scope, eventsPath);
	const lease = await acquireStateWriteLease(scope, writeLeaseMs, eventsPath);
	try {
		const current = await readState(scope);
		if (current.status === "malformed") {
			await emitEvent(eventsPath, scope, "malformed-state-treated-absent", {
				raw: current.raw,
			});
		}
		const next = await mutator(current.state ?? {});
		await publishState(scope, next, injectRenameFailure, eventsPath);
		await emitEvent(eventsPath, scope, "state-published", { state: next });
		return next;
	} finally {
		await releaseLease(scope, lease, eventsPath);
	}
}

async function invalidate(scope, options) {
	const token = options.token ?? randomUUID();
	return mutateState(
		scope,
		(state) => ({
			...state,
			pendingInvalidation: { token, recordedAt: Date.now() },
		}),
		options,
	);
}

async function seedSnapshot(scope, options) {
	const now = Date.now();
	return mutateState(
		scope,
		(state) => ({
			...state,
			prototypeUnknownField: { preserved: true },
			snapshot: {
				usagePercent: Number(options.usagePercent ?? 7),
				fetchedAt: now,
				attemptToken: "seed",
			},
			lastRefresh: {
				token: "seed",
				startedAt: now,
				completedAt: now,
				outcome: "success",
			},
		}),
		options,
	);
}

function isFresh(state) {
	if (!state?.snapshot?.fetchedAt) return false;
	return Date.now() - state.snapshot.fetchedAt < SNAPSHOT_FRESH_MS;
}

async function refresh(scope, options) {
	const requestStartedAt = Date.now();
	const baseline = await readState(scope);
	const baselineRefreshToken = baseline.state?.lastRefresh?.token;
	const mode = options.mode ?? "automatic";
	const leaseMs = Number(options.leaseMs ?? 1_500);
	const fetchMs = Number(options.fetchMs ?? 400);

	if (mode === "automatic" && isFresh(baseline.state)) {
		await emitEvent(options.eventsPath, scope, "fresh-request-skipped", {
			mode,
		});
		return "fresh";
	}
	if (
		mode === "automatic" &&
		baseline.state?.retryNotBefore &&
		baseline.state.retryNotBefore > Date.now()
	) {
		await emitEvent(options.eventsPath, scope, "retry-suppression-observed", {
			mode,
			retryNotBefore: baseline.state.retryNotBefore,
		});
		return "retry-suppressed";
	}

	while (true) {
		const beforeAcquisition = await readState(scope);
		const capturedInvalidationToken =
			beforeAcquisition.state?.pendingInvalidation?.token;
		const lease = await tryAcquireLease(
			scope,
			"refresh.lease",
			leaseMs,
			options.eventsPath,
			{ mode, capturedInvalidationToken },
		);
		if (!lease.owner) {
			await emitEvent(options.eventsPath, scope, "compatible-refresh-joined", {
				mode,
				ownerToken: lease.record?.token,
			});
			await sleep(25);
			const reconciled = await readState(scope);
			if (
				reconciled.state?.lastRefresh?.token &&
				reconciled.state.lastRefresh.token !== baselineRefreshToken &&
				reconciled.state.lastRefresh.completedAt >= requestStartedAt
			) {
				await emitEvent(options.eventsPath, scope, "joined-refresh-observed", {
					mode,
					refreshToken: reconciled.state.lastRefresh.token,
				});
				return "joined";
			}
			continue;
		}

		const afterAcquisition = await readState(scope);
		if (
			afterAcquisition.state?.lastRefresh?.token &&
			afterAcquisition.state.lastRefresh.token !== baselineRefreshToken &&
			afterAcquisition.state.lastRefresh.completedAt >= requestStartedAt
		) {
			await emitEvent(
				options.eventsPath,
				scope,
				"post-acquisition-refresh-joined",
				{
					mode,
					refreshToken: afterAcquisition.state.lastRefresh.token,
				},
			);
			await releaseLease(scope, lease, options.eventsPath);
			return "joined";
		}

		const refreshToken = lease.record.token;
		const leaseCapturedInvalidationToken =
			lease.record.capturedInvalidationToken;
		const startedAt = Date.now();
		await emitEvent(options.eventsPath, scope, "simulated-fetch-started", {
			mode,
			refreshToken,
			capturedInvalidationToken: leaseCapturedInvalidationToken,
			fetchMs,
		});
		await sleep(fetchMs);

		try {
			if (options.failFetch) {
				const completedAt = Date.now();
				await mutateState(
					scope,
					(state) => ({
						...state,
						lastRefresh: {
							token: refreshToken,
							startedAt,
							completedAt,
							outcome: "failure",
						},
						retryNotBefore: Date.now() + 1_000,
					}),
					options,
				);
				return "failed";
			}

			const completedAt = Date.now();
			await mutateState(
				scope,
				(state) => {
					const next = {
						...state,
						snapshot: {
							usagePercent: Number(options.usagePercent ?? 42),
							fetchedAt: completedAt,
							attemptToken: refreshToken,
						},
						lastRefresh: {
							token: refreshToken,
							startedAt,
							completedAt,
							outcome: "success",
						},
					};
					delete next.retryNotBefore;
					if (
						state.pendingInvalidation?.token === leaseCapturedInvalidationToken
					) {
						delete next.pendingInvalidation;
					}
					return next;
				},
				options,
			);
			await emitEvent(options.eventsPath, scope, "simulated-fetch-completed", {
				mode,
				refreshToken,
			});
			return "fetched";
		} finally {
			await releaseLease(scope, lease, options.eventsPath);
		}
	}
}

async function workerMain(action, arguments_) {
	const root = String(arguments_.root);
	const email = String(arguments_.email ?? DEFAULT_EMAIL);
	const scope = scopeDirectory(root, email);
	const options = {
		eventsPath:
			typeof arguments_.events === "string" ? arguments_.events : undefined,
		writeLeaseMs: numberArgument(
			arguments_,
			"write-lease-ms",
			DEFAULT_WRITE_LEASE_MS,
		),
		leaseMs: numberArgument(arguments_, "lease-ms", 1_500),
		fetchMs: numberArgument(arguments_, "fetch-ms", 400),
		mode: typeof arguments_.mode === "string" ? arguments_.mode : "automatic",
		usagePercent: numberArgument(arguments_, "usage", 42),
		injectRenameFailure: arguments_["inject-rename-failure"] === true,
		failFetch: arguments_["fail-fetch"] === true,
	};

	switch (action) {
		case "refresh":
			await refresh(scope, options);
			break;
		case "invalidate":
			await invalidate(scope, options);
			break;
		case "seed":
			await seedSnapshot(scope, options);
			break;
		case "reconcile": {
			const state = await readState(scope);
			await emitEvent(options.eventsPath, scope, "explicit-reconciliation", {
				stateStatus: state.status,
				state: state.state,
			});
			break;
		}
		case "crash-write": {
			await mkdir(scope, { recursive: true });
			const lease = await acquireStateWriteLease(
				scope,
				options.writeLeaseMs,
				options.eventsPath,
			);
			await emitEvent(options.eventsPath, scope, "state-writer-crashing", {
				token: lease.record.token,
			});
			process.exit(86);
			break;
		}
		default:
			throw new Error(`unknown worker action: ${action}`);
	}
}

function startWorker(action, options) {
	const arguments_ = [SCRIPT_PATH, "worker", action];
	for (const [key, value] of Object.entries(options)) {
		if (value === undefined || value === false) continue;
		arguments_.push(`--${key}`);
		if (value !== true) arguments_.push(String(value));
	}
	const child = spawn(process.execPath, arguments_, {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const completion = new Promise((resolve) => {
		child.once("exit", (code, signal) =>
			resolve({ code, signal, stdout, stderr }),
		);
	});
	return { child, completion };
}

async function runWorker(action, options, acceptedExitCodes = [0]) {
	const running = startWorker(action, options);
	const result = await running.completion;
	if (!acceptedExitCodes.includes(result.code)) {
		throw new Error(
			`worker ${action} exited ${result.code ?? result.signal}: ${result.stderr || result.stdout}`,
		);
	}
	return result;
}

async function readEvents(path) {
	try {
		const raw = await readFile(path, "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function waitForEvent(path, predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const match = (await readEvents(path)).find(predicate);
		if (match) return match;
		await sleep(20);
	}
	throw new Error(`timed out waiting for an event in ${path}`);
}

async function createScenario(runRoot, name) {
	const root = join(runRoot, name);
	await mkdir(root, { recursive: true });
	return { root, events: join(root, "events.ndjson") };
}

function workerOptions(scenario, email = DEFAULT_EMAIL, extra = {}) {
	return { root: scenario.root, events: scenario.events, email, ...extra };
}

function verdict(condition, explanation) {
	return { pass: Boolean(condition), explanation };
}

async function simultaneousContenders(runRoot) {
	const scenario = await createScenario(runRoot, "01-simultaneous-contenders");
	const workers = Array.from({ length: 5 }, (_, index) =>
		startWorker(
			"refresh",
			workerOptions(scenario, DEFAULT_EMAIL, {
				"fetch-ms": 500,
				"lease-ms": 1_500,
				mode: index % 2 === 0 ? "automatic" : "forced",
				usage: 30 + index,
			}),
		),
	);
	const results = await Promise.all(workers.map((worker) => worker.completion));
	const events = await readEvents(scenario.events);
	return {
		name: "simultaneous refresh contenders normally produce one simulated fetch",
		scenario,
		scopes: [scopeDirectory(scenario.root, DEFAULT_EMAIL)],
		verdict: verdict(
			results.every((result) => result.code === 0) &&
				events.filter((event) => event.action === "simulated-fetch-started")
					.length === 1,
			`mixed forced/automatic fetch starts: ${events.filter((event) => event.action === "simulated-fetch-started").length}`,
		),
	};
}

async function invalidationDuringRefresh(runRoot) {
	const scenario = await createScenario(
		runRoot,
		"02-invalidation-during-refresh",
	);
	await runWorker("invalidate", workerOptions(scenario));
	const beforeRefresh = await readState(
		scopeDirectory(scenario.root, DEFAULT_EMAIL),
	);
	const capturedToken = beforeRefresh.state?.pendingInvalidation?.token;
	const refreshWorker = startWorker(
		"refresh",
		workerOptions(scenario, DEFAULT_EMAIL, {
			"fetch-ms": 600,
			"lease-ms": 1_500,
		}),
	);
	const fetchStarted = await waitForEvent(
		scenario.events,
		(event) => event.action === "simulated-fetch-started",
	);
	await runWorker("invalidate", workerOptions(scenario));
	const refreshResult = await refreshWorker.completion;
	const final = await readState(scopeDirectory(scenario.root, DEFAULT_EMAIL));
	return {
		name: "consumption invalidation arriving during refresh remains pending",
		scenario,
		scopes: [scopeDirectory(scenario.root, DEFAULT_EMAIL)],
		verdict: verdict(
			refreshResult.code === 0 &&
				fetchStarted.view.files["refresh.lease"]?.capturedInvalidationToken ===
					capturedToken &&
				Boolean(final.state?.pendingInvalidation?.token) &&
				final.state.pendingInvalidation.token !== capturedToken,
			`lease captured: ${capturedToken}; newer pending token: ${final.state?.pendingInvalidation?.token ?? "missing"}`,
		),
	};
}

async function killedRefreshOwner(runRoot) {
	const scenario = await createScenario(runRoot, "03-killed-refresh-owner");
	const owner = startWorker(
		"refresh",
		workerOptions(scenario, DEFAULT_EMAIL, {
			"fetch-ms": 5_000,
			"lease-ms": 300,
			usage: 11,
		}),
	);
	await waitForEvent(
		scenario.events,
		(event) => event.action === "simulated-fetch-started",
	);
	owner.child.kill("SIGKILL");
	const ownerResult = await owner.completion;
	await sleep(450);
	await runWorker(
		"refresh",
		workerOptions(scenario, DEFAULT_EMAIL, {
			"fetch-ms": 100,
			"lease-ms": 500,
			usage: 77,
		}),
	);
	const events = await readEvents(scenario.events);
	const final = await readState(scopeDirectory(scenario.root, DEFAULT_EMAIL));
	return {
		name: "killed refresh owner is recovered after lease expiry",
		scenario,
		scopes: [scopeDirectory(scenario.root, DEFAULT_EMAIL)],
		verdict: verdict(
			ownerResult.code !== 0 &&
				events.filter((event) => event.action === "simulated-fetch-started")
					.length === 2 &&
				final.state?.snapshot?.usagePercent === 77,
			`owner exit: ${ownerResult.code ?? ownerResult.signal}; successor usage: ${final.state?.snapshot?.usagePercent}`,
		),
	};
}

async function suspendedOwnerOverlap(runRoot) {
	const scenario = await createScenario(runRoot, "04-suspended-owner-overlap");
	const scope = scopeDirectory(scenario.root, DEFAULT_EMAIL);
	if (process.platform === "win32") {
		await mkdir(scope, { recursive: true });
		await emitEvent(scenario.events, scope, "scenario-skipped", {
			reason:
				"Windows does not provide the POSIX SIGSTOP/SIGCONT demonstration",
		});
		return {
			name: "suspended owner overlap demonstrates accepted last-writer-wins",
			scenario,
			scopes: [scope],
			verdict: {
				pass: true,
				skipped: true,
				explanation: "clear POSIX-only skip",
			},
		};
	}

	const owner = startWorker(
		"refresh",
		workerOptions(scenario, DEFAULT_EMAIL, {
			"fetch-ms": 700,
			"lease-ms": 250,
			usage: 13,
		}),
	);
	const ownerStart = await waitForEvent(
		scenario.events,
		(event) => event.action === "simulated-fetch-started",
	);
	owner.child.kill("SIGSTOP");
	await sleep(400);
	await runWorker(
		"refresh",
		workerOptions(scenario, DEFAULT_EMAIL, {
			"fetch-ms": 100,
			"lease-ms": 300,
			usage: 88,
		}),
	);
	owner.child.kill("SIGCONT");
	const ownerResult = await owner.completion;
	const events = await readEvents(scenario.events);
	const final = await readState(scope);
	return {
		name: "suspended owner overlap demonstrates accepted last-writer-wins",
		scenario,
		scopes: [scope],
		verdict: verdict(
			ownerResult.code === 0 &&
				events.filter((event) => event.action === "simulated-fetch-started")
					.length === 2 &&
				final.state?.lastRefresh?.token === ownerStart.refreshToken &&
				final.state?.snapshot?.usagePercent === 13,
			`two fetches overlapped; resumed owner final usage: ${final.state?.snapshot?.usagePercent}`,
		),
	};
}

async function crashedStateWriter(runRoot) {
	const scenario = await createScenario(runRoot, "05-crashed-state-writer");
	const crashed = await runWorker(
		"crash-write",
		workerOptions(scenario, DEFAULT_EMAIL, { "write-lease-ms": 250 }),
		[86],
	);
	await sleep(400);
	await runWorker(
		"invalidate",
		workerOptions(scenario, DEFAULT_EMAIL, { "write-lease-ms": 250 }),
	);
	const events = await readEvents(scenario.events);
	const final = await readState(scopeDirectory(scenario.root, DEFAULT_EMAIL));
	return {
		name: "state-write lease owner crash recovers without malformed state",
		scenario,
		scopes: [scopeDirectory(scenario.root, DEFAULT_EMAIL)],
		verdict: verdict(
			crashed.code === 86 &&
				final.status === "valid" &&
				Boolean(final.state?.pendingInvalidation) &&
				events.some((event) => event.action === "stale-lease-quarantined"),
			`crash exit: 86; final state: ${final.status}`,
		),
	};
}

async function malformedState(runRoot) {
	const scenario = await createScenario(runRoot, "06-malformed-state");
	const scope = scopeDirectory(scenario.root, DEFAULT_EMAIL);
	await mkdir(scope, { recursive: true });
	await writeFile(join(scope, "state.json"), "{not-json", "utf8");
	await writeFile(
		join(scope, "state.json.tmp-old-prototype"),
		"old temp",
		"utf8",
	);
	await writeFile(
		join(scope, "refresh.lease.quarantine-old-prototype"),
		"old quarantine",
		"utf8",
	);
	await writeFile(
		join(scope, "do-not-touch.txt"),
		"unrecognized debris",
		"utf8",
	);
	const old = new Date(Date.now() - 60_000);
	await utimes(join(scope, "state.json.tmp-old-prototype"), old, old);
	await utimes(join(scope, "refresh.lease.quarantine-old-prototype"), old, old);
	await runWorker("invalidate", workerOptions(scenario));
	const final = await readState(scope);
	const view = await filesystemView(scope);
	return {
		name: "malformed state is absent/reconstructed; only recognized aged debris is cleaned",
		scenario,
		scopes: [scope],
		verdict: verdict(
			final.status === "valid" &&
				Boolean(final.state?.pendingInvalidation) &&
				!("state.json.tmp-old-prototype" in view.files) &&
				!("refresh.lease.quarantine-old-prototype" in view.files) &&
				"do-not-touch.txt" in view.files,
			`state: ${final.status}; unrecognized debris preserved: ${"do-not-touch.txt" in view.files}`,
		),
	};
}

async function missedWatcherHint(runRoot) {
	const scenario = await createScenario(runRoot, "07-missed-watcher-hint");
	const scope = scopeDirectory(scenario.root, DEFAULT_EMAIL);
	await runWorker("seed", workerOptions(scenario));
	const processLocalView = await readState(scope);
	await runWorker("invalidate", workerOptions(scenario));
	await emitEvent(scenario.events, scope, "watcher-hint-deliberately-missed", {
		processLocalState: processLocalView.state,
	});
	await runWorker("reconcile", workerOptions(scenario));
	const events = await readEvents(scenario.events);
	const reconciliation = events.findLast(
		(event) => event.action === "explicit-reconciliation",
	);
	return {
		name: "missed watcher hint is recovered by explicit reconciliation",
		scenario,
		scopes: [scope],
		verdict: verdict(
			!processLocalView.state?.pendingInvalidation &&
				Boolean(reconciliation?.state?.pendingInvalidation),
			`cached pending: false; reconciled pending: ${Boolean(reconciliation?.state?.pendingInvalidation)}`,
		),
	};
}

async function separateScopes(runRoot) {
	const scenario = await createScenario(runRoot, "08-separate-scope-roots");
	const emailA = " Alpha@Example.com ";
	const emailB = "beta@example.com";
	await Promise.all([
		runWorker(
			"refresh",
			workerOptions(scenario, emailA, { "fetch-ms": 250, usage: 21 }),
		),
		runWorker(
			"refresh",
			workerOptions(scenario, emailB, { "fetch-ms": 250, usage: 84 }),
		),
	]);
	await runWorker("invalidate", workerOptions(scenario, emailA));
	const scopeA = scopeDirectory(scenario.root, emailA);
	const scopeB = scopeDirectory(scenario.root, emailB);
	const [stateA, stateB] = await Promise.all([
		readState(scopeA),
		readState(scopeB),
	]);
	return {
		name: "separate account scope roots do not interact",
		scenario,
		scopes: [scopeA, scopeB],
		verdict: verdict(
			scopeA !== scopeB &&
				stateA.state?.snapshot?.usagePercent === 21 &&
				stateB.state?.snapshot?.usagePercent === 84 &&
				Boolean(stateA.state?.pendingInvalidation) &&
				!stateB.state?.pendingInvalidation,
			`A usage/pending: ${stateA.state?.snapshot?.usagePercent}/true; B usage/pending: ${stateB.state?.snapshot?.usagePercent}/false`,
		),
	};
}

async function injectedRenameFailure(runRoot) {
	const scenario = await createScenario(runRoot, "09-injected-rename-failure");
	const scope = scopeDirectory(scenario.root, DEFAULT_EMAIL);
	await runWorker("seed", workerOptions(scenario));
	const previousRaw = await readFile(join(scope, "state.json"), "utf8");
	const failed = await runWorker(
		"invalidate",
		workerOptions(scenario, DEFAULT_EMAIL, { "inject-rename-failure": true }),
		[1],
	);
	const afterRaw = await readFile(join(scope, "state.json"), "utf8");
	const final = await readState(scope);
	return {
		name: "injected rename failure preserves previous canonical state",
		scenario,
		scopes: [scope],
		verdict: verdict(
			failed.code === 1 && previousRaw === afterRaw && final.status === "valid",
			`worker exit: 1; canonical bytes unchanged: ${previousRaw === afterRaw}`,
		),
	};
}

const SCENARIOS = [
	simultaneousContenders,
	invalidationDuringRefresh,
	killedRefreshOwner,
	suspendedOwnerOverlap,
	crashedStateWriter,
	malformedState,
	missedWatcherHint,
	separateScopes,
	injectedRenameFailure,
];

async function printScenarioResult(result) {
	console.log(`\n=== ${result.name} ===`);
	const events = await readEvents(result.scenario.events);
	for (const event of events) {
		console.log(JSON.stringify(event));
	}
	console.log("FINAL FULL FILESYSTEM STATE");
	for (const scope of result.scopes) {
		console.log(JSON.stringify(await filesystemView(scope), null, 2));
	}
	const label = result.verdict.skipped
		? "SKIP"
		: result.verdict.pass
			? "PASS"
			: "FAIL";
	console.log(`${label}: ${result.verdict.explanation}`);
}

async function runScenarios(scenarios) {
	const actualRunRoot = join(
		tmpdir(),
		`multicodex-usage-coordination-prototype-${randomUUID()}`,
	);
	await mkdir(actualRunRoot, { recursive: true });
	console.log("THROWAWAY PROTOTYPE — never import this into production");
	console.log(`Question: ${QUESTION}`);
	console.log(`Temporary run root retained for inspection: ${actualRunRoot}`);

	const results = [];
	for (const scenario of scenarios) {
		try {
			const result = await scenario(actualRunRoot);
			results.push(result);
			await printScenarioResult(result);
		} catch (error) {
			const failed = {
				name: scenario.name,
				verdict: { pass: false, explanation: error.stack ?? String(error) },
			};
			results.push(failed);
			console.error(`\nFAIL: ${scenario.name}\n${failed.verdict.explanation}`);
		}
	}

	console.log("\n=== SUMMARY ===");
	for (const result of results) {
		const label = result.verdict.skipped
			? "SKIP"
			: result.verdict.pass
				? "PASS"
				: "FAIL";
		console.log(`${label}  ${result.name}: ${result.verdict.explanation}`);
	}
	if (results.some((result) => !result.verdict.pass)) process.exitCode = 1;
}

async function interactiveMain() {
	console.log("THROWAWAY PROTOTYPE — never import this into production");
	console.log(`Question: ${QUESTION}`);
	console.log("Each action prints its event trace and full filesystem state.");
	const terminal = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		while (true) {
			console.log("\nChoose a scenario:");
			for (const [index, scenario] of SCENARIOS.entries()) {
				console.log(`  ${index + 1}. ${scenario.name}`);
			}
			console.log("  a. run all");
			console.log("  q. quit");
			const answer = (await terminal.question("> ")).trim().toLowerCase();
			if (answer === "q") return;
			if (answer === "a") {
				await runScenarios(SCENARIOS);
				continue;
			}
			const index = Number(answer) - 1;
			if (SCENARIOS[index]) await runScenarios([SCENARIOS[index]]);
		}
	} finally {
		terminal.close();
	}
}

const [command, action, ...rest] = process.argv.slice(2);
if (command === "worker") {
	workerMain(action, parseArguments(rest)).catch((error) => {
		console.error(error.stack ?? error);
		process.exitCode = 1;
	});
} else if (command === "--all") {
	await runScenarios(SCENARIOS);
} else {
	await interactiveMain();
}
