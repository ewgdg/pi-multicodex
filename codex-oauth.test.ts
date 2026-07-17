import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	login: vi.fn(),
	refresh: vi.fn(),
	oauth: undefined as
		| {
				login: ReturnType<typeof vi.fn>;
				refresh: ReturnType<typeof vi.fn>;
		  }
		| undefined,
}));

vi.mock("@earendil-works/pi-ai/providers/openai-codex", () => ({
	openaiCodexProvider: () => ({ auth: { oauth: mocks.oauth } }),
}));

import { loginOpenAICodex, refreshOpenAICodexToken } from "./codex-oauth";

describe("OpenAI Codex OAuth adapter", () => {
	beforeEach(() => {
		mocks.login.mockReset();
		mocks.refresh.mockReset();
		mocks.oauth = {
			login: mocks.login,
			refresh: mocks.refresh,
		};
	});

	it("delegates login to pi's registered Codex OAuth provider", async () => {
		const interaction = {
			notify: vi.fn(),
			prompt: vi.fn(),
		};
		mocks.login.mockResolvedValue({
			access: "access",
			refresh: "refresh",
			expires: 1,
		});

		await expect(loginOpenAICodex(interaction)).resolves.toMatchObject({
			access: "access",
		});
		expect(mocks.login).toHaveBeenCalledWith(interaction);
	});

	it("refreshes a managed token through pi's Codex OAuth provider", async () => {
		mocks.refresh.mockResolvedValue({
			access: "new",
			refresh: "next",
			expires: 2,
		});

		await expect(refreshOpenAICodexToken("previous")).resolves.toMatchObject({
			access: "new",
		});
		expect(mocks.refresh).toHaveBeenCalledWith({
			type: "oauth",
			access: "",
			refresh: "previous",
			expires: 0,
		});
	});
});
