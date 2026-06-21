interface CodexUsageWindow {
	usedPercent?: number;
	resetAt?: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	allowed?: boolean;
	limitReached?: boolean;
}

export type CodexPlanType =
	| "free"
	| "go"
	| "plus"
	| "prolite"
	| "pro"
	| "team"
	| "business"
	| "enterprise"
	| "edu"
	| "unknown";

export interface CodexUsageSnapshot {
	primary?: CodexUsageWindow;
	secondary?: CodexUsageWindow;
	planType?: string;
	fetchedAt: number;
}

interface WhamUsageResponse {
	plan_type?: string;
	rate_limit?: {
		primary_window?: WhamUsageWindow;
		secondary_window?: WhamUsageWindow;
	};
}

type WhamUsageWindow = {
	allowed?: boolean;
	limit_reached?: boolean;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
	used_percent?: number;
};

export const PLAN_CAPACITY_MULTIPLIERS: Record<CodexPlanType, number> = {
	free: 0.1,
	go: 0.5,
	plus: 1,
	prolite: 5,
	pro: 20,
	team: 1,
	business: 1,
	enterprise: 1,
	edu: 1,
	unknown: 1,
};

function normalizeUsedPercent(value?: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(100, Math.max(0, value));
}

function normalizeResetAt(value?: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value * 1000;
}

function normalizePositiveSeconds(value?: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, value);
}

function normalizeBoolean(value?: boolean): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseUsageWindow(
	window?: WhamUsageWindow,
): CodexUsageWindow | undefined {
	if (!window) return undefined;
	const usedPercent = normalizeUsedPercent(window.used_percent);
	const resetAt = normalizeResetAt(window.reset_at);
	const limitWindowSeconds = normalizePositiveSeconds(
		window.limit_window_seconds,
	);
	const resetAfterSeconds = normalizePositiveSeconds(
		window.reset_after_seconds,
	);
	const allowed = normalizeBoolean(window.allowed);
	const limitReached = normalizeBoolean(window.limit_reached);
	if (
		usedPercent === undefined &&
		resetAt === undefined &&
		limitWindowSeconds === undefined &&
		resetAfterSeconds === undefined &&
		allowed === undefined &&
		limitReached === undefined
	) {
		return undefined;
	}
	return {
		usedPercent,
		resetAt,
		limitWindowSeconds,
		resetAfterSeconds,
		allowed,
		limitReached,
	};
}

export function parseCodexUsageResponse(
	data: WhamUsageResponse,
): Omit<CodexUsageSnapshot, "fetchedAt"> {
	return {
		primary: parseUsageWindow(data.rate_limit?.primary_window),
		secondary: parseUsageWindow(data.rate_limit?.secondary_window),
		planType: typeof data.plan_type === "string" ? data.plan_type : undefined,
	};
}

export function normalizeCodexPlanType(planType?: string): CodexPlanType {
	if (!planType) return "unknown";
	const compact = planType.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!compact) return "unknown";
	// Plan strings can arrive as short names (`plus`) or wrapped internal names
	// (`chatgptplusplan`). Match specific high-tier variants before broad `pro`.
	if (compact.includes("prolite") || compact.includes("prolites")) {
		return "prolite";
	}
	if (compact.includes("free")) return "free";
	if (compact === "go" || compact.includes("chatgptgo")) return "go";
	if (compact.includes("plus")) return "plus";
	if (compact.includes("team")) return "team";
	if (compact.includes("business")) return "business";
	if (compact.includes("enterprise")) return "enterprise";
	if (compact.includes("edu")) return "edu";
	if (compact.includes("pro")) return "pro";
	return "unknown";
}

export function getPlanCapacityMultiplier(planType?: string): number {
	return PLAN_CAPACITY_MULTIPLIERS[normalizeCodexPlanType(planType)];
}

export function isUsageUntouched(usage?: CodexUsageSnapshot): boolean {
	const primary = usage?.primary?.usedPercent;
	const secondary = usage?.secondary?.usedPercent;
	if (primary === undefined || secondary === undefined) return false;
	return primary === 0 && secondary === 0;
}

export function getNextResetAt(usage?: CodexUsageSnapshot): number | undefined {
	const candidates = [
		usage?.primary?.resetAt,
		usage?.secondary?.resetAt,
	].filter((value): value is number => typeof value === "number");
	if (candidates.length === 0) return undefined;
	return Math.min(...candidates);
}

export function getQuotaCooldownResetAt(
	usage: CodexUsageSnapshot | undefined,
	now: number,
): number | undefined {
	const windows = [usage?.primary, usage?.secondary].filter(
		(window): window is CodexUsageWindow => Boolean(window?.resetAt),
	);
	if (windows.length === 0) return undefined;

	const exhaustedResets = windows
		.filter(
			(window) => window.limitReached === true || window.usedPercent === 100,
		)
		.map((window) => window.resetAt)
		.filter(
			(resetAt): resetAt is number =>
				typeof resetAt === "number" && resetAt > now,
		);
	if (exhaustedResets.length > 0) {
		return Math.max(...exhaustedResets);
	}

	const mostConstrained = windows
		.filter(
			(window): window is CodexUsageWindow & { resetAt: number } =>
				typeof window.resetAt === "number" && window.resetAt > now,
		)
		.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0));
	return mostConstrained[0]?.resetAt;
}

export function getMaxUsedPercent(
	usage?: CodexUsageSnapshot,
): number | undefined {
	const candidates = [
		usage?.primary?.usedPercent,
		usage?.secondary?.usedPercent,
	].filter((value): value is number => typeof value === "number");
	if (candidates.length === 0) return undefined;
	return Math.max(...candidates);
}

export function isFreshUsageHealthyForQuotaCooldown(
	usage: CodexUsageSnapshot | undefined,
	maxUsedPercent = 99.5,
): boolean {
	const windows = [usage?.primary, usage?.secondary];
	return windows.every(
		(window) =>
			window !== undefined &&
			typeof window.usedPercent === "number" &&
			window.usedPercent < maxUsedPercent &&
			window.allowed !== false &&
			window.limitReached !== true,
	);
}

export function getWeeklyResetAt(
	usage?: CodexUsageSnapshot,
): number | undefined {
	const resetAt = usage?.secondary?.resetAt;
	return typeof resetAt === "number" ? resetAt : undefined;
}

export function formatResetAt(resetAt?: number): string {
	if (!resetAt) return "unknown";
	const diffMs = resetAt - Date.now();
	if (diffMs <= 0) return "now";
	const diffMinutes = Math.max(1, Math.round(diffMs / 60000));
	if (diffMinutes < 60) return `in ${diffMinutes}m`;
	const diffHours = Math.round(diffMinutes / 60);
	if (diffHours < 48) return `in ${diffHours}h`;
	const diffDays = Math.round(diffHours / 24);
	return `in ${diffDays}d`;
}
