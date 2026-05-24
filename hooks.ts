import type { AccountManager } from "./account-manager";

type WarningHandler = (message: string) => void;

async function refreshAndActivateBestAccount(
	accountManager: AccountManager,
	warningHandler?: WarningHandler,
): Promise<void> {
	accountManager.beginInitialization();
	try {
		await accountManager.loadPiAuth();
		// Pi auth is ephemeral, so it only appears after loadPiAuth runs.
		if (accountManager.getAccounts().length === 0) return;

		await accountManager.refreshUsageForAllAccounts({ force: true });

		const needsReauth = accountManager.getAccountsNeedingReauth();
		if (needsReauth.length > 0) {
			const hints = needsReauth.map(
				(a) => `${a.email} (/multicodex use ${a.email})`,
			);
			warningHandler?.(
				`Multicodex: ${needsReauth.length} account(s) need re-authentication: ${hints.join(", ")}`,
			);
		}

		const manual = accountManager.getAvailableManualAccount();
		if (manual) return;
		if (accountManager.hasManualAccount()) {
			accountManager.clearManualAccount();
		}
		await accountManager.activateBestAccount();
	} finally {
		accountManager.markReady();
	}
}

export function handleSessionStart(
	accountManager: AccountManager,
	warningHandler?: WarningHandler,
): void {
	refreshAndActivateBestAccount(accountManager, warningHandler).catch(() => {});
}

export function handleNewSessionSwitch(
	accountManager: AccountManager,
	warningHandler?: WarningHandler,
): void {
	refreshAndActivateBestAccount(accountManager, warningHandler).catch(() => {});
}
