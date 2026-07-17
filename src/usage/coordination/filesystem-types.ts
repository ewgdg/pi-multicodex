import type { FSWatcher } from "node:fs";
import type { UsageCoordinationPolicy } from "./policy";

export type FilesystemWatchFactory = (
	path: string,
	onChange: () => void,
) => FSWatcher;

export interface FilesystemUsageCoordinationFaultHooks {
	beforeStateRename?(context: {
		attempt: number;
		temporaryPath: string;
		canonicalPath: string;
	}): void | Promise<void>;
	beforeLeaseCreate?(context: {
		name: "state-write.lease" | "refresh.lease";
		path: string;
	}): void | Promise<void>;
	beforeDebrisRemoval?(context: {
		path: string;
		name: string;
	}): void | Promise<void>;
	beforeStateRead?(path: string): void | Promise<void>;
	watchFactory?: FilesystemWatchFactory;
}

export interface FilesystemUsageCoordinationOptions {
	root: string;
	now?: () => number;
	token?: () => string;
	policy?: UsageCoordinationPolicy;
	fsFaultHooks?: FilesystemUsageCoordinationFaultHooks;
}

export interface UsageCoordinationDiagnostic {
	at: number;
	action:
		| "lease-recovery"
		| "refresh-contention"
		| "duplicate-fetch"
		| "late-publication"
		| "local-fallback"
		| "watcher-recovery"
		| "debris-cleanup";
	scopeDigest: string;
	details?: Record<string, unknown>;
}
