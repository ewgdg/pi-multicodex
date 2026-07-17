import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AccountManager } from "./account-manager";
import { isQuotaErrorMessage } from "./quota";
import {
	createErrorAssistantMessage,
	createLinkedAbortController,
	normalizeUnknownError,
	rewriteProviderOnEvent,
} from "./shared/streams";

const MAX_ROTATION_RETRIES = 5;

function producedOutput(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "toolcall_end":
			return true;
		default:
			return false;
	}
}

type ApiProviderRef = {
	streamSimple: (
		model: Model<"openai-codex-responses">,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
};

export function createStreamWrapper(
	accountManager: AccountManager,
	baseProvider: ApiProviderRef,
) {
	return (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();

		(async () => {
			try {
				await accountManager.waitUntilReady();
				const excludedEmails = new Set<string>();
				const selectAccount = async () => {
					const now = Date.now();
					const manual = accountManager.getAvailableManualAccount({
						excludeEmails: excludedEmails,
						now,
					});
					if (manual) {
						return { account: manual, usingManual: true };
					}
					if (accountManager.hasManualAccount()) {
						accountManager.clearManualAccount();
					}
					// Keep the session's active account sticky so provider-side prompt
					// cache stays warm across turns. Re-rank only when active is unusable.
					const active = accountManager.getAvailableActiveAccount({
						excludeEmails: excludedEmails,
						now,
					});
					if (active) {
						return { account: active, usingManual: false };
					}
					return {
						account: await accountManager.activateBestAccount({
							excludeEmails: excludedEmails,
							signal: options?.signal,
						}),
						usingManual: false,
					};
				};

				for (let attempt = 0; attempt <= MAX_ROTATION_RETRIES; attempt++) {
					let { account, usingManual } = await selectAccount();
					if (!account) {
						const cleared = await accountManager.reconcileQuotaCooldowns({
							excludeEmails: excludedEmails,
							signal: options?.signal,
						});
						if (cleared > 0) {
							({ account, usingManual } = await selectAccount());
						}
					}
					if (!account) {
						throw new Error(
							"No available Multicodex accounts. Please use /multicodex use <identifier>.",
						);
					}

					let token: string;
					try {
						token = await accountManager.ensureValidToken(account);
					} catch (error) {
						accountManager.notifyRotationSkipForAuthFailure(account, error);
						if (usingManual) {
							accountManager.clearManualAccount();
						}
						excludedEmails.add(account.email);
						if (attempt < MAX_ROTATION_RETRIES) {
							continue;
						}
						throw error;
					}
					const abortController = createLinkedAbortController(options?.signal);

					const internalModel: Model<"openai-codex-responses"> = {
						...(model as Model<"openai-codex-responses">),
						provider: "openai-codex",
						api: "openai-codex-responses",
					};

					const inner = baseProvider.streamSimple(
						{
							...internalModel,
							headers: {
								...(internalModel.headers || {}),
								"X-Multicodex-Account": account.email,
							},
						},
						context,
						{
							...options,
							apiKey: token,
							signal: abortController.signal,
						},
					);

					let producedOutputAny = false;
					let usageConsumptionRecorded = false;
					let retry = false;
					const bufferedEvents: AssistantMessageEvent[] = [];
					const recordUsageConsumption = () => {
						if (usageConsumptionRecorded) return;
						usageConsumptionRecorded = true;
						accountManager.recordUsageConsumption(account);
					};
					const flushBufferedEvents = () => {
						for (const bufferedEvent of bufferedEvents) {
							stream.push(
								rewriteProviderOnEvent(bufferedEvent, model.provider),
							);
						}
						bufferedEvents.length = 0;
					};
					const forwardEvent = (event: AssistantMessageEvent) => {
						if (producedOutputAny) {
							stream.push(rewriteProviderOnEvent(event, model.provider));
							return;
						}
						if (producedOutput(event)) {
							flushBufferedEvents();
							producedOutputAny = true;
							stream.push(rewriteProviderOnEvent(event, model.provider));
							return;
						}
						bufferedEvents.push(event);
					};

					try {
						for await (const event of inner) {
							if (event.type === "error") {
								const msg = event.error.errorMessage || "";
								const isQuota = isQuotaErrorMessage(msg);

								if (
									isQuota &&
									!producedOutputAny &&
									attempt < MAX_ROTATION_RETRIES
								) {
									await accountManager.handleQuotaExceeded(account, {
										signal: options?.signal,
									});
									if (usingManual) {
										accountManager.clearManualAccount();
									}
									excludedEmails.add(account.email);
									abortController.abort();
									bufferedEvents.length = 0;
									retry = true;
									break;
								}

								flushBufferedEvents();
								if (producedOutputAny) recordUsageConsumption();
								stream.push(rewriteProviderOnEvent(event, model.provider));
								stream.end();
								return;
							}

							if (event.type === "done") {
								flushBufferedEvents();
								stream.push(rewriteProviderOnEvent(event, model.provider));
								recordUsageConsumption();
								stream.end();
								return;
							}

							forwardEvent(event);
						}
					} catch (error) {
						if (!retry) {
							flushBufferedEvents();
							if (producedOutputAny) recordUsageConsumption();
						}
						throw error;
					}

					if (retry) {
						continue;
					}

					flushBufferedEvents();
					if (producedOutputAny) recordUsageConsumption();
					stream.end();
					return;
				}
			} catch (error) {
				const message = normalizeUnknownError(error);
				const errorEvent: AssistantMessageEvent = {
					type: "error",
					reason: "error",
					error: createErrorAssistantMessage(
						model,
						`Multicodex failed: ${message}`,
					),
				};
				stream.push(rewriteProviderOnEvent(errorEvent, model.provider));
				stream.end();
			}
		})();

		return stream;
	};
}
