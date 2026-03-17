import OpenAI from "openai";

import {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  buildOpenAiContinuationRequestOptions,
  type PiModel,
} from "./piRuntimeOptions";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "./openaiResponsesShared";
import { CODEX_OAUTH_ORIGINATOR } from "../providers/codex-auth";

type OpenAiCompatibleProvider = "openai" | "codex-cli";

type OpenAiNativeStreamOptions = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  temperature?: number;
  reasoningEffort?: string;
  reasoningSummary?: string;
  textVerbosity?: string;
  webSearchBackend?: string;
  webSearchMode?: string;
  webSearchContextSize?: string;
  webSearchAllowedDomains?: string[];
  webSearchLocation?: {
    country?: string;
    region?: string;
    city?: string;
    timezone?: string;
  };
};

export type OpenAiNativeStepRequest = {
  provider: OpenAiCompatibleProvider;
  model: PiModel;
  apiKey?: string;
  headers?: Record<string, string>;
  systemPrompt: string;
  piMessages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  streamOptions: OpenAiNativeStreamOptions;
  previousResponseId?: string;
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  onRawEvent?: (event: Record<string, unknown>) => void | Promise<void>;
};

export type OpenAiNativeStepResult = {
  assistant: Record<string, unknown>;
  responseId?: string;
};

export type RunOpenAiNativeResponseStep = (
  opts: OpenAiNativeStepRequest,
) => Promise<OpenAiNativeStepResult>;

const CODEX_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);

const OPENAI_ALLOWED_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex"]);

function usesCodexChatGptBackend(opts: Pick<OpenAiNativeStepRequest, "provider" | "model">): boolean {
  if (opts.provider !== "codex-cli") return false;
  return opts.model.api === "openai-codex-responses" || opts.model.provider === "openai-codex";
}

function resolveOpenAiApiKey(provider: OpenAiCompatibleProvider, explicitApiKey?: string): string {
  const direct = explicitApiKey?.trim();
  if (direct) return direct;

  if (provider === "openai") {
    const envKey = process.env.OPENAI_API_KEY?.trim();
    if (envKey) return envKey;
  }

  throw new Error(`No API key for provider: ${provider}`);
}

export function resolveCodexClientBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized.replace(/\/responses$/, "");
  }
  if (normalized.endsWith("/codex")) {
    return normalized;
  }
  return `${normalized}/codex`;
}

function resolveOpenAiClientBaseUrl(opts: OpenAiNativeStepRequest): string {
  if (!usesCodexChatGptBackend(opts)) {
    return opts.model.baseUrl;
  }
  return resolveCodexClientBaseUrl(opts.model.baseUrl);
}

function resolveOpenAiClientHeaders(opts: OpenAiNativeStepRequest): Record<string, string> {
  const defaultHeaders = {
    ...(opts.model.headers ?? {}),
    ...(opts.headers ?? {}),
  };

  if (usesCodexChatGptBackend(opts) && !defaultHeaders.originator) {
    defaultHeaders.originator = CODEX_OAUTH_ORIGINATOR;
  }

  return defaultHeaders;
}

function createOpenAiClient(opts: OpenAiNativeStepRequest): OpenAI {
  const apiKey = resolveOpenAiApiKey(opts.provider, opts.apiKey);
  const baseURL = resolveOpenAiClientBaseUrl(opts);
  const defaultHeaders = resolveOpenAiClientHeaders(opts);

  return new OpenAI({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
  });
}

function maybeBuildReasoningPayload(
  reasoningEffort: string | undefined,
  reasoningSummary: string | undefined,
  provider: OpenAiCompatibleProvider,
  modelId: string,
): Record<string, unknown> | undefined {
  if (provider === "codex-cli") {
    if (reasoningEffort === undefined) return undefined;
    return {
      effort: clampCodexReasoningEffort(modelId, reasoningEffort),
      summary: reasoningSummary ?? "auto",
    };
  }

  if (!reasoningEffort && !reasoningSummary) return undefined;
  return {
    effort: reasoningEffort ?? "medium",
    summary: reasoningSummary ?? "auto",
  };
}

export function clampCodexReasoningEffort(modelId: string, effort: string): string {
  const id = modelId.includes("/")
    ? (() => {
        const parts = modelId.split("/");
        return parts[parts.length - 1] ?? modelId;
      })()
    : modelId;
  if ((id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3")) && effort === "minimal") return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini") {
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  }
  return effort;
}

function convertPiMessagesToResponsesInput(
  model: PiModel,
  piMessages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return convertResponsesMessages(
    model,
    {
      messages: piMessages as any,
    },
    OPENAI_ALLOWED_TOOL_CALL_PROVIDERS,
    { includeSystemPrompt: false },
  );
}

function convertPiToolsToResponsesTools(
  provider: OpenAiCompatibleProvider,
  tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return convertResponsesTools(tools, {
    // OpenAI Responses strict mode requires every property to be listed in
    // `required`, so our current optional-parameter tool schemas must opt out.
    strict: false,
  });
}

function mergeUniqueStrings(...groups: Array<unknown>): string[] | undefined {
  const merged: string[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      const value = asNonEmptyString(entry);
      if (!value || merged.includes(value)) continue;
      merged.push(value);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function normalizeAllowedDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    const raw = asNonEmptyString(entry);
    if (!raw) continue;

    let domain = raw
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/^\/+/, "")
      .split(/[/?#]/, 1)[0] ?? "";
    domain = domain.trim().replace(/\/+$/g, "").toLowerCase();
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    normalized.push(domain);
  }

  return normalized;
}

function normalizeWebSearchLocation(value: unknown): Record<string, string> | undefined {
  const location = asRecord(value);
  if (!location) return undefined;

  const normalized = {
    ...(asNonEmptyString(location.country) ? { country: asNonEmptyString(location.country)! } : {}),
    ...(asNonEmptyString(location.region) ? { region: asNonEmptyString(location.region)! } : {}),
    ...(asNonEmptyString(location.city) ? { city: asNonEmptyString(location.city)! } : {}),
    ...(asNonEmptyString(location.timezone) ? { timezone: asNonEmptyString(location.timezone)! } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function resolveCodexWebSearchBackend(opts: OpenAiNativeStepRequest): "native" | "exa" {
  const configured = asNonEmptyString(opts.streamOptions.webSearchBackend)?.toLowerCase();
  return configured === "exa" ? "exa" : "native";
}

function resolveCodexNativeWebSearchMode(opts: OpenAiNativeStepRequest): "disabled" | "cached" | "live" {
  if (resolveCodexWebSearchBackend(opts) !== "native") {
    return "disabled";
  }

  const configured = asNonEmptyString(opts.streamOptions.webSearchMode)?.toLowerCase();
  if (configured === "disabled" || configured === "cached" || configured === "live") {
    return configured;
  }
  return "live";
}

function buildCodexNativeWebSearchTool(opts: OpenAiNativeStepRequest): Record<string, unknown> | null {
  if (opts.provider !== "codex-cli") return null;
  if (resolveCodexWebSearchBackend(opts) !== "native") return null;

  const mode = resolveCodexNativeWebSearchMode(opts);
  if (mode === "disabled") return null;

  const allowedDomains = normalizeAllowedDomains(opts.streamOptions.webSearchAllowedDomains);
  const location = normalizeWebSearchLocation(opts.streamOptions.webSearchLocation);
  const contextSize = asNonEmptyString(opts.streamOptions.webSearchContextSize);

  return {
    type: "web_search",
    external_web_access: mode === "live",
    ...(contextSize ? { search_context_size: contextSize } : {}),
    ...(allowedDomains.length > 0 ? { filters: { allowed_domains: allowedDomains } } : {}),
    ...(location ? { user_location: { type: "approximate", ...location } } : {}),
  };
}

export function buildOpenAiNativeRequest(opts: OpenAiNativeStepRequest): Record<string, unknown> {
  const input = convertPiMessagesToResponsesInput(opts.model, opts.piMessages);
  const useCodexChatGptBackend = usesCodexChatGptBackend(opts);
  const nativeWebSearchTool = buildCodexNativeWebSearchTool(opts);
  const stripLegacyWebSearch = opts.provider === "codex-cli" && resolveCodexWebSearchBackend(opts) === "native";
  const continuationOptions = useCodexChatGptBackend
    ? {}
    : buildOpenAiContinuationRequestOptions(opts.previousResponseId);
  const request: Record<string, unknown> = {
    model: opts.model.id,
    instructions: opts.systemPrompt,
    input,
    stream: true,
    store: useCodexChatGptBackend ? false : true,
    ...continuationOptions,
  };

  const maxOutputTokens = asFiniteNumber((opts.streamOptions as Record<string, unknown>).maxTokens);
  if (!useCodexChatGptBackend && maxOutputTokens !== undefined) {
    request.max_output_tokens = maxOutputTokens;
  }

  const temperature = asFiniteNumber(opts.streamOptions.temperature);
  if (temperature !== undefined) {
    request.temperature = temperature;
  }

  const reasoningEffort = asNonEmptyString(opts.streamOptions.reasoningEffort);
  const reasoningSummary = asNonEmptyString(opts.streamOptions.reasoningSummary);
  const reasoning = maybeBuildReasoningPayload(reasoningEffort, reasoningSummary, opts.provider, opts.model.id);
  if (reasoning) {
    request.reasoning = reasoning;
    request.include = ["reasoning.encrypted_content"];
  }

  const textVerbosity = asNonEmptyString(opts.streamOptions.textVerbosity);
  if (useCodexChatGptBackend) {
    request.text = { verbosity: "medium" };
  } else if (textVerbosity) {
    request.text = { verbosity: textVerbosity };
  } else if (opts.provider === "codex-cli") {
    request.text = { verbosity: "medium" };
  }

  const functionTools = convertPiToolsToResponsesTools(
    opts.provider,
    stripLegacyWebSearch
      ? opts.tools.filter((tool) => asNonEmptyString(tool.name) !== "webSearch")
      : opts.tools,
  );
  const requestTools = [
    ...functionTools,
    ...(nativeWebSearchTool ? [nativeWebSearchTool] : []),
  ];
  if (requestTools.length > 0) {
    request.tools = requestTools;
  }

  if (opts.provider === "codex-cli") {
    request.parallel_tool_calls = true;
    request.tool_choice = "auto";
    const include = mergeUniqueStrings(request.include, nativeWebSearchTool ? ["web_search_call.action.sources"] : []);
    if (include) {
      request.include = include;
    }
  } else if (!reasoning && opts.model.reasoning && opts.model.name.startsWith("gpt-5")) {
    input.push({
      role: "developer",
      content: [{ type: "input_text", text: "# Juice: 0 !important" }],
    });
  }

  return request;
}

function normalizeCodexStatus(status: unknown): string | undefined {
  if (typeof status !== "string") return undefined;
  return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}

export async function* normalizeCodexEvents(events: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const event of events) {
    const record = asRecord(event);
    const type = typeof record?.type === "string" ? record.type : undefined;
    if (!type) continue;

    if (type === "error") {
      const code = asNonEmptyString(record?.code) ?? "";
      const message = asNonEmptyString(record?.message) ?? "";
      throw new Error(`Codex error: ${message || code || JSON.stringify(event)}`);
    }

    if (type === "response.failed") {
      const response = asRecord(record?.response);
      const error = asRecord(response?.error);
      const message = asNonEmptyString(error?.message);
      throw new Error(message ?? "Codex response failed");
    }

    if (type === "response.done" || type === "response.completed") {
      const response = asRecord(record?.response);
      yield {
        ...record,
        type: "response.completed",
        response: response
          ? {
              ...response,
              status: normalizeCodexStatus(response.status),
            }
          : response,
      };
      continue;
    }

    yield record;
  }
}

async function emitOpenAiNativeEvent(
  opts: OpenAiNativeStepRequest,
  event: Record<string, unknown>,
): Promise<void> {
  await opts.onEvent?.(event);
}

async function emitOpenAiNativeRawEvent(
  opts: OpenAiNativeStepRequest,
  event: Record<string, unknown>,
): Promise<void> {
  await opts.onRawEvent?.(event);
}

async function* tapOpenAiResponseIds(
  events: AsyncIterable<unknown>,
  onResponseId: (responseId: string) => void,
): AsyncIterable<unknown> {
  for await (const rawEvent of events) {
    const event = asRecord(rawEvent);
    const response = asRecord(event?.response);
    const responseId = asNonEmptyString(response?.id);
    if (responseId) onResponseId(responseId);
    yield rawEvent;
  }
}

async function* tapOpenAiRawEvents(
  opts: OpenAiNativeStepRequest,
  events: AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  for await (const rawEvent of events) {
    const event = asRecord(rawEvent);
    if (event) {
      await emitOpenAiNativeRawEvent(opts, event as Record<string, unknown>);
    }
    yield rawEvent;
  }
}

export const runOpenAiNativeResponseStep: RunOpenAiNativeResponseStep = async (
  opts: OpenAiNativeStepRequest,
): Promise<OpenAiNativeStepResult> => {
  const client = createOpenAiClient(opts);
  const request = buildOpenAiNativeRequest(opts);
  const rawStream = await client.responses.create(
    request as any,
    opts.streamOptions.signal ? { signal: opts.streamOptions.signal } : undefined,
  );
  const normalizedEvents = opts.provider === "codex-cli"
    ? normalizeCodexEvents(rawStream as unknown as AsyncIterable<unknown>)
    : (rawStream as unknown as AsyncIterable<unknown>);

  let responseId: string | undefined;
  let pendingEventDelivery = Promise.resolve();
  const assistant: Record<string, unknown> = {
    role: "assistant",
    api: opts.model.api,
    provider: opts.model.provider,
    model: opts.model.id,
    content: [],
    timestamp: Date.now(),
  };

  await emitOpenAiNativeEvent(opts, { type: "start" });

  try {
    await processResponsesStream(
      tapOpenAiResponseIds(tapOpenAiRawEvents(opts, normalizedEvents), (nextResponseId) => {
        responseId = nextResponseId;
      }) as AsyncIterable<any>,
      assistant as Record<string, any>,
      {
        push: (event) => {
          pendingEventDelivery = pendingEventDelivery.then(() => emitOpenAiNativeEvent(opts, event));
        },
      },
      opts.model,
    );

    await pendingEventDelivery;

    if (opts.streamOptions.signal?.aborted) {
      throw new Error("Request was aborted");
    }

    await emitOpenAiNativeEvent(opts, {
      type: "done",
      reason: assistant.stopReason,
      message: assistant,
    });
    return { assistant, responseId };
  } catch (error) {
    await pendingEventDelivery;
    await emitOpenAiNativeEvent(opts, {
      type: "error",
      error: {
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
};

export const __internal = {
  buildOpenAiNativeRequest,
  buildCodexNativeWebSearchTool,
  convertPiMessagesToResponsesInput,
  convertPiToolsToResponsesTools,
  mergeUniqueStrings,
  normalizeAllowedDomains,
  normalizeWebSearchLocation,
  resolveCodexWebSearchBackend,
  resolveCodexNativeWebSearchMode,
  resolveCodexClientBaseUrl,
  resolveOpenAiClientBaseUrl,
  resolveOpenAiClientHeaders,
  normalizeCodexEvents,
  clampCodexReasoningEffort,
} as const;
