import { createFilesystemUsageCoordination } from "../usage-coordination/filesystem";
import { PRODUCTION_USAGE_COORDINATION_POLICY } from "../usage-coordination/policy";

const [
	root,
	email,
	leaseMillisecondsText,
	forceText,
	actionText,
	usagePercentText,
] = process.argv.slice(2);
if (!root || !email) throw new Error("worker requires root and email");
const refreshLeaseMs = Number(leaseMillisecondsText ?? 500);
const action = actionText === "state-writer" ? "state-writer" : "refresh";
const usagePercent = Number(usagePercentText ?? 42);
let releaseWork: (() => void) | undefined;
const coordination = createFilesystemUsageCoordination({
	root,
	policy: {
		...PRODUCTION_USAGE_COORDINATION_POLICY,
		usageRequestTimeoutMs: 5_000,
		stateWriteLeaseMs: 300,
		refreshLeaseMs,
		leaseInitializationGraceMs: 20,
		stateWriteAcquisitionTimeoutMs: 2_000,
		refreshAcquisitionTimeoutMs: 2_000,
		refreshJoinPollMs: 10,
		publicationRetryDelaysMs: [1, 2],
		watchDebounceMs: 5,
		debrisGraceMs: 20,
	},
	fsFaultHooks:
		action === "state-writer"
			? {
					beforeStateRename: async () => {
						process.send?.({ type: "state-write-held" });
						await new Promise<void>((resolve) => {
							releaseWork = resolve;
						});
					},
				}
			: undefined,
});

process.on("message", (message: unknown) => {
	if (!message || typeof message !== "object") return;
	const type = (message as { type?: unknown }).type;
	if (type === "release") releaseWork?.();
	if (type !== "go") return;
	const work =
		action === "state-writer"
			? coordination.invalidate(email)
			: coordination.refresh(
					email,
					async () => {
						const fetchedAt = Date.now();
						process.send?.({ type: "fetch-started" });
						await new Promise<void>((resolve) => {
							releaseWork = resolve;
						});
						return { primary: { usedPercent: usagePercent }, fetchedAt };
					},
					{ force: forceText !== "false" },
				);
	void work
		.then((result) => {
			process.send?.({ type: "result", result });
			coordination.dispose();
			process.disconnect();
		})
		.catch((error) => {
			process.send?.({ type: "error", message: String(error) });
			process.exitCode = 1;
			process.disconnect();
		});
});

process.send?.({ type: "ready" });
