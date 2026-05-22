import OpenAI from "openai";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "./openaiResponsesShared";
import {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  buildOpenAiContinuationRequestOptions,
  type PiModel,
} from "./piRuntimeOptions";

type OpenAiCompatibleProvider = "openai";

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

const OPENAI_ALLOWED_TOOL_CALL_PROVIDERS = new Set(["openai"]);

function resolveOpenAiApiKey(provider: OpenAiCompatibleProvider, explicitApiKey?: string): string {
  const direct = explicitApiKey?.trim();
  if (direct) return direct;

  if (provider === "openai") {
    const envKey = process.env.OPENAI_API_KEY?.trim();
    if (envKey) return envKey;
  }

  throw new Error(`No API key for provider: ${provider}`);
}

function createOpenAiClient(opts: OpenAiNativeStepRequest): OpenAI {
  const apiKey = resolveOpenAiApiKey(opts.provider, opts.apiKey);

  return new OpenAI({
    apiKey,
    baseURL: opts.model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      ...(opts.model.headers ?? {}),
      ...(opts.headers ?? {}),
    },
  });
}

function maybeBuildReasoningPayload(
  reasoningEffort: string | undefined,
  reasoningSummary: string | undefined,
  provider: OpenAiCompatibleProvider,
  modelId: string,
): Record<string, unknown> | undefined {
  void provider;
  void modelId;

  if (!reasoningEffort && !reasoningSummary) return undefined;
  return {
    effort: reasoningEffort ?? "medium",
    summary: reasoningSummary ?? "auto",
  };
}

function normalizeOpenAiReasoningEffort(value: unknown): string | undefined {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized || normalized === "none") return undefined;
  if (normalized === "xhigh") return "high";
  return ["minimal", "low", "medium", "high"].includes(normalized) ? normalized : undefined;
}

function openAiNativeErrorPayload(error: unknown): Record<string, unknown> {
  const record = asRecord(error);
  const code = asNonEmptyString(record?.code);
  const status = asNonEmptyString(record?.status);
  const failureType = asNonEmptyString(record?.failureType) ?? asNonEmptyString(record?.type);
  const param = asNonEmptyString(record?.param);
  return {
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    ...(failureType ? { type: failureType } : {}),
    ...(param ? { param } : {}),
    ...(record && "response" in record ? { response: record.response } : {}),
  };
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
  _provider: OpenAiCompatibleProvider,
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

    let domain =
      raw
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

  const country = asNonEmptyString(location.country);
  const region = asNonEmptyString(location.region);
  const city = asNonEmptyString(location.city);
  const timezone = asNonEmptyString(location.timezone);
  const normalized = {
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
    ...(timezone ? { timezone } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function buildOpenAiNativeRequest(opts: OpenAiNativeStepRequest): Record<string, unknown> {
  const input = convertPiMessagesToResponsesInput(opts.model, opts.piMessages);
  const continuationOptions = buildOpenAiContinuationRequestOptions(opts.previousResponseId);
  const request: Record<string, unknown> = {
    model: opts.model.id,
    instructions: opts.systemPrompt,
    input,
    stream: true,
    store: true,
    ...continuationOptions,
  };

  const maxOutputTokens = asFiniteNumber((opts.streamOptions as Record<string, unknown>).maxTokens);
  if (maxOutputTokens !== undefined) {
    request.max_output_tokens = maxOutputTokens;
  }

  const temperature = asFiniteNumber(opts.streamOptions.temperature);
  if (temperature !== undefined) {
    request.temperature = temperature;
  }

  const reasoningEffort = normalizeOpenAiReasoningEffort(opts.streamOptions.reasoningEffort);
  const reasoningSummary = asNonEmptyString(opts.streamOptions.reasoningSummary);
  const reasoning = maybeBuildReasoningPayload(
    reasoningEffort,
    reasoningSummary,
    opts.provider,
    opts.model.id,
  );
  if (reasoning) {
    request.reasoning = reasoning;
    request.include = ["reasoning.encrypted_content"];
  }

  const textVerbosity = asNonEmptyString(opts.streamOptions.textVerbosity);
  if (textVerbosity) {
    request.text = { verbosity: textVerbosity };
  }

  const requestTools = convertPiToolsToResponsesTools(opts.provider, opts.tools);
  if (requestTools.length > 0) {
    request.tools = requestTools;
  }

  if (!reasoning && opts.model.reasoning && opts.model.name.startsWith("gpt-5")) {
    input.push({
      role: "developer",
      content: [{ type: "input_text", text: "# Juice: 0 !important" }],
    });
  }

  return request;
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
      tapOpenAiResponseIds(
        tapOpenAiRawEvents(opts, rawStream as unknown as AsyncIterable<unknown>),
        (nextResponseId) => {
          responseId = nextResponseId;
        },
      ) as AsyncIterable<any>,
      assistant as Record<string, any>,
      {
        push: (event) => {
          pendingEventDelivery = pendingEventDelivery.then(() =>
            emitOpenAiNativeEvent(opts, event),
          );
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
      error: openAiNativeErrorPayload(error),
    });
    throw error;
  }
};

export const __internal = {
  buildOpenAiNativeRequest,
  convertPiMessagesToResponsesInput,
  convertPiToolsToResponsesTools,
  mergeUniqueStrings,
  normalizeOpenAiReasoningEffort,
  normalizeAllowedDomains,
  normalizeWebSearchLocation,
} as const;
