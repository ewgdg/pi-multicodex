import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	SharedUsageChangeHandler,
	SharedUsageView,
	UsageCoordinationWarning,
} from "./contracts";
import type {
	FilesystemWatchFactory,
	UsageCoordinationDiagnostic,
} from "./filesystem-types";
import type { UsageCoordinationPolicy } from "./policy";

type DiagnosticRecorder = (
	action: UsageCoordinationDiagnostic["action"],
	scope: string,
	details?: Record<string, unknown>,
) => void;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export class FilesystemSubscriptionAdapter {
	private readonly handlers = new Map<string, Set<SharedUsageChangeHandler>>();
	private readonly lastNotifiedViews = new Map<string, string>();
	private watcher?: FSWatcher;
	private watchedPath?: string;
	private watchDebounce?: ReturnType<typeof setTimeout>;
	private watcherRetryTimer?: ReturnType<typeof setTimeout>;
	private watcherFailed = false;
	private disposed = false;

	constructor(
		private readonly root: string,
		private readonly policy: UsageCoordinationPolicy,
		private readonly read: (identity: string) => Promise<SharedUsageView>,
		private readonly recordDiagnostic: DiagnosticRecorder,
		private readonly watchFactory: FilesystemWatchFactory = (path, onChange) =>
			watch(path, { persistent: false, recursive: true }, onChange),
	) {}

	subscribe(identity: string, handler: SharedUsageChangeHandler): () => void {
		if (this.disposed) return () => {};
		const handlers = this.handlers.get(identity) ?? new Set();
		handlers.add(handler);
		this.handlers.set(identity, handlers);
		void this.ensureWatcher();
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.handlers.delete(identity);
				this.lastNotifiedViews.delete(identity);
			}
			if (this.handlers.size === 0) this.closeWatcher();
		};
	}

	notify(identity: string, view: SharedUsageView): void {
		const serialized = JSON.stringify(view);
		if (this.lastNotifiedViews.get(identity) === serialized) return;
		this.lastNotifiedViews.set(identity, serialized);
		for (const handler of this.handlers.get(identity) ?? []) {
			try {
				handler(view);
			} catch {
				// A subscriber cannot invalidate a completed shared publication.
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.handlers.clear();
		this.lastNotifiedViews.clear();
		this.closeWatcher();
	}

	private async ensureWatcher(): Promise<void> {
		if (this.watcher || this.disposed || this.handlers.size === 0) return;
		try {
			const watchPath = await this.findNearestExistingDirectory(this.root);
			if (this.watcher || this.disposed || this.handlers.size === 0) return;
			this.watchedPath = watchPath;
			this.watcher = this.watchFactory(watchPath, () =>
				this.scheduleWatchReconciliation(),
			);
			if (this.watcherFailed) {
				this.watcherFailed = false;
				this.recordDiagnostic("watcher-recovery", this.root);
			}
			this.watcher.on("error", () => {
				this.closeActiveWatcher();
				this.watcherFailed = true;
				void this.notifyWatcherFailure();
				this.scheduleWatcherRetry();
			});
		} catch (error) {
			this.watcherFailed = true;
			await this.notifyWatcherFailure(error);
			this.scheduleWatcherRetry();
		}
	}

	private async findNearestExistingDirectory(path: string): Promise<string> {
		let candidate = path;
		while (true) {
			try {
				const metadata = await stat(candidate);
				if (metadata.isDirectory()) return candidate;
			} catch (error) {
				if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
			}
			const parent = dirname(candidate);
			if (parent === candidate) return candidate;
			candidate = parent;
		}
	}

	private scheduleWatcherRetry(): void {
		if (this.watcherRetryTimer || this.disposed || this.handlers.size === 0) {
			return;
		}
		this.watcherRetryTimer = setTimeout(() => {
			this.watcherRetryTimer = undefined;
			void this.ensureWatcher();
		}, this.policy.freshnessIntervalMs);
		this.watcherRetryTimer.unref?.();
	}

	private scheduleWatchReconciliation(): void {
		if (this.watchDebounce) clearTimeout(this.watchDebounce);
		this.watchDebounce = setTimeout(() => {
			this.watchDebounce = undefined;
			void this.reconcileSubscriptions();
		}, this.policy.watchDebounceMs);
		this.watchDebounce.unref?.();
	}

	private async reconcileSubscriptions(): Promise<void> {
		await Promise.all(
			[...this.handlers.keys()].map(async (identity) => {
				this.notify(identity, await this.read(identity));
			}),
		);
		await this.rebindWatcherIfNeeded();
	}

	private async rebindWatcherIfNeeded(): Promise<void> {
		if (!this.watcher || this.disposed || this.handlers.size === 0) return;
		try {
			const desiredPath = await this.findNearestExistingDirectory(this.root);
			if (desiredPath === this.watchedPath) return;
			this.closeActiveWatcher();
			this.recordDiagnostic("watcher-recovery", this.root, {
				reboundToCoordinationRoot: desiredPath === this.root,
			});
			await this.ensureWatcher();
		} catch (error) {
			this.closeActiveWatcher();
			this.watcherFailed = true;
			await this.notifyWatcherFailure(error);
			this.scheduleWatcherRetry();
		}
	}

	private async notifyWatcherFailure(error?: unknown): Promise<void> {
		const warning: UsageCoordinationWarning = {
			code: "watcher-failed",
			message: "Shared usage change notifications are unavailable.",
		};
		await Promise.all(
			[...this.handlers.keys()].map(async (identity) => {
				const current = await this.read(identity);
				this.notify(identity, { ...current, warning });
			}),
		);
		void error;
	}

	private closeActiveWatcher(): void {
		this.watcher?.close();
		this.watcher = undefined;
		this.watchedPath = undefined;
	}

	private closeWatcher(): void {
		if (this.watchDebounce) clearTimeout(this.watchDebounce);
		this.watchDebounce = undefined;
		if (this.watcherRetryTimer) clearTimeout(this.watcherRetryTimer);
		this.watcherRetryTimer = undefined;
		this.closeActiveWatcher();
	}
}
