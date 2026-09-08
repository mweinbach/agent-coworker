import {
  continuationMatchesTarget,
  type OpenAiContinuationProvider,
  type OpenAiContinuationState,
} from "../../shared/openaiContinuation";
import { asRecord } from "../../shared/recordParsing";
import type { ModelMessage } from "../../types";
import { modelMessagesToPiMessages } from "../piMessageBridge";
import { buildPiStreamOptions } from "../piRuntimeOptions";
import type { RuntimeRunTurnParams } from "../types";
import type { ResolvedPiRuntimeModel, RuntimeStepOverrides, RuntimeStepState } from "./types";

/** History is an activation hint only, intersected with live authority each step.
 * If compaction/pruning removes an anchor, its schema is unloaded until rediscovery.
 */
export async function resolveStepTools(
  params: RuntimeRunTurnParams,
  piMessages: Array<Record<string, unknown>>,
): Promise<RuntimeRunTurnParams["tools"]> {
  const hints = new Set<string>();
  for (const message of piMessages) {
    if (message.role !== "toolResult" || message.isError === true) continue;
    if (Array.isArray(message.addedToolNames)) {
      for (const name of message.addedToolNames) {
        if (typeof name === "string") hints.add(name);
      }
    }
  }
  const activated = params.deferredToolCatalog
    ? await params.deferredToolCatalog.resolveTools([...hints])
    : {};
  for (const message of piMessages) {
    if (message.role !== "toolResult") continue;
    const names =
      Array.isArray(message.addedToolNames) && message.isError !== true
        ? message.addedToolNames.filter(
            (name) =>
              typeof name === "string" &&
              Object.hasOwn(activated, name) &&
              !Object.hasOwn(params.tools, name),
          )
        : [];
    if (names.length > 0) message.addedToolNames = names;
    else delete message.addedToolNames;
  }
  return { ...activated, ...params.tools };
}

function isModelMessageArray(value: unknown): value is ModelMessage[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    const record = asRecord(entry);
    return !!record && typeof record.role === "string" && "content" in record;
  });
}

export function splitStepOverrides(raw: unknown): RuntimeStepOverrides {
  const parsed = asRecord(raw);
  if (!parsed) return {};

  const messages = isModelMessageArray(parsed.messages) ? parsed.messages : undefined;
  const providerOptions = asRecord(parsed.providerOptions) ?? undefined;
  const explicitStreamOptions = asRecord(parsed.streamOptions);

  const streamOptions: Record<string, unknown> = explicitStreamOptions
    ? { ...explicitStreamOptions }
    : {};
  if (!explicitStreamOptions) {
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "messages" || key === "providerOptions") continue;
      streamOptions[key] = value;
    }
  }

  return {
    ...(messages ? { messages } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(Object.keys(streamOptions).length > 0 ? { streamOptions } : {}),
  };
}

export function buildStepState(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
  overrides: RuntimeStepOverrides,
  fallbackMessages: ModelMessage[],
  includePiRequestPolicy = true,
): RuntimeStepState {
  const modelMessages = overrides.messages ?? fallbackMessages;
  const providerOptions = overrides.providerOptions ?? params.providerOptions;
  const baseStreamOptions = buildPiStreamOptions(
    { ...params, providerOptions } as RuntimeRunTurnParams,
    resolved.apiKey,
    resolved.headers,
    includePiRequestPolicy,
  );
  const streamOptions = {
    ...baseStreamOptions,
    ...(resolved.streamOptions ?? {}),
    ...(overrides.streamOptions ?? {}),
  };
  return {
    modelMessages,
    providerOptions,
    streamOptions,
    piMessages: modelMessagesToPiMessages(
      modelMessages,
      params.config.provider,
    ) as unknown as Array<Record<string, unknown>>,
  };
}

export function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (asRecord(error)?.name === "AbortError") return true;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("abort") || message.includes("cancel");
  }
  return false;
}

export function messagesAfterLastAssistant(messages: ModelMessage[]): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const record = asRecord(messages[i]);
    if (record?.role === "assistant") {
      return messages.slice(i + 1);
    }
  }
  return [...messages];
}

function continuationTarget(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
): { provider: OpenAiContinuationProvider; model: string; accountId?: string } {
  return {
    provider: params.config.provider as OpenAiContinuationProvider,
    model: params.config.model,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}

export function supportsProviderManagedContinuation(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
): boolean {
  if (params.config.provider === "openai") return true;
  if (params.config.provider !== "codex-cli") return false;
  return resolved.model.api === "openai-responses";
}

export function matchingProviderState(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
): OpenAiContinuationState | null {
  if (!supportsProviderManagedContinuation(params, resolved)) {
    return null;
  }
  const providerState = params.providerState ?? null;
  if (!providerState) return null;
  return continuationMatchesTarget(providerState, continuationTarget(params, resolved))
    ? providerState
    : null;
}

export function buildInitialStepMessages(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
): ModelMessage[] {
  if (!supportsProviderManagedContinuation(params, resolved)) {
    return [...params.messages];
  }
  const providerState = matchingProviderState(params, resolved);
  if (providerState) {
    const deltaMessages = messagesAfterLastAssistant(params.messages);
    return deltaMessages.length > 0 ? deltaMessages : [...params.messages];
  }
  return [...(params.allMessages ?? params.messages)];
}

export function nextProviderState(
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
  responseId?: string,
): OpenAiContinuationState | undefined {
  if (!supportsProviderManagedContinuation(params, resolved)) {
    return undefined;
  }
  const nextResponseId = responseId?.trim();
  if (!nextResponseId) return undefined;

  return {
    provider: params.config.provider as OpenAiContinuationProvider,
    model: params.config.model,
    responseId: nextResponseId,
    updatedAt: new Date().toISOString(),
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}
