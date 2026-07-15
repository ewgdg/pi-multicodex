import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SharedUsageState, UsageCoordinationWarning } from "./contracts";
import type {
	FilesystemUsageCoordinationFaultHooks,
	UsageCoordinationDiagnostic,
} from "./filesystem-types";
import type { UsageCoordinationPolicy } from "./policy";
import { parseSharedUsageState } from "./state";

const STATE_FILE_NAME = "state.json";
export const STATE_WRITE_LEASE_NAME = "state-write.lease";
export const REFRESH_LEASE_NAME = "refresh.lease";
const TRANSIENT_REPLACEMENT_ERROR_CODES = new Set([
	"EACCES",
	"EBUSY",
	"EMFILE",
	"ENFILE",
	"ENOTEMPTY",
	"EPERM",
]);
const PERMISSION_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const EXPECTED_FILESYSTEM_ERROR_CODES = new Set([
	"EACCES",
	"EBUSY",
	"EDQUOT",
	"EEXIST",
	"EIO",
	"EISDIR",
	"EMFILE",
	"ENAMETOOLONG",
	"ENFILE",
	"ENOENT",
	"ENOSPC",
	"ENOTDIR",
	"ENOTEMPTY",
	"EPERM",
	"EROFS",
	"EXDEV",
]);
const RECOGNIZED_DEBRIS_PATTERNS = [
	/^state\.json\.tmp-[a-f0-9]{64}$/,
	/^state-write\.lease\.quarantine-[a-f0-9]{64}$/,
	/^refresh\.lease\.quarantine-[a-f0-9]{64}$/,
];

type LeaseName = typeof STATE_WRITE_LEASE_NAME | typeof REFRESH_LEASE_NAME;
type DiagnosticRecorder = (
	action: UsageCoordinationDiagnostic["action"],
	scope: string,
	details?: Record<string, unknown>,
) => void;

interface LeaseRecord extends Record<string, unknown> {
	token: string;
	acquiredAt: number;
	expiresAt: number;
	capturedInvalidationToken?: string;
}

export interface OwnedLease {
	path: string;
	record: LeaseRecord;
}

export interface StateReadResult {
	status: "valid" | "absent" | "malformed" | "unavailable";
	state?: SharedUsageState;
	warning?: UsageCoordinationWarning;
	error?: unknown;
}

export interface MutationResult {
	published: boolean;
	state?: SharedUsageState;
	warning?: UsageCoordinationWarning;
	error?: unknown;
}

class StateWriteLeaseTimeoutError extends Error {
	override readonly name = "StateWriteLeaseTimeoutError";
}

class SharedStateSizeError extends Error {
	override readonly name = "SharedStateSizeError";
}

export function isErrnoException(
	error: unknown,
): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export function isExpectedFilesystemError(error: unknown): boolean {
	return (
		isErrnoException(error) &&
		EXPECTED_FILESYSTEM_ERROR_CODES.has(error.code ?? "")
	);
}

export function warningForError(
	error: unknown,
	fallbackCode: UsageCoordinationWarning["code"] = "coordination-unavailable",
	fallbackMessage = "Shared usage coordination is unavailable.",
): UsageCoordinationWarning {
	if (fallbackCode !== "coordination-unavailable") {
		return { code: fallbackCode, message: fallbackMessage };
	}
	return isErrnoException(error) && PERMISSION_ERROR_CODES.has(error.code ?? "")
		? {
				code: "permission",
				message: "Shared usage coordination storage is not accessible.",
			}
		: { code: fallbackCode, message: fallbackMessage };
}

function malformedStateWarning(): UsageCoordinationWarning {
	return {
		code: "malformed-state",
		message: "Shared usage state is malformed or exceeds its size limit.",
	};
}

function isLeaseRecord(value: unknown): value is LeaseRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.token === "string" &&
		record.token.length > 0 &&
		typeof record.acquiredAt === "number" &&
		Number.isFinite(record.acquiredAt) &&
		typeof record.expiresAt === "number" &&
		Number.isFinite(record.expiresAt) &&
		(record.capturedInvalidationToken === undefined ||
			typeof record.capturedInvalidationToken === "string")
	);
}

export function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) =>
		setTimeout(resolve, Math.max(1, milliseconds)),
	);
}

export class FilesystemCoordinationStorage {
	private readonly artifactNonce = randomUUID();
	private artifactSequence = 0;

	constructor(
		private readonly policy: UsageCoordinationPolicy,
		private readonly now: () => number,
		private readonly token: () => string,
		private readonly fsFaultHooks: FilesystemUsageCoordinationFaultHooks,
		private readonly recordDiagnostic: DiagnosticRecorder,
	) {}

	async mutateState(
		scope: string,
		mutator: (state: SharedUsageState) => SharedUsageState,
	): Promise<MutationResult> {
		try {
			await mkdir(scope, { recursive: true });
			await this.cleanAgedDebris(scope);
			const lease = await this.acquireStateWriteLease(scope);
			try {
				const current = await this.readCanonical(scope);
				if (current.status === "unavailable") {
					return {
						published: false,
						state: current.state,
						warning: current.warning,
						error: current.error,
					};
				}
				const state = mutator(current.state ?? {});
				await this.publishState(scope, state);
				return { published: true, state };
			} finally {
				await this.releaseLease(lease);
			}
		} catch (error) {
			if (
				!isExpectedFilesystemError(error) &&
				!(error instanceof StateWriteLeaseTimeoutError) &&
				!(error instanceof SharedStateSizeError)
			) {
				throw error;
			}
			const current = await this.readCanonical(scope);
			const replacementFailure =
				isErrnoException(error) &&
				TRANSIENT_REPLACEMENT_ERROR_CODES.has(error.code ?? "");
			return {
				published: false,
				state: current.state,
				error,
				warning: warningForError(
					error,
					replacementFailure
						? "replacement-failed"
						: "coordination-unavailable",
					replacementFailure
						? "Shared usage state replacement failed; the prior state was preserved."
						: "Shared usage state could not be published.",
				),
			};
		}
	}

	async tryAcquireLease(
		scope: string,
		name: LeaseName,
		durationMs: number,
		capturedInvalidationToken?: string,
	): Promise<OwnedLease | undefined> {
		await mkdir(scope, { recursive: true });
		const path = join(scope, name);
		const acquiredAt = this.now();
		const record: LeaseRecord = {
			token: this.token(),
			acquiredAt,
			expiresAt: acquiredAt + durationMs,
			...(capturedInvalidationToken !== undefined
				? { capturedInvalidationToken }
				: {}),
		};
		const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
		if (bytes.byteLength > this.policy.maxLeaseBytes) {
			throw new Error("Lease record exceeds the configured size limit.");
		}

		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await this.fsFaultHooks.beforeLeaseCreate?.({ name, path });
			handle = await open(path, "wx");
			await handle.writeFile(bytes);
			await handle.sync();
			await handle.close();
			handle = undefined;
			return { path, record };
		} catch (error) {
			await handle?.close().catch(() => {});
			if (!isErrnoException(error) || error.code !== "EEXIST") {
				if (handle) await unlink(path).catch(() => {});
				throw error;
			}
		}

		const existing = await this.inspectLease(path);
		if (!existing.stale) return undefined;
		const quarantinePath = join(
			scope,
			`${name}.quarantine-${this.artifactId()}`,
		);
		try {
			await rename(path, quarantinePath);
			this.recordDiagnostic("lease-recovery", scope, { lease: name });
		} catch (error) {
			if (isErrnoException(error) && error.code === "ENOENT") {
				// Another contender may have recovered the same advisory lease.
			} else {
				throw error;
			}
		}
		return undefined;
	}

	async releaseLease(lease: OwnedLease): Promise<void> {
		try {
			const bytes = await this.readBounded(
				lease.path,
				this.policy.maxLeaseBytes,
			);
			if (!bytes) return;
			const value: unknown = JSON.parse(bytes.toString("utf8"));
			if (!isLeaseRecord(value) || value.token !== lease.record.token) return;
			await unlink(lease.path);
		} catch (error) {
			if (!isErrnoException(error) || error.code !== "ENOENT") {
				// Advisory release is best effort; expiry recovery remains available.
			}
		}
	}

	async readCanonical(scope: string): Promise<StateReadResult> {
		const path = join(scope, STATE_FILE_NAME);
		try {
			await this.fsFaultHooks.beforeStateRead?.(path);
			const bytes = await this.readBounded(path, this.policy.maxStateBytes);
			if (!bytes) {
				return {
					status: "malformed",
					warning: malformedStateWarning(),
				};
			}
			const parsed = parseSharedUsageState(bytes, this.policy);
			return parsed.status === "valid"
				? { status: "valid", state: parsed.state }
				: { status: "malformed", warning: malformedStateWarning() };
		} catch (error) {
			if (isErrnoException(error) && error.code === "ENOENT") {
				return { status: "absent" };
			}
			return {
				status: "unavailable",
				warning: warningForError(error),
				error,
			};
		}
	}

	async cleanAgedDebris(scope: string): Promise<void> {
		let names: string[];
		try {
			names = await readdir(scope);
		} catch (error) {
			if (isErrnoException(error) && error.code === "ENOENT") return;
			return;
		}
		const recognized = names
			.filter((name) =>
				RECOGNIZED_DEBRIS_PATTERNS.some((pattern) => pattern.test(name)),
			)
			.sort()
			.slice(0, this.policy.maxDebrisEntriesPerPass);
		for (const name of recognized) {
			const path = join(scope, name);
			try {
				const metadata = await stat(path);
				if (this.now() - metadata.mtimeMs <= this.policy.debrisGraceMs)
					continue;
				await this.fsFaultHooks.beforeDebrisRemoval?.({ path, name });
				await unlink(path);
				this.recordDiagnostic("debris-cleanup", scope, { name });
			} catch {
				// Cleanup is bounded, opportunistic, and race tolerant.
			}
		}
	}

	private async acquireStateWriteLease(scope: string): Promise<OwnedLease> {
		let waited = 0;
		const pollInterval = Math.max(1, this.policy.refreshJoinPollMs);
		while (waited <= this.policy.stateWriteAcquisitionTimeoutMs) {
			const lease = await this.tryAcquireLease(
				scope,
				STATE_WRITE_LEASE_NAME,
				this.policy.stateWriteLeaseMs,
			);
			if (lease) return lease;
			await sleep(pollInterval);
			waited += pollInterval;
		}
		throw new StateWriteLeaseTimeoutError(
			"Timed out acquiring the shared usage state-write lease.",
		);
	}

	private async inspectLease(
		path: string,
	): Promise<{ stale: boolean; record?: LeaseRecord }> {
		try {
			const metadata = await stat(path);
			const bytes = await this.readBounded(path, this.policy.maxLeaseBytes);
			if (bytes) {
				try {
					const value: unknown = JSON.parse(bytes.toString("utf8"));
					if (isLeaseRecord(value)) {
						return { stale: this.now() >= value.expiresAt, record: value };
					}
				} catch {
					// An incomplete lease gets initialization grace before recovery.
				}
			}
			return {
				stale:
					this.now() - metadata.mtimeMs >=
					this.policy.leaseInitializationGraceMs,
			};
		} catch (error) {
			if (isErrnoException(error) && error.code === "ENOENT") {
				return { stale: false };
			}
			throw error;
		}
	}

	private async readBounded(
		path: string,
		maximumBytes: number,
	): Promise<Buffer | undefined> {
		const handle = await open(path, "r");
		try {
			const metadata = await handle.stat();
			if (metadata.size > maximumBytes) return undefined;
			const bytes = Buffer.alloc(maximumBytes + 1);
			let offset = 0;
			while (offset < bytes.byteLength) {
				const read = await handle.read(
					bytes,
					offset,
					bytes.byteLength - offset,
					offset,
				);
				if (read.bytesRead === 0) return bytes.subarray(0, offset);
				offset += read.bytesRead;
			}
			return undefined;
		} finally {
			await handle.close();
		}
	}

	private async publishState(
		scope: string,
		state: SharedUsageState,
	): Promise<void> {
		let bytes: Buffer;
		try {
			bytes = Buffer.from(`${JSON.stringify(state)}\n`);
		} catch (error) {
			throw new Error("Shared usage state is not serializable.", {
				cause: error,
			});
		}

		const parsed = parseSharedUsageState(bytes, this.policy);
		if (parsed.status !== "valid") {
			if (parsed.status === "oversized") {
				throw new SharedStateSizeError(
					"Shared usage state exceeds the configured size limit.",
				);
			}
			throw new Error("Shared usage state failed canonical validation.");
		}

		const canonicalPath = join(scope, STATE_FILE_NAME);
		const retryDelays = [0, ...this.policy.publicationRetryDelaysMs];
		let lastError: unknown;
		for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
			if (attempt > 0) await sleep(retryDelays[attempt] ?? 0);
			const temporaryPath = join(
				scope,
				`${STATE_FILE_NAME}.tmp-${this.artifactId()}`,
			);
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				handle = await open(temporaryPath, "wx");
				await handle.writeFile(bytes);
				await handle.sync();
				await handle.close();
				handle = undefined;
				await this.fsFaultHooks.beforeStateRename?.({
					attempt,
					temporaryPath,
					canonicalPath,
				});
				await rename(temporaryPath, canonicalPath);
				await this.syncDirectoryBestEffort(scope);
				return;
			} catch (error) {
				lastError = error;
				await handle?.close().catch(() => {});
				await unlink(temporaryPath).catch(() => {});
				if (
					!isErrnoException(error) ||
					!TRANSIENT_REPLACEMENT_ERROR_CODES.has(error.code ?? "")
				) {
					throw error;
				}
			}
		}
		throw lastError;
	}

	private async syncDirectoryBestEffort(directory: string): Promise<void> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(directory, "r");
			await handle.sync();
		} catch {
			// Directory fsync is not uniformly supported, notably on Windows.
		} finally {
			await handle?.close().catch(() => {});
		}
	}

	private artifactId(): string {
		this.artifactSequence += 1;
		return createHash("sha256")
			.update(`${process.pid}:${this.artifactNonce}:${this.artifactSequence}`)
			.digest("hex");
	}
}
