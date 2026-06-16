import type { Account } from "./storage";
import {
	type CodexUsageSnapshot,
	getPlanCapacityMultiplier,
	getWeeklyResetAt,
	isUsageUntouched,
} from "./usage";

const MIN_WEEKLY_RESET_HOURS = 0.25;
const WEEKLY_BURN_TIME_EXPONENT = 1.5;
const WEEKLY_BURN_SCORE_WEIGHT = 0.45;
const PRIMARY_REMAINING_SCORE_WEIGHT = 0.3;
const EFFECTIVE_REMAINING_SCORE_WEIGHT = 0.15;
const USAGE_CONFIDENCE_BONUS = 0.05;
const PRIMARY_THIN_UNITS = 0.15;
const PRIMARY_NEAR_ZERO_UNITS = 0.03;

interface RotationCandidate {
	account: Account;
	usage: CodexUsageSnapshot;
	primaryRemainingUnits: number;
	weeklyRemainingUnits?: number;
	effectiveRemainingUnits: number;
	weeklyBurnPressure: number;
	primaryGatePenalty: number;
	weeklyResetAt: number;
	score: number;
}

export function isAccountAvailable(account: Account, now: number): boolean {
	if (account.needsReauth) return false;
	return !account.quotaExhaustedUntil || account.quotaExhaustedUntil <= now;
}

function pickRandomAccount(accounts: Account[]): Account | undefined {
	if (accounts.length === 0) return undefined;
	return accounts[Math.floor(Math.random() * accounts.length)];
}

function getRemainingPercent(usedPercent?: number): number | undefined {
	if (typeof usedPercent !== "number") return undefined;
	return Math.max(0, 100 - usedPercent);
}

function getHoursUntilFutureReset(
	resetAt: number | undefined,
	now: number,
): number | undefined {
	if (typeof resetAt !== "number" || resetAt <= now) return undefined;
	return Math.max(MIN_WEEKLY_RESET_HOURS, (resetAt - now) / 3_600_000);
}

function getPrimaryGatePenalty(primaryRemainingUnits: number): number {
	if (primaryRemainingUnits <= PRIMARY_NEAR_ZERO_UNITS) return -1;
	if (primaryRemainingUnits <= PRIMARY_THIN_UNITS) return -0.25;
	return 0;
}

function normalize(value: number, max: number): number {
	if (!Number.isFinite(value) || value <= 0 || max <= 0) return 0;
	return Math.min(1, value / max);
}

function buildCandidate(
	account: Account,
	usage: CodexUsageSnapshot,
	now: number,
): Omit<RotationCandidate, "score"> | undefined {
	const primaryRemainingPercent = getRemainingPercent(
		usage.primary?.usedPercent,
	);
	if (primaryRemainingPercent === undefined) return undefined;

	const weeklyRemainingPercent = getRemainingPercent(
		usage.secondary?.usedPercent,
	);
	const multiplier = getPlanCapacityMultiplier(usage.planType);
	const primaryRemainingUnits = (primaryRemainingPercent / 100) * multiplier;
	const weeklyRemainingUnits =
		weeklyRemainingPercent === undefined
			? undefined
			: (weeklyRemainingPercent / 100) * multiplier;
	const effectiveRemainingUnits =
		weeklyRemainingUnits === undefined
			? primaryRemainingUnits
			: Math.min(primaryRemainingUnits, weeklyRemainingUnits);
	const weeklyResetAt = getWeeklyResetAt(usage) ?? Number.MAX_SAFE_INTEGER;
	const hoursUntilWeeklyReset = getHoursUntilFutureReset(weeklyResetAt, now);
	const weeklyBurnPressure =
		weeklyRemainingUnits === undefined || hoursUntilWeeklyReset === undefined
			? 0
			: weeklyRemainingUnits /
				hoursUntilWeeklyReset ** WEEKLY_BURN_TIME_EXPONENT;

	return {
		account,
		usage,
		primaryRemainingUnits,
		weeklyRemainingUnits,
		effectiveRemainingUnits,
		weeklyBurnPressure,
		primaryGatePenalty: getPrimaryGatePenalty(primaryRemainingUnits),
		weeklyResetAt,
	};
}

function scoreCandidates(
	candidates: Array<Omit<RotationCandidate, "score">>,
): RotationCandidate[] {
	const maxPrimary = Math.max(
		...candidates.map((candidate) => candidate.primaryRemainingUnits),
		0,
	);
	const maxEffective = Math.max(
		...candidates.map((candidate) => candidate.effectiveRemainingUnits),
		0,
	);
	const maxWeeklyBurn = Math.max(
		...candidates.map((candidate) => candidate.weeklyBurnPressure),
		0,
	);

	return candidates.map((candidate) => {
		const primaryScore = Math.sqrt(
			normalize(candidate.primaryRemainingUnits, maxPrimary),
		);
		const effectiveScore = normalize(
			candidate.effectiveRemainingUnits,
			maxEffective,
		);
		const weeklyBurnScore = normalize(
			candidate.weeklyBurnPressure,
			maxWeeklyBurn,
		);
		const untouchedBonus = isUsageUntouched(candidate.usage) ? 0.05 : 0;
		return {
			...candidate,
			score:
				WEEKLY_BURN_SCORE_WEIGHT * weeklyBurnScore +
				PRIMARY_REMAINING_SCORE_WEIGHT * primaryScore +
				EFFECTIVE_REMAINING_SCORE_WEIGHT * effectiveScore +
				USAGE_CONFIDENCE_BONUS +
				untouchedBonus +
				candidate.primaryGatePenalty,
		};
	});
}

export function pickBestAccount(
	accounts: Account[],
	usageByEmail: Map<string, CodexUsageSnapshot>,
	options?: { excludeEmails?: Set<string>; now?: number },
): Account | undefined {
	const now = options?.now ?? Date.now();
	const available = accounts.filter(
		(account) =>
			isAccountAvailable(account, now) &&
			!options?.excludeEmails?.has(account.email),
	);
	if (available.length === 0) return undefined;

	const candidates = available
		.map((account) => {
			const usage = usageByEmail.get(account.email);
			return usage ? buildCandidate(account, usage, now) : undefined;
		})
		.filter(
			(candidate): candidate is Omit<RotationCandidate, "score"> =>
				candidate !== undefined,
		);

	const ranked = scoreCandidates(candidates).sort((a, b) => {
		const scoreDiff = b.score - a.score;
		if (scoreDiff !== 0) return scoreDiff;
		return a.weeklyResetAt - b.weeklyResetAt;
	});

	return ranked[0]?.account ?? pickRandomAccount(available);
}
