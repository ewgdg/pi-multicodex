import { describe, expect, it, vi } from "vitest";
import type { AccountManager } from "./account-manager";
import { registerCommands } from "./commands";
import type { createUsageStatusController } from "./status";

function createStatusControllerMock() {
	return {
		refreshFor: vi.fn().mockResolvedValue(undefined),
		openPreferencesPanel: vi.fn().mockResolvedValue(undefined),
		loadPreferences: vi.fn().mockResolvedValue(undefined),
		getPreferences: vi.fn(() => ({
			usageMode: "left",
			resetWindow: "7d",
			showAccount: true,
			showReset: true,
			order: "account-first",
		})),
	} as unknown as ReturnType<typeof createUsageStatusController>;
}

function createAccountManagerMock(emails: string[] = []) {
	return {
		getAccounts: () => emails.map((email) => ({ email })),
	} as unknown as AccountManager;
}

describe("registerCommands", () => {
	it("registers only the multicodex command", () => {
		const registerCommand = vi.fn();
		registerCommands(
			{ registerCommand } as never,
			createAccountManagerMock(),
			createStatusControllerMock(),
		);

		expect(registerCommand).toHaveBeenCalledTimes(1);
		expect(registerCommand).toHaveBeenCalledWith(
			"multicodex",
			expect.objectContaining({
				description: expect.any(String),
				handler: expect.any(Function),
				getArgumentCompletions: expect.any(Function),
			}),
		);
	});

	it("returns dynamic autocomplete for subcommands and managed account identifiers", () => {
		const registerCommand = vi.fn();
		registerCommands(
			{ registerCommand } as never,
			createAccountManagerMock(["alpha@example.com", "beta@example.com"]),
			createStatusControllerMock(),
		);

		const commandOptions = registerCommand.mock.calls[0]?.[1] as {
			getArgumentCompletions: (
				prefix: string,
			) => Array<{ value: string; label: string }> | null;
		};

		const subcommands = commandOptions.getArgumentCompletions("");
		expect(subcommands?.map((item) => item.value)).toContain("accounts");
		expect(subcommands?.map((item) => item.value)).toContain("show");
		expect(subcommands?.map((item) => item.value)).toContain("use");
		expect(subcommands?.map((item) => item.value)).toContain("refresh");
		expect(subcommands?.map((item) => item.value)).toContain("reauth");

		const useAccounts = commandOptions.getArgumentCompletions("use a");
		expect(useAccounts).toEqual([
			{ value: "use alpha@example.com", label: "alpha@example.com" },
		]);

		const refreshAccounts = commandOptions.getArgumentCompletions("refresh a");
		expect(refreshAccounts).toContainEqual({
			value: "refresh alpha@example.com",
			label: "alpha@example.com",
		});
	});

	it("shows a non-interactive warning when no subcommand is provided", async () => {
		const registerCommand = vi.fn();
		registerCommands(
			{ registerCommand } as never,
			createAccountManagerMock(),
			createStatusControllerMock(),
		);

		const commandOptions = registerCommand.mock.calls[0]?.[1] as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const notify = vi.fn();
		await commandOptions.handler("", {
			hasUI: false,
			ui: { notify },
		});

		expect(notify).toHaveBeenCalledWith(
			"/multicodex requires a subcommand in non-interactive mode. Use /multicodex help.",
			"warning",
		);
	});

	it("shows rotation policy as info instead of a selectable menu", async () => {
		const registerCommand = vi.fn();
		registerCommands(
			{ registerCommand } as never,
			createAccountManagerMock(),
			createStatusControllerMock(),
		);

		const commandOptions = registerCommand.mock.calls[0]?.[1] as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const notify = vi.fn();
		const select = vi.fn();
		await commandOptions.handler("rotation", {
			hasUI: true,
			ui: { notify, select },
		});

		expect(select).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("tier-weighted score"),
			"info",
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("cache affinity"),
			"info",
		);
		expect(notify).toHaveBeenCalledWith(
			expect.not.stringContaining("lowest max 5h/weekly usage"),
			"info",
		);
	});

	it("reports explicit single-account refresh success only after fresh confirmation", async () => {
		const registerCommand = vi.fn();
		const account = { email: "person@example.com" };
		const manager = {
			getAccounts: () => [account],
			getAccount: () => account,
			getActiveAccount: () => account,
			getManualAccount: () => undefined,
			getCachedUsage: () => ({ fetchedAt: 1 }),
			isPiAuthAccount: () => false,
			ensureValidToken: vi.fn().mockResolvedValue("token"),
			refreshUsageForAccount: vi.fn().mockResolvedValue({
				availability: "fresh",
				source: "failure",
				snapshot: { fetchedAt: 1 },
				refreshOutcome: {
					token: "failed",
					startedAt: 0,
					completedAt: 1,
					outcome: "failure",
				},
			}),
		} as unknown as AccountManager;
		registerCommands(
			{ registerCommand } as never,
			manager,
			createStatusControllerMock(),
		);
		const command = registerCommand.mock.calls[0]?.[1] as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const notify = vi.fn();

		await command.handler("refresh person@example.com", {
			hasUI: false,
			ui: { notify },
		});

		expect(notify).toHaveBeenLastCalledWith(
			expect.stringContaining("not freshly confirmed"),
			"warning",
		);
		expect(notify).not.toHaveBeenCalledWith(
			expect.stringContaining("refreshed person@example.com"),
			"info",
		);
	});

	it("reports all-account refresh as degraded when any account lacks fresh confirmation", async () => {
		const registerCommand = vi.fn();
		const accounts = [
			{ email: "fresh@example.com" },
			{ email: "stale@example.com" },
		];
		const manager = {
			getAccounts: () => accounts,
			getAccountsNeedingReauth: () => [],
			refreshUsageForAllAccounts: vi.fn().mockResolvedValue({
				"fresh@example.com": {
					availability: "fresh",
					source: "owned-fetch",
					snapshot: { fetchedAt: 2 },
					refreshOutcome: {
						token: "success",
						startedAt: 1,
						completedAt: 2,
						outcome: "success",
					},
				},
				"stale@example.com": {
					availability: "stale",
					source: "retry-suppressed",
					snapshot: { fetchedAt: 1 },
				},
			}),
		} as unknown as AccountManager;
		registerCommands(
			{ registerCommand } as never,
			manager,
			createStatusControllerMock(),
		);
		const command = registerCommand.mock.calls[0]?.[1] as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const notify = vi.fn();

		await command.handler("refresh all", {
			hasUI: false,
			ui: { notify },
		});

		expect(notify).toHaveBeenLastCalledWith(
			"refresh: fresh=1 degraded=1; reauth needed=0",
			"warning",
		);
	});
});
