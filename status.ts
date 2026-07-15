import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import type { AccountManager } from "./account-manager";
import { PROVIDER_ID } from "./provider";
import {
	getAgentSettingsPath,
	readJsonObjectFileAsync,
	writeJsonObjectFileAsync,
} from "./shared/agent-paths";
import { type CodexUsageSnapshot, formatResetAt } from "./usage";

const STATUS_KEY = "multicodex-usage";
const SETTINGS_KEY = "pi-multicodex";
const SETTINGS_FILE = getAgentSettingsPath();
const MODEL_SELECT_REFRESH_DEBOUNCE_MS = 250;
const UNKNOWN_PERCENT = "--";
const BRAND_LABEL = "Codex";
const SELECTING_ACCOUNT_LABEL = "selecting account...";
const SEGMENT_SEPARATOR = "·";
const FIVE_HOUR_LABEL = "5h:";
const SEVEN_DAY_LABEL = "7d:";

type MaybeModel = Model<Api> | undefined;
export type PercentDisplayMode = "left" | "used";
export type ResetWindowMode = "5h" | "7d" | "both";
export type StatusOrder = "account-first" | "usage-first";

export interface FooterPreferences {
	usageMode: PercentDisplayMode;
	resetWindow: ResetWindowMode;
	showAccount: boolean;
	showReset: boolean;
	order: StatusOrder;
}

const DEFAULT_PREFERENCES: FooterPreferences = {
	usageMode: "left",
	resetWindow: "7d",
	showAccount: true,
	showReset: true,
	order: "account-first",
};

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function isPercentDisplayMode(value: unknown): value is PercentDisplayMode {
	return value === "left" || value === "used";
}

function isResetWindowMode(value: unknown): value is ResetWindowMode {
	return value === "5h" || value === "7d" || value === "both";
}

function isStatusOrder(value: unknown): value is StatusOrder {
	return value === "account-first" || value === "usage-first";
}

function normalizePreferences(value: unknown): FooterPreferences {
	const record = asObject(value);
	return {
		usageMode: isPercentDisplayMode(record?.usageMode)
			? record.usageMode
			: DEFAULT_PREFERENCES.usageMode,
		resetWindow: isResetWindowMode(record?.resetWindow)
			? record.resetWindow
			: DEFAULT_PREFERENCES.resetWindow,
		showAccount:
			typeof record?.showAccount === "boolean"
				? record.showAccount
				: DEFAULT_PREFERENCES.showAccount,
		showReset:
			typeof record?.showReset === "boolean"
				? record.showReset
				: DEFAULT_PREFERENCES.showReset,
		order: isStatusOrder(record?.order)
			? record.order
			: DEFAULT_PREFERENCES.order,
	};
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
	return readJsonObjectFileAsync(SETTINGS_FILE);
}

async function writeSettingsFile(
	settings: Record<string, unknown>,
): Promise<void> {
	await writeJsonObjectFileAsync(SETTINGS_FILE, settings);
}

export async function loadFooterPreferences(): Promise<FooterPreferences> {
	const settings = await readSettingsFile();
	return normalizePreferences(settings[SETTINGS_KEY]);
}

export async function persistFooterPreferences(
	preferences: FooterPreferences,
): Promise<void> {
	const settings = await readSettingsFile();
	settings[SETTINGS_KEY] = {
		...asObject(settings[SETTINGS_KEY]),
		...preferences,
	};
	await writeSettingsFile(settings);
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function usedToDisplayPercent(
	value: number | undefined,
	mode: PercentDisplayMode,
): number | undefined {
	if (typeof value !== "number" || Number.isNaN(value)) return undefined;
	const left = clampPercent(100 - value);
	return mode === "left" ? left : clampPercent(100 - left);
}

function formatBrand(ctx: ExtensionContext): string {
	return ctx.ui.theme.fg("muted", BRAND_LABEL);
}

function formatLoading(ctx: ExtensionContext): string {
	return ctx.ui.theme.fg("muted", "loading...");
}

function formatSeparator(ctx: ExtensionContext): string {
	return ctx.ui.theme.fg("muted", SEGMENT_SEPARATOR);
}

function getUsageSeverityToken(
	displayPercent: number | undefined,
	mode: PercentDisplayMode,
): "success" | "thinkingMedium" | "warning" | "error" | "dim" {
	if (typeof displayPercent !== "number" || Number.isNaN(displayPercent)) {
		return "dim";
	}

	if (mode === "left") {
		if (displayPercent <= 10) return "error";
		if (displayPercent <= 25) return "warning";
		if (displayPercent <= 50) return "thinkingMedium";
		return "success";
	}

	if (displayPercent >= 90) return "error";
	if (displayPercent >= 75) return "warning";
	if (displayPercent >= 50) return "thinkingMedium";
	return "success";
}

function formatPercent(
	displayPercent: number | undefined,
	mode: PercentDisplayMode,
): string {
	if (typeof displayPercent !== "number" || Number.isNaN(displayPercent)) {
		return UNKNOWN_PERCENT;
	}

	return `${Math.round(clampPercent(displayPercent))}% ${mode}`;
}

export function formatUsageSummaryText(
	usage: CodexUsageSnapshot | undefined,
	mode: PercentDisplayMode = "left",
): string {
	const primaryDisplay = usedToDisplayPercent(
		usage?.primary?.usedPercent,
		mode,
	);
	const secondaryDisplay = usedToDisplayPercent(
		usage?.secondary?.usedPercent,
		mode,
	);
	const primaryLabel =
		primaryDisplay === undefined
			? "unknown"
			: formatPercent(primaryDisplay, mode);
	const secondaryLabel =
		secondaryDisplay === undefined
			? "unknown"
			: formatPercent(secondaryDisplay, mode);
	return `5h ${primaryLabel} reset:${formatResetAt(usage?.primary?.resetAt)} | weekly ${secondaryLabel} reset:${formatResetAt(usage?.secondary?.resetAt)}`;
}

function formatResetCountdown(resetAt: number | undefined): string | undefined {
	if (typeof resetAt !== "number" || Number.isNaN(resetAt)) return undefined;
	const totalSeconds = Math.max(0, Math.round((resetAt - Date.now()) / 1000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

function shouldShowReset(
	preferences: FooterPreferences,
	window: Exclude<ResetWindowMode, "both">,
): boolean {
	if (!preferences.showReset) return false;
	return (
		preferences.resetWindow === "both" || preferences.resetWindow === window
	);
}

function formatUsageSegment(
	ctx: ExtensionContext,
	label: string,
	usedPercent: number | undefined,
	resetAt: number | undefined,
	showReset: boolean,
	preferences: FooterPreferences,
): string {
	const displayPercent = usedToDisplayPercent(
		usedPercent,
		preferences.usageMode,
	);
	const parts = [
		`${label}${formatPercent(displayPercent, preferences.usageMode)}`,
	];
	if (showReset) {
		const countdown = formatResetCountdown(resetAt);
		if (countdown) {
			parts.push(`(↺${countdown})`);
		}
	}
	return ctx.ui.theme.fg(
		getUsageSeverityToken(displayPercent, preferences.usageMode),
		parts.join(" "),
	);
}

export function isManagedModel(model: MaybeModel): boolean {
	return model?.provider === PROVIDER_ID;
}

function formatUnavailableAccountStatus(
	ctx: ExtensionContext,
	account: ReturnType<AccountManager["getActiveAccount"]>,
): string | undefined {
	if (!account) {
		return ctx.ui.theme.fg("warning", "Multicodex no active account");
	}

	if (account.needsReauth) {
		return ctx.ui.theme.fg(
			"warning",
			`Multicodex ${account.email} needs reauth`,
		);
	}

	return undefined;
}

export function formatActiveAccountStatus(
	ctx: ExtensionContext,
	accountEmail: string,
	usage: CodexUsageSnapshot | undefined,
	preferences: FooterPreferences,
): string {
	const accountText = preferences.showAccount
		? ctx.ui.theme.fg("text", accountEmail)
		: undefined;
	if (!usage) {
		return [formatBrand(ctx), accountText, formatLoading(ctx)]
			.filter(Boolean)
			.join(" ");
	}

	const fiveHour = formatUsageSegment(
		ctx,
		FIVE_HOUR_LABEL,
		usage.primary?.usedPercent,
		usage.primary?.resetAt,
		shouldShowReset(preferences, "5h"),
		preferences,
	);
	const sevenDay = formatUsageSegment(
		ctx,
		SEVEN_DAY_LABEL,
		usage.secondary?.usedPercent,
		usage.secondary?.resetAt,
		shouldShowReset(preferences, "7d"),
		preferences,
	);

	const usageSegments = [fiveHour, sevenDay].filter(Boolean);
	const usageText = usageSegments.join(` ${formatSeparator(ctx)} `);
	const leading =
		preferences.order === "account-first"
			? [formatBrand(ctx), accountText, usageText]
			: [formatBrand(ctx), usageText];
	const trailing =
		preferences.order === "account-first" ? [] : [accountText].filter(Boolean);

	return [...leading, ...trailing]
		.filter(Boolean)
		.join(` ${formatSeparator(ctx)} `);
}

function getBooleanLabel(value: boolean): string {
	return value ? "on" : "off";
}

function createSettingsItems(preferences: FooterPreferences): SettingItem[] {
	return [
		{
			id: "usageMode",
			label: "Usage display",
			description: "Show remaining or consumed quota percentages",
			currentValue: preferences.usageMode,
			values: ["left", "used"],
		},
		{
			id: "resetWindow",
			label: "Reset countdown window",
			description:
				"Choose whether the footer shows the 5h countdown, the 7d countdown, or both",
			currentValue: preferences.resetWindow,
			values: ["5h", "7d", "both"],
		},
		{
			id: "showAccount",
			label: "Show account",
			description: "Display the active account identifier in the footer",
			currentValue: getBooleanLabel(preferences.showAccount),
			values: ["on", "off"],
		},
		{
			id: "showReset",
			label: "Show reset countdown",
			description:
				"Display a reset countdown like the codex usage footer extension",
			currentValue: getBooleanLabel(preferences.showReset),
			values: ["on", "off"],
		},
		{
			id: "order",
			label: "Footer order",
			description:
				"Choose whether the account appears before or after usage fields",
			currentValue: preferences.order,
			values: ["account-first", "usage-first"],
		},
	];
}

function applyPreferenceChange(
	preferences: FooterPreferences,
	id: string,
	newValue: string,
): FooterPreferences {
	if (id === "usageMode" && isPercentDisplayMode(newValue)) {
		return { ...preferences, usageMode: newValue };
	}
	if (id === "resetWindow" && isResetWindowMode(newValue)) {
		return { ...preferences, resetWindow: newValue };
	}
	if (id === "showAccount") {
		return { ...preferences, showAccount: newValue === "on" };
	}
	if (id === "showReset") {
		return { ...preferences, showReset: newValue === "on" };
	}
	if (id === "order" && isStatusOrder(newValue)) {
		return { ...preferences, order: newValue };
	}
	return preferences;
}

export function createUsageStatusController(accountManager: AccountManager) {
	let modelSelectTimer: ReturnType<typeof setTimeout> | undefined;
	let activeContext: ExtensionContext | undefined;
	let isRunning = true;
	let lifecycleVersion = 0;
	let refreshInFlight = false;
	let queuedRefresh = false;
	let usageObserverUnsubscribe: (() => void) | undefined;
	let usageObserverEligible: boolean | undefined;
	let preferences: FooterPreferences = DEFAULT_PREFERENCES;
	let livePreviewPreferences: FooterPreferences | undefined;

	function isCurrentContext(ctx: ExtensionContext, version: number): boolean {
		return isRunning && activeContext === ctx && lifecycleVersion === version;
	}

	function isAccountManagerInitializing(): boolean {
		const candidate = accountManager as AccountManager & {
			isInitializing?: () => boolean;
		};
		return candidate.isInitializing?.() ?? false;
	}

	function stopUsageObserver(): void {
		usageObserverUnsubscribe?.();
		usageObserverUnsubscribe = undefined;
	}

	function syncUsageObserver(
		ctx: ExtensionContext,
		shouldBeActive: boolean,
	): void {
		let hasUI: boolean;
		try {
			hasUI = ctx.hasUI;
		} catch {
			stopUsageObserver();
			return;
		}

		const active = shouldBeActive && isRunning && hasUI;
		if (active && !usageObserverUnsubscribe) {
			const version = lifecycleVersion;
			usageObserverUnsubscribe = accountManager.subscribeUsageObserver(() => {
				const currentContext = activeContext;
				if (!currentContext || !isRunning || lifecycleVersion !== version)
					return;
				renderCachedStatus(
					currentContext,
					livePreviewPreferences ?? preferences,
				);
			});
		}
		if (!active) stopUsageObserver();
	}

	function syncUsageObserverForContext(ctx: ExtensionContext): void {
		let modelEligible: boolean;
		try {
			modelEligible = ctx.hasUI && isManagedModel(ctx.model);
		} catch {
			stopUsageObserver();
			return;
		}
		if (usageObserverEligible === undefined) {
			usageObserverEligible = modelEligible;
		}
		syncUsageObserver(ctx, usageObserverEligible && modelEligible);
	}

	function withLiveContext<T>(
		ctx: ExtensionContext,
		operation: () => T,
	): T | undefined {
		try {
			return operation();
		} catch {
			if (activeContext === ctx) {
				activeContext = undefined;
				queuedRefresh = false;
				stopUsageObserver();
			}
			return undefined;
		}
	}

	accountManager.onStateChange(() => {
		if (!activeContext || !isRunning) return;
		renderCachedStatus(activeContext, livePreviewPreferences ?? preferences);
	});

	function clearStatus(ctx?: ExtensionContext): void {
		if (!ctx) return;
		withLiveContext(ctx, () => ctx.ui.setStatus(STATUS_KEY, undefined));
	}

	async function ensurePreferencesLoaded(): Promise<void> {
		preferences = await loadFooterPreferences();
	}

	function getStatusText(
		ctx: ExtensionContext,
		preferencesOverride?: FooterPreferences,
	): string | undefined {
		return withLiveContext(ctx, () => {
			if (!ctx.hasUI) return undefined;
			if (!isManagedModel(ctx.model)) return undefined;

			if (isAccountManagerInitializing()) {
				return [
					formatBrand(ctx),
					ctx.ui.theme.fg("muted", SELECTING_ACCOUNT_LABEL),
				].join(" ");
			}

			const activeAccount = accountManager.getActiveAccount();
			const unavailableStatus = formatUnavailableAccountStatus(
				ctx,
				activeAccount,
			);
			if (unavailableStatus || !activeAccount) return unavailableStatus;

			return formatActiveAccountStatus(
				ctx,
				activeAccount.email,
				accountManager.getCachedUsage(activeAccount.email),
				preferencesOverride ?? preferences,
			);
		});
	}

	function renderCachedStatus(
		ctx: ExtensionContext,
		preferencesOverride?: FooterPreferences,
	): void {
		syncUsageObserverForContext(ctx);
		withLiveContext(ctx, () => {
			if (!ctx.hasUI) {
				return;
			}
			if (!isManagedModel(ctx.model)) {
				clearStatus(ctx);
				return;
			}

			const text = getStatusText(ctx, preferencesOverride);
			if (text) {
				ctx.ui.setStatus(STATUS_KEY, text);
			}
		});
	}

	async function updateStatus(
		ctx: ExtensionContext,
		version: number,
	): Promise<void> {
		if (!isCurrentContext(ctx, version)) return;
		syncUsageObserverForContext(ctx);
		const activeAccount = withLiveContext(ctx, () => {
			if (!ctx.hasUI) {
				return undefined;
			}
			if (!isManagedModel(ctx.model)) {
				clearStatus(ctx);
				return undefined;
			}

			renderCachedStatus(ctx, livePreviewPreferences ?? preferences);
			if (isAccountManagerInitializing()) return undefined;

			const account = accountManager.getActiveAccount();
			const unavailableStatus = formatUnavailableAccountStatus(ctx, account);
			if (unavailableStatus || !account) {
				if (unavailableStatus) {
					ctx.ui.setStatus(STATUS_KEY, unavailableStatus);
				}
				return undefined;
			}
			return account;
		});
		if (!activeAccount) return;

		const cachedUsage = accountManager.getCachedUsage(activeAccount.email);
		const refreshResult = await accountManager.refreshUsageForAccount(
			activeAccount,
			{
				warningHandler: (message) => {
					if (isCurrentContext(ctx, version)) {
						withLiveContext(ctx, () => ctx.ui.notify(message, "warning"));
					}
				},
			},
		);
		const usage = refreshResult.snapshot ?? cachedUsage;
		if (!isCurrentContext(ctx, version)) return;
		syncUsageObserverForContext(ctx);
		const canRender = withLiveContext(ctx, () => {
			if (!isCurrentContext(ctx, version)) return false;
			return (
				usageObserverEligible !== false &&
				ctx.hasUI &&
				isManagedModel(ctx.model)
			);
		});
		if (!canRender) return;
		withLiveContext(ctx, () =>
			ctx.ui.setStatus(
				STATUS_KEY,
				formatActiveAccountStatus(
					ctx,
					activeAccount.email,
					usage,
					livePreviewPreferences ?? preferences,
				),
			),
		);
	}

	async function refreshFor(ctx: ExtensionContext): Promise<void> {
		if (!isRunning) return;
		if (activeContext !== ctx) usageObserverEligible = undefined;
		activeContext = ctx;
		const version = lifecycleVersion;
		if (refreshInFlight) {
			queuedRefresh = true;
			return;
		}

		refreshInFlight = true;
		try {
			await updateStatus(ctx, version);
		} finally {
			refreshInFlight = false;
			if (queuedRefresh) {
				queuedRefresh = false;
				if (activeContext && isCurrentContext(ctx, version)) {
					await refreshFor(activeContext);
				}
			}
		}
	}

	function scheduleModelSelectRefresh(ctx: ExtensionContext): void {
		if (!isRunning) return;
		if (activeContext !== ctx) usageObserverEligible = undefined;
		activeContext = ctx;
		const version = lifecycleVersion;
		renderCachedStatus(ctx, livePreviewPreferences ?? preferences);
		if (modelSelectTimer) {
			clearTimeout(modelSelectTimer);
		}
		modelSelectTimer = setTimeout(() => {
			modelSelectTimer = undefined;
			if (!isCurrentContext(ctx, version)) return;
			void refreshFor(ctx);
		}, MODEL_SELECT_REFRESH_DEBOUNCE_MS);
		modelSelectTimer.unref?.();
	}

	function startSession(): void {
		stopUsageObserver();
		if (modelSelectTimer) {
			clearTimeout(modelSelectTimer);
			modelSelectTimer = undefined;
		}
		isRunning = true;
		lifecycleVersion += 1;
		activeContext = undefined;
		queuedRefresh = false;
		usageObserverEligible = undefined;
	}

	function stopSession(ctx?: ExtensionContext): void {
		isRunning = false;
		lifecycleVersion += 1;
		if (modelSelectTimer) {
			clearTimeout(modelSelectTimer);
			modelSelectTimer = undefined;
		}
		stopUsageObserver();
		livePreviewPreferences = undefined;
		clearStatus(ctx ?? activeContext);
		activeContext = undefined;
		queuedRefresh = false;
		usageObserverEligible = undefined;
	}

	async function loadPreferences(ctx?: ExtensionContext): Promise<void> {
		const version = lifecycleVersion;
		try {
			await ensurePreferencesLoaded();
		} catch (error) {
			preferences = DEFAULT_PREFERENCES;
			if (!ctx) return;
			if (isRunning && (!activeContext || isCurrentContext(ctx, version))) {
				withLiveContext(ctx, () =>
					ctx.ui.notify(
						`Multicodex: failed to load ${SETTINGS_FILE}: ${String(error)}`,
						"warning",
					),
				);
			}
		}
	}

	function renderPreviewLabel(
		ctx: ExtensionContext,
		theme: ExtensionCommandContext["ui"]["theme"],
		draft: FooterPreferences,
	): string {
		const previewText =
			getStatusText(ctx, draft) ?? `${formatBrand(ctx)} ${formatLoading(ctx)}`;
		return `${theme.fg("dim", "Preview")}: ${previewText}`;
	}

	async function openPreferencesPanel(
		ctx: ExtensionCommandContext,
	): Promise<void> {
		await loadPreferences(ctx);
		let draft = preferences;
		livePreviewPreferences = draft;
		renderCachedStatus(ctx, livePreviewPreferences);

		await ctx.ui.custom((_tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(
				new Text(theme.fg("accent", theme.bold("MultiCodex Footer")), 1, 0),
			);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						"Configure the usage footer to match the codex usage extension style.",
					),
					1,
					0,
				),
			);
			const previewText = new Text(renderPreviewLabel(ctx, theme, draft), 1, 0);
			container.addChild(previewText);

			const settingsList = new SettingsList(
				createSettingsItems(draft),
				9,
				getSettingsListTheme(),
				(id: string, newValue: string) => {
					draft = applyPreferenceChange(draft, id, newValue);
					livePreviewPreferences = draft;
					settingsList.updateValue(id, newValue);
					previewText.setText(renderPreviewLabel(ctx, theme, draft));
					container.invalidate();
					renderCachedStatus(ctx, draft);
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settingsList);

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => settingsList.handleInput(data),
			};
		});

		preferences = draft;
		livePreviewPreferences = undefined;
		await persistFooterPreferences(preferences);
		await refreshFor(ctx);
	}

	function setUsageObserverActive(
		ctx: ExtensionContext,
		active: boolean,
	): void {
		activeContext = ctx;
		usageObserverEligible = active;
		if (!active) {
			if (modelSelectTimer) {
				clearTimeout(modelSelectTimer);
				modelSelectTimer = undefined;
			}
			clearStatus(ctx);
		}
		if (active) {
			syncUsageObserverForContext(ctx);
		} else {
			syncUsageObserver(ctx, false);
		}
	}

	return {
		loadPreferences,
		openPreferencesPanel,
		refreshFor,
		scheduleModelSelectRefresh,
		setUsageObserverActive,
		startSession,
		stopSession,
		getPreferences: () => preferences,
	};
}
