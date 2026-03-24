import { GoogleGenAI, type Interactions } from "@google/genai";

import type { GoogleInteractionsModelInfo } from "./googleInteractionsModel";
import { piTurnMessagesToModelMessages, toolResultContentFromOutput } from "./piMessageBridge";
import { enrichCitationAnnotations } from "../server/citationMetadata";
import type { ModelMessage } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoogleInteractionsStreamOptions = {
  signal?: AbortSignal;
  temperature?: number;
  thinkingLevel?: string;
  thinkingBudget?: number;
  thinkingSummaries?: "auto" | "none";
  maxOutputTokens?: number;
  toolChoice?: string;
  nativeWebSearch?: boolean;
};

export type GoogleNativeStepRequest = {
  model: GoogleInteractionsModelInfo;
  apiKey?: string;
  systemPrompt: string;
  messages: ModelMessage[];
  tools: Array<Record<string, unknown>>;
  streamOptions: GoogleInteractionsStreamOptions;
  previousInteractionId?: string;
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  onRawEvent?: (event: Record<string, unknown>) => void | Promise<void>;
};

export type GoogleNativeStepResult = {
  assistant: Record<string, unknown>;
  interactionId?: string;
};

export type RunGoogleNativeInteractionStep = (
  opts: GoogleNativeStepRequest,
) => Promise<GoogleNativeStepResult>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveGoogleApiKey(explicitKey?: string): string {
  const direct = explicitKey?.trim();
  if (direct) return direct;

  const envKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim();
  if (envKey) return envKey;

  throw new Error("No API key for Google provider. Set GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY.");
}

function createGoogleClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

// ---------------------------------------------------------------------------
// Message conversion: ModelMessage[] → Interactions API input
// ---------------------------------------------------------------------------

type InteractionsInput = Array<Record<string, unknown>>;

type InteractionTurn = {
  role: "user" | "model";
  content: string | Array<Record<string, unknown>>;
};

type GoogleSignatureProviderKey = "google" | "vertex";

function convertToolCallId(id: string): string {
  // Strip PI-style composite IDs (call_id|item_id) → just call_id
  return id.includes("|") ? id.split("|")[0]! : id;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getGoogleThoughtSignature(record: Record<string, unknown>): string | undefined {
  const directSignature = asNonEmptyString(record.thoughtSignature) ?? asNonEmptyString(record.thinkingSignature);
  if (directSignature) return directSignature;

  const providerOptions = asRecord(record.providerOptions);
  if (!providerOptions) return undefined;

  for (const key of ["google", "vertex"] as const) {
    const providerValue = asRecord(providerOptions[key]);
    const signature =
      asNonEmptyString(providerValue?.thoughtSignature) ??
      asNonEmptyString(providerValue?.thought_signature) ??
      asNonEmptyString(providerValue?.thinkingSignature) ??
      asNonEmptyString(providerValue?.thinking_signature);
    if (signature) return signature;
  }

  return undefined;
}

function getGoogleSignatureProviderKey(record: Record<string, unknown>): GoogleSignatureProviderKey {
  const providerOptions = asRecord(record.providerOptions);
  return providerOptions && asRecord(providerOptions.vertex) ? "vertex" : "google";
}

function mergeGoogleThoughtProviderOptions(
  record: Record<string, unknown>,
  signature: string | undefined,
): Record<string, unknown> | undefined {
  const providerOptions = asRecord(record.providerOptions);
  if (!signature) return providerOptions ?? undefined;

  const providerKey = getGoogleSignatureProviderKey(record);
  const providerValue = asRecord(providerOptions?.[providerKey]);
  return {
    ...(providerOptions ?? {}),
    [providerKey]: {
      ...(providerValue ?? {}),
      thoughtSignature: signature,
    },
  };
}

function buildTextContent(text: unknown): Record<string, unknown> | null {
  const value = asNonEmptyString(text);
  return value ? { type: "text", text: value } : null;
}

function buildImageContent(record: Record<string, unknown>): Record<string, unknown> | null {
  const data = asNonEmptyString(record.data);
  const mimeType = asNonEmptyString(record.mimeType) ?? asNonEmptyString(record.mime_type);
  if (!data || !mimeType) return null;
  return {
    type: "image",
    data,
    mime_type: mimeType,
  };
}

function convertRichContentParts(parts: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(parts)) return [];

  const content: Array<Record<string, unknown>> = [];
  for (const rawPart of parts) {
    if (typeof rawPart === "string") {
      const textPart = buildTextContent(rawPart);
      if (textPart) content.push(textPart);
      continue;
    }

    const record = asRecord(rawPart);
    if (!record) continue;

    const partType = asNonEmptyString(record.type);
    if (partType === "text" || partType === "input_text") {
      const textPart = buildTextContent(record.text ?? record.inputText ?? record.value);
      if (textPart) content.push(textPart);
      continue;
    }

    if (partType === "image" || partType === "input_image") {
      const imagePart = buildImageContent(record);
      if (imagePart) content.push(imagePart);
    }
  }

  return content;
}

function turnFromUserMessage(message: ModelMessage): InteractionTurn | null {
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text ? { role: "user", content: text } : null;
  }

  const parts = convertRichContentParts(message.content);
  return parts.length > 0 ? { role: "user", content: parts } : null;
}

function turnFromAssistantMessage(message: ModelMessage): InteractionTurn | null {
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text ? { role: "model", content: text } : null;
  }
  if (!Array.isArray(message.content)) return null;

  const parts: Array<Record<string, unknown>> = [];
  for (const rawPart of message.content) {
    if (typeof rawPart === "string") {
      const textPart = buildTextContent(rawPart);
      if (textPart) parts.push(textPart);
      continue;
    }

    const record = asRecord(rawPart);
    if (!record) continue;
    const partType = asNonEmptyString(record.type);

    if (partType === "text" || partType === "input_text" || partType === "output_text") {
      const textPart = buildTextContent(record.text ?? record.inputText ?? record.outputText ?? record.value);
      if (textPart) parts.push(textPart);
      continue;
    }

    if (partType === "reasoning" || partType === "thinking") {
      const signature = getGoogleThoughtSignature(record);
      if (!signature) continue;
      const summaryPart = buildTextContent(record.text ?? record.thinking);
      parts.push({
        type: "thought",
        signature,
        ...(summaryPart ? { summary: [summaryPart] } : {}),
      });
      continue;
    }

    if (partType === "tool-call" || partType === "toolCall") {
      const toolCallId = asNonEmptyString(record.toolCallId) ?? asNonEmptyString(record.id);
      const toolName = asNonEmptyString(record.toolName) ?? asNonEmptyString(record.name);
      if (!toolCallId || !toolName) continue;
      const args = asRecord(record.input) ?? asRecord(record.arguments) ?? {};
      const signature = getGoogleThoughtSignature(record);
      parts.push({
        type: "function_call",
        id: convertToolCallId(toolCallId),
        name: toolName,
        arguments: args,
        ...(signature ? { signature } : {}),
      });
      continue;
    }

    if (partType === "providerToolCall") {
      const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
      const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
      if (!toolCallId || !toolName) continue;
      const nativeToolName = nativeToolNameFromContentType(toolName) ?? (toolName as NativeGoogleToolName);
      const nativeToolCallType =
        nativeToolName === "nativeWebSearch"
          ? "google_search_call"
          : nativeToolName === "nativeUrlContext"
            ? "url_context_call"
            : null;
      if (!nativeToolCallType) continue;
      const args = asRecord(record.arguments) ?? asRecord(record.input) ?? {};
      const signature = getGoogleThoughtSignature(record);
      parts.push({
        type: nativeToolCallType,
        id: convertToolCallId(toolCallId),
        arguments: args,
        ...(signature ? { signature } : {}),
      });
      continue;
    }

    if (partType === "providerToolResult") {
      const toolCallId = asNonEmptyString(record.callId) ?? asNonEmptyString(record.toolCallId) ?? asNonEmptyString(record.id);
      const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
      if (!toolCallId || !toolName) continue;
      const nativeToolName = nativeToolNameFromContentType(toolName) ?? (toolName as NativeGoogleToolName);
      const nativeToolResultType =
        nativeToolName === "nativeWebSearch"
          ? "google_search_result"
          : nativeToolName === "nativeUrlContext"
            ? "url_context_result"
            : null;
      if (!nativeToolResultType) continue;
      const signature = getGoogleThoughtSignature(record);
      parts.push({
        type: nativeToolResultType,
        call_id: convertToolCallId(toolCallId),
        result: record.result,
        ...(record.isError === true ? { is_error: true } : {}),
        ...(signature ? { signature } : {}),
      });
    }
  }

  return parts.length > 0 ? { role: "model", content: parts } : null;
}

function turnFromToolMessage(message: ModelMessage): InteractionTurn | null {
  if (!Array.isArray(message.content)) return null;

  const parts: Array<Record<string, unknown>> = [];
  for (const rawPart of message.content) {
    const record = asRecord(rawPart);
    if (!record) continue;
    if (record.type !== "tool-result" && record.type !== "toolResult") continue;

    const toolCallId = asNonEmptyString(record.toolCallId) ?? asNonEmptyString(record.id);
    if (!toolCallId) continue;

    const toolName = asNonEmptyString(record.toolName);
    const richResult = toolResultContentFromOutput(record.output ?? record.content);
    const resultParts = richResult.flatMap<Record<string, unknown>>((part) => {
      if (part.type === "text") {
        const textPart = buildTextContent(part.text);
        return textPart ? [textPart] : [];
      }
      const imagePart = buildImageContent(part);
      return imagePart ? [imagePart] : [];
    });

    const result =
      resultParts.length === 1 && resultParts[0]?.type === "text"
        ? resultParts[0].text
        : resultParts.length > 0
          ? resultParts
          : safeJsonStringify(record.output ?? record.content);
    const signature = getGoogleThoughtSignature(record);

    parts.push({
      type: "function_result",
      call_id: convertToolCallId(toolCallId),
      result,
      is_error: record.isError === true,
      ...(toolName ? { name: toolName } : {}),
      ...(signature ? { signature } : {}),
    });
  }

  return parts.length > 0 ? { role: "user", content: parts } : null;
}

function convertMessagesToInteractionsInput(
  messages: ModelMessage[],
): InteractionsInput {
  const input: InteractionsInput = [];

  for (const msg of messages) {
    const role = msg.role;
    const turn =
      role === "user"
        ? turnFromUserMessage(msg)
        : role === "assistant"
          ? turnFromAssistantMessage(msg)
          : role === "tool"
            ? turnFromToolMessage(msg)
            : null;
    if (turn) input.push(turn);
  }

  return input;
}

function googleAssistantContentBlockToModelPart(rawPart: unknown): Record<string, unknown> | null {
  if (typeof rawPart === "string") {
    const text = rawPart.trim();
    return text ? { type: "text", text } : null;
  }

  const record = asRecord(rawPart);
  if (!record) return null;

  const partType = asNonEmptyString(record.type);
  if (partType === "text" || partType === "input_text" || partType === "output_text") {
    const text = asNonEmptyString(record.text) ?? asNonEmptyString(record.inputText) ?? asNonEmptyString(record.outputText) ?? asNonEmptyString(record.value);
    if (!text) return null;

    const annotations = asRecordArray(record.annotations);
    return {
      type: "text",
      text,
      ...(annotations.length > 0 ? { annotations } : {}),
    };
  }

  if (partType === "thinking" || partType === "reasoning") {
    const thinking = asNonEmptyString(record.thinking) ?? asNonEmptyString(record.text);
    if (!thinking) return null;

    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "thinking",
      thinking,
      ...(signature ? { thinkingSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  if (partType === "toolCall" || partType === "tool-call") {
    const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
    if (!toolCallId || !toolName) return null;

    const input = asRecord(record.arguments) ?? asRecord(record.input) ?? {};
    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "tool-call",
      toolCallId,
      toolName,
      input,
      ...(signature ? { thoughtSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  if (partType === "providerToolCall") {
    const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
    if (!toolCallId || !toolName) return null;

    const input = asRecord(record.arguments) ?? asRecord(record.input) ?? {};
    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "providerToolCall",
      id: toolCallId,
      name: toolName,
      arguments: input,
      ...(signature ? { thoughtSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  if (partType === "providerToolResult") {
    const toolCallId = asNonEmptyString(record.callId) ?? asNonEmptyString(record.toolCallId) ?? asNonEmptyString(record.id);
    const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
    if (!toolCallId || !toolName) return null;

    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "providerToolResult",
      callId: toolCallId,
      name: toolName,
      result: record.result,
      ...(record.is_error === true || record.isError === true ? { isError: true } : {}),
      ...(signature ? { thoughtSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  return null;
}

function googleAssistantMessageToModelMessage(message: unknown): ModelMessage | null {
  const record = asRecord(message);
  if (!record || record.role !== "assistant") return null;

  if (typeof record.content === "string") {
    const text = record.content.trim();
    return text ? { role: "assistant", content: text } : null;
  }

  if (!Array.isArray(record.content)) return null;
  const content = record.content.flatMap<Record<string, unknown>>((part) => {
    const converted = googleAssistantContentBlockToModelPart(part);
    return converted ? [converted] : [];
  });
  return content.length > 0 ? { role: "assistant", content } : null;
}

export function googleTurnMessagesToModelMessages(messages: unknown[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const assistantMessage = googleAssistantMessageToModelMessage(message);
    if (assistantMessage) {
      out.push(assistantMessage);
      continue;
    }
    out.push(...piTurnMessagesToModelMessages([message as any]));
  }
  return out;
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part.trim()) parts.push(part);
      continue;
    }
    const record = part as Record<string, unknown>;
    const text = (record?.text ?? record?.inputText) as string | undefined;
    if (text?.trim()) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

type NativeGoogleToolName = "nativeWebSearch" | "nativeUrlContext";

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function mergeAnnotationArrays(
  current: Array<Record<string, unknown>> | undefined,
  incoming: unknown,
): Array<Record<string, unknown>> | undefined {
  const next = asRecordArray(incoming);
  if (next.length === 0) return current;
  if (!current || current.length === 0) return next;

  const seen = new Set(current.map((entry) => safeJsonStringify(entry)));
  const merged = [...current];
  for (const entry of next) {
    const signature = safeJsonStringify(entry);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(entry);
  }
  return merged;
}

function nativeToolNameFromContentType(contentType: string): NativeGoogleToolName | null {
  if (contentType === "google_search_call" || contentType === "google_search_result") {
    return "nativeWebSearch";
  }
  if (contentType === "url_context_call" || contentType === "url_context_result") {
    return "nativeUrlContext";
  }
  return null;
}

function isNativeGoogleToolCallContentType(contentType: string): boolean {
  return contentType === "google_search_call" || contentType === "url_context_call";
}

function isNativeGoogleToolResultContentType(contentType: string): boolean {
  return contentType === "google_search_result" || contentType === "url_context_result";
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asNonEmptyString(entry))
    .filter((entry): entry is string => !!entry);
}

function extractSourceArray(value: unknown): Array<Record<string, unknown>> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const directSources = asRecordArray(record.sources);
  if (directSources.length > 0) return directSources;

  const action = asRecord(record.action);
  const actionSources = asRecordArray(action?.sources);
  return actionSources.length > 0 ? actionSources : undefined;
}

function extractResultEntries(value: unknown): Array<Record<string, unknown>> {
  const directResults = asRecordArray(value);
  if (directResults.length > 0) return directResults;

  const record = asRecord(value);
  if (!record) return [];
  return asRecordArray(record.results);
}

function extractSingletonOrNestedResultEntries(value: unknown): Array<Record<string, unknown>> {
  const directResults = asRecordArray(value);
  if (directResults.length > 0) return directResults;

  const record = asRecord(value);
  if (!record) return [];

  const nestedResults = asRecordArray(record.results);
  if (nestedResults.length > 0) return nestedResults;

  return [record];
}

function buildNativeGoogleToolResultOutput(
  name: NativeGoogleToolName,
  callId: string,
  callArguments: Record<string, unknown>,
  result: unknown,
): Record<string, unknown> {
  if (name === "nativeWebSearch") {
    const sources = extractSourceArray(result);
    return {
      provider: "google",
      status: "completed",
      callId,
      queries: extractStringArray(callArguments.queries),
      results: extractResultEntries(result),
      ...(sources ? { sources } : {}),
      raw: result,
    };
  }

  if (name === "nativeUrlContext") {
    return {
      provider: "google",
      status: "completed",
      callId,
      urls: extractStringArray(callArguments.urls),
      results: extractSingletonOrNestedResultEntries(result),
      raw: result,
    };
  }

  throw new Error(`Unknown native Google tool: ${name}`);
}

async function enrichTextBlockAnnotations(
  block: AssistantContentBlock | undefined,
): Promise<void> {
  if (block?.type !== "text" || !block.annotations || block.annotations.length === 0) {
    return;
  }

  const nextAnnotations = await enrichCitationAnnotations(block.annotations);
  if (nextAnnotations) {
    block.annotations = nextAnnotations;
  }
}

function queueTextBlockAnnotationEnrichment(
  pendingAnnotationEnrichments: Array<Promise<void>>,
  block: AssistantContentBlock | undefined,
): void {
  const pending = enrichTextBlockAnnotations(block);
  void pending.catch(() => undefined);
  pendingAnnotationEnrichments.push(pending);
}

function ensureThinkingBlock(
  contentBlocks: Map<number, AssistantContentBlock>,
  index: number,
): Extract<AssistantContentBlock, { type: "thinking" }> | null {
  const existing = contentBlocks.get(index);
  if (existing?.type === "thinking") return existing;
  if (existing) return null;

  const block: Extract<AssistantContentBlock, { type: "thinking" }> = {
    type: "thinking",
    thinking: "",
  };
  contentBlocks.set(index, block);
  return block;
}

// ---------------------------------------------------------------------------
// Tool conversion: runtime tools → Interactions API tools
// ---------------------------------------------------------------------------

function convertToolsToInteractionsTools(
  tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function hasToolNamed(tools: Array<Record<string, unknown>>, name: string): boolean {
  return tools.some((tool) => asNonEmptyString(tool.name) === name);
}

function canUseProviderNativeWebTools(tools: Array<Record<string, unknown>>): boolean {
  return hasToolNamed(tools, "webSearch") || hasToolNamed(tools, "webFetch");
}

function buildGoogleBuiltInTools(opts: GoogleNativeStepRequest): Array<Record<string, unknown>> {
  const allowProviderNativeWebTools = canUseProviderNativeWebTools(opts.tools);
  const nativeWebSearchEnabled =
    opts.streamOptions.nativeWebSearch === true && allowProviderNativeWebTools;

  if (nativeWebSearchEnabled) {
    return [
      { type: "google_search", search_types: ["web_search"] },
      { type: "url_context" },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Build request
// ---------------------------------------------------------------------------

export function buildGoogleNativeRequest(
  opts: GoogleNativeStepRequest,
): Record<string, unknown> {
  const input = convertMessagesToInteractionsInput(opts.messages);
  const tools = [
    ...convertToolsToInteractionsTools(opts.tools),
    ...buildGoogleBuiltInTools(opts),
  ];

  const generationConfig: Record<string, unknown> = {};

  const thinkingLevel = opts.streamOptions.thinkingLevel?.toLowerCase();
  if (thinkingLevel && thinkingLevel !== "none") {
    generationConfig.thinking_level = thinkingLevel;
  }
  if (opts.streamOptions.thinkingSummaries) {
    generationConfig.thinking_summaries = opts.streamOptions.thinkingSummaries;
  }
  if (opts.streamOptions.thinkingBudget !== undefined) {
    // Interactions API doesn't have thinkingBudget directly in generation_config,
    // but we pass it through in case the API evolves to support it
  }
  if (opts.streamOptions.temperature !== undefined) {
    generationConfig.temperature = opts.streamOptions.temperature;
  }
  if (opts.streamOptions.maxOutputTokens !== undefined) {
    generationConfig.max_output_tokens = opts.streamOptions.maxOutputTokens;
  }
  if (opts.streamOptions.toolChoice) {
    generationConfig.tool_choice = opts.streamOptions.toolChoice;
  }

  const request: Record<string, unknown> = {
    model: opts.model.id,
    input,
    stream: true,
    store: true,
    system_instruction: opts.systemPrompt,
  };

  if (Object.keys(generationConfig).length > 0) {
    request.generation_config = generationConfig;
  }

  if (tools.length > 0) {
    request.tools = tools;
  }

  if (opts.previousInteractionId) {
    request.previous_interaction_id = opts.previousInteractionId;
  }

  return request;
}

// ---------------------------------------------------------------------------
// Stream processing
// ---------------------------------------------------------------------------

type AssistantContentBlock =
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "text"; text: string; annotations?: Array<Record<string, unknown>> }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }
  | { type: "providerToolCall"; id: string; name: NativeGoogleToolName; arguments: Record<string, unknown>; thoughtSignature?: string }
  | { type: "providerToolResult"; callId: string; name: NativeGoogleToolName; result: unknown; isError?: boolean; thoughtSignature?: string };

type ProviderToolCallState = {
  emittedId: string;
  name: NativeGoogleToolName;
  arguments: Record<string, unknown>;
};

function streamIdForIndex(index: number): string {
  return `s${index}`;
}

function queueEventDelivery(
  pendingEventDelivery: Promise<void>,
  emitEvent: (event: Record<string, unknown>) => Promise<void>,
  event: Record<string, unknown>,
): Promise<void> {
  return pendingEventDelivery.then(() => emitEvent(event));
}

function rememberProviderToolCall(
  providerToolCallsById: Map<string, ProviderToolCallState>,
  ids: readonly string[],
  emittedId: string,
  name: NativeGoogleToolName,
  argumentsRecord: Record<string, unknown>,
): void {
  const state: ProviderToolCallState = {
    emittedId,
    name,
    arguments: { ...argumentsRecord },
  };
  for (const id of new Set(ids)) {
    providerToolCallsById.set(id, state);
  }
}

function processStreamEvent(
  event: Record<string, unknown>,
  contentBlocks: Map<number, AssistantContentBlock>,
  providerToolCallsById: Map<string, ProviderToolCallState>,
): void {
  const eventType = event.event_type as string;

  if (eventType === "content.start") {
    const index = event.index as number;
    const content = asRecord(event.content);
    if (!content) return;

    const contentType = asNonEmptyString(content.type);
    if (!contentType) return;
    if (contentType === "text") {
      contentBlocks.set(index, {
        type: "text",
        text: asNonEmptyString(content.text) ?? "",
        ...(mergeAnnotationArrays(undefined, content.annotations) ? { annotations: mergeAnnotationArrays(undefined, content.annotations) } : {}),
      });
    } else if (contentType === "function_call") {
      contentBlocks.set(index, {
        type: "toolCall",
        id: asNonEmptyString(content.id) ?? `tool_${Date.now()}_${index}`,
        name: asNonEmptyString(content.name) ?? "tool",
        arguments: asRecord(content.arguments) ?? {},
        ...(asNonEmptyString(content.signature) ? { thoughtSignature: asNonEmptyString(content.signature) } : {}),
      });
    } else if (contentType === "thought") {
      const block = ensureThinkingBlock(contentBlocks, index);
      if (!block) return;
      const signature = asNonEmptyString(content.signature);
      if (signature) {
        block.thinkingSignature = signature;
      }
    } else if (isNativeGoogleToolCallContentType(contentType)) {
      const name = nativeToolNameFromContentType(contentType);
      if (!name) return;
      const id = asNonEmptyString(content.id) ?? `provider_tool_${Date.now()}_${index}`;
      const argumentsRecord = asRecord(content.arguments) ?? {};
      contentBlocks.set(index, {
        type: "providerToolCall",
        id,
        name,
        arguments: argumentsRecord,
        ...(asNonEmptyString(content.signature) ? { thoughtSignature: asNonEmptyString(content.signature) } : {}),
      });
      rememberProviderToolCall(providerToolCallsById, [id], id, name, argumentsRecord);
    } else if (isNativeGoogleToolResultContentType(contentType)) {
      const callId = asNonEmptyString(content.call_id);
      const providerToolCall = providerToolCallsById.get(callId ?? "");
      const name = providerToolCall?.name ?? nativeToolNameFromContentType(contentType);
      const emittedCallId = providerToolCall?.emittedId ?? callId;
      if (!name || !callId || !emittedCallId) return;
      contentBlocks.set(index, {
        type: "providerToolResult",
        callId: emittedCallId,
        name,
        result: content.result,
        isError: content.is_error === true,
        ...(asNonEmptyString(content.signature) ? { thoughtSignature: asNonEmptyString(content.signature) } : {}),
      });
    }
    return;
  }

  if (eventType === "content.delta") {
    const index = event.index as number;
    const delta = asRecord(event.delta);
    if (!delta) return;

    const deltaType = asNonEmptyString(delta.type);
    if (!deltaType) return;
    const existing = contentBlocks.get(index);

    if (deltaType === "text" && existing?.type === "text") {
      existing.text += String(delta.text ?? "");
      existing.annotations = mergeAnnotationArrays(existing.annotations, delta.annotations);
    } else if (deltaType === "text" && !existing) {
      contentBlocks.set(index, {
        type: "text",
        text: String(delta.text ?? ""),
        ...(mergeAnnotationArrays(undefined, delta.annotations) ? { annotations: mergeAnnotationArrays(undefined, delta.annotations) } : {}),
      });
    } else if (deltaType === "function_call") {
      if (existing?.type === "toolCall") {
        const deltaName = asNonEmptyString(delta.name);
        if (deltaName) {
          existing.name = deltaName;
        }
        const deltaSignature = asNonEmptyString(delta.signature);
        if (deltaSignature) {
          existing.thoughtSignature = deltaSignature;
        }
        // Merge arguments incrementally
        const deltaArgs = asRecord(delta.arguments);
        if (deltaArgs) {
          Object.assign(existing.arguments, deltaArgs);
        }
      } else {
        contentBlocks.set(index, {
          type: "toolCall",
          id: asNonEmptyString(delta.id) ?? `tool_${Date.now()}_${index}`,
          name: asNonEmptyString(delta.name) ?? "tool",
          arguments: asRecord(delta.arguments) ?? {},
          ...(asNonEmptyString(delta.signature) ? { thoughtSignature: asNonEmptyString(delta.signature) } : {}),
        });
      }
    } else if (isNativeGoogleToolCallContentType(deltaType)) {
      const name = nativeToolNameFromContentType(deltaType);
      if (!name) return;
      if (existing?.type === "providerToolCall") {
        const deltaId = asNonEmptyString(delta.id);
        const deltaSignature = asNonEmptyString(delta.signature);
        if (deltaSignature) {
          existing.thoughtSignature = deltaSignature;
        }
        const deltaArgs = asRecord(delta.arguments);
        if (deltaArgs) {
          Object.assign(existing.arguments, deltaArgs);
        }
        rememberProviderToolCall(
          providerToolCallsById,
          deltaId && deltaId !== existing.id ? [existing.id, deltaId] : [existing.id],
          existing.id,
          existing.name,
          existing.arguments,
        );
      } else {
        const id = asNonEmptyString(delta.id) ?? `provider_tool_${Date.now()}_${index}`;
        const argumentsRecord = asRecord(delta.arguments) ?? {};
        contentBlocks.set(index, {
          type: "providerToolCall",
          id,
          name,
          arguments: argumentsRecord,
          ...(asNonEmptyString(delta.signature) ? { thoughtSignature: asNonEmptyString(delta.signature) } : {}),
        });
        rememberProviderToolCall(providerToolCallsById, [id], id, name, argumentsRecord);
      }
    } else if (isNativeGoogleToolResultContentType(deltaType)) {
      const callId = asNonEmptyString(delta.call_id);
      const providerToolCall = callId ? providerToolCallsById.get(callId) : undefined;
      const name = providerToolCall?.name ?? nativeToolNameFromContentType(deltaType);
      const emittedCallId = providerToolCall?.emittedId ?? callId;
      if (!name || !callId || !emittedCallId) return;
      if (existing?.type === "providerToolResult") {
        existing.callId = emittedCallId;
        if (delta.result !== undefined) {
          existing.result = delta.result;
        }
        existing.isError = delta.is_error === true;
        const deltaSignature = asNonEmptyString(delta.signature);
        if (deltaSignature) {
          existing.thoughtSignature = deltaSignature;
        }
      } else {
        contentBlocks.set(index, {
          type: "providerToolResult",
          callId: emittedCallId,
          name,
          result: delta.result,
          isError: delta.is_error === true,
          ...(asNonEmptyString(delta.signature) ? { thoughtSignature: asNonEmptyString(delta.signature) } : {}),
        });
      }
    } else if (deltaType === "thought_summary") {
      const thinkingBlock = ensureThinkingBlock(contentBlocks, index);
      if (thinkingBlock) {
        const summaryContent = asRecord(delta.content);
        if (summaryContent?.type === "text" && typeof summaryContent.text === "string") {
          thinkingBlock.thinking += summaryContent.text;
        }
      }
    } else if (deltaType === "thought_signature") {
      const thinkingBlock = ensureThinkingBlock(contentBlocks, index);
      if (thinkingBlock && typeof delta.signature === "string") {
        thinkingBlock.thinkingSignature = delta.signature;
      }
    }
    return;
  }
}

function mapGoogleEventToStreamParts(
  event: Record<string, unknown>,
  contentBlocks: Map<number, AssistantContentBlock>,
  providerToolCallsById: Map<string, ProviderToolCallState>,
): Array<Record<string, unknown>> {
  const eventType = event.event_type as string;
  if (eventType !== "content.start" && eventType !== "content.delta" && eventType !== "content.stop") {
    return [];
  }

  const index = typeof event.index === "number" ? event.index : 0;

  if (eventType === "content.start") {
    const content = asRecord(event.content);
    const contentType = asNonEmptyString(content?.type);

    if (contentType === "text") {
      const parts: Array<Record<string, unknown>> = [{ type: "text-start", id: streamIdForIndex(index) }];
      const initialText = asNonEmptyString(content?.text);
      if (initialText) {
        parts.push({ type: "text-delta", id: streamIdForIndex(index), text: initialText });
      }
      return parts;
    }

    if (contentType === "thought") {
      return [{ type: "reasoning-start", id: streamIdForIndex(index) }];
    }

    if (contentType === "function_call") {
      const block = contentBlocks.get(index);
      if (block?.type !== "toolCall") return [];
      const parts: Array<Record<string, unknown>> = [{ type: "tool-input-start", id: block.id, toolName: block.name }];
      if (Object.keys(block.arguments).length > 0) {
        parts.push({ type: "tool-input-delta", id: block.id, delta: safeJsonStringify(block.arguments) });
      }
      return parts;
    }

    if (contentType && isNativeGoogleToolCallContentType(contentType)) {
      const block = contentBlocks.get(index);
      if (block?.type !== "providerToolCall") return [];
      const parts: Array<Record<string, unknown>> = [{
        type: "tool-input-start",
        id: block.id,
        toolName: block.name,
        providerExecuted: true,
      }];
      if (Object.keys(block.arguments).length > 0) {
        parts.push({ type: "tool-input-delta", id: block.id, delta: safeJsonStringify(block.arguments) });
      }
      return parts;
    }

    return [];
  }

  if (eventType === "content.delta") {
    const delta = asRecord(event.delta);
    const deltaType = asNonEmptyString(delta?.type);

    if (deltaType === "text") {
      return [{ type: "text-delta", id: streamIdForIndex(index), text: String(delta?.text ?? "") }];
    }

    if (deltaType === "thought_summary") {
      const summaryContent = asRecord(delta?.content);
      if (summaryContent?.type === "text") {
        return [{ type: "reasoning-delta", id: streamIdForIndex(index), text: String(summaryContent.text ?? "") }];
      }
      return [];
    }

    if (deltaType === "function_call") {
      const block = contentBlocks.get(index);
      const deltaArgs = asRecord(delta?.arguments);
      if (block?.type !== "toolCall" || !deltaArgs) return [];
      return [{ type: "tool-input-delta", id: block.id, delta: safeJsonStringify(deltaArgs) }];
    }

    if (deltaType && isNativeGoogleToolCallContentType(deltaType)) {
      const block = contentBlocks.get(index);
      const deltaArgs = asRecord(delta?.arguments);
      if (block?.type !== "providerToolCall" || !deltaArgs) return [];
      return [{ type: "tool-input-delta", id: block.id, delta: safeJsonStringify(deltaArgs) }];
    }

    return [];
  }

  const block = contentBlocks.get(index);
  if (block?.type === "text") {
    return [{
      type: "text-end",
      id: streamIdForIndex(index),
      ...(block.annotations && block.annotations.length > 0 ? { annotations: block.annotations } : {}),
    }];
  }
  if (block?.type === "thinking") {
    return [{ type: "reasoning-end", id: streamIdForIndex(index) }];
  }
  if (block?.type === "toolCall") {
    return [
      { type: "tool-input-end", id: block.id },
      { type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.arguments },
    ];
  }
  if (block?.type === "providerToolCall") {
    return [{ type: "tool-input-end", id: block.id, toolName: block.name, providerExecuted: true }];
  }
  if (block?.type === "providerToolResult") {
    const call = providerToolCallsById.get(block.callId);
    const output = buildNativeGoogleToolResultOutput(
      block.name,
      block.callId,
      call?.arguments ?? {},
      block.result,
    );
    return [block.isError
      ? { type: "tool-error", toolCallId: block.callId, toolName: block.name, error: output, providerExecuted: true }
      : { type: "tool-result", toolCallId: block.callId, toolName: block.name, output, providerExecuted: true }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main step implementation
// ---------------------------------------------------------------------------

export const runGoogleNativeInteractionStep: RunGoogleNativeInteractionStep = async (
  opts: GoogleNativeStepRequest,
): Promise<GoogleNativeStepResult> => {
  const apiKey = resolveGoogleApiKey(opts.apiKey);
  const client = createGoogleClient(apiKey);

  const request = buildGoogleNativeRequest(opts);

  // Create streaming interaction
  const stream = await client.interactions.create({
    ...request,
    stream: true,
  } as Interactions.CreateModelInteractionParamsStreaming);

  const contentBlocks = new Map<number, AssistantContentBlock>();
  const providerToolCallsById = new Map<string, ProviderToolCallState>();
  const pendingAnnotationEnrichments: Array<Promise<void>> = [];
  let interactionId: string | undefined;
  let pendingEventDelivery = Promise.resolve();
  let usageData: Record<string, unknown> | undefined;

  const assistant: Record<string, unknown> = {
    role: "assistant",
    api: "google-interactions",
    provider: "google",
    model: opts.model.id,
    content: [],
    timestamp: Date.now(),
  };

  const emitEvent = async (event: Record<string, unknown>) => {
    await opts.onEvent?.(event);
  };

  const emitRawEvent = async (event: Record<string, unknown>) => {
    await opts.onRawEvent?.(event);
  };

  try {
    for await (const event of stream) {
      const eventRecord = event as unknown as Record<string, unknown>;
      const eventType = eventRecord.event_type as string;

      // Emit raw event for observability
      pendingEventDelivery = pendingEventDelivery.then(() => emitRawEvent(eventRecord));

      if (eventType === "interaction.start") {
        const interaction = eventRecord.interaction as Record<string, unknown> | undefined;
        interactionId = interaction?.id as string | undefined;
        continue;
      }

      if (eventType === "interaction.complete") {
        const interaction = eventRecord.interaction as Record<string, unknown> | undefined;
        if (!interactionId && interaction?.id) {
          interactionId = interaction.id as string;
        }
        usageData = interaction?.usage as Record<string, unknown> | undefined;
        continue;
      }

      if (eventType === "error") {
        const error = (eventRecord.error as Record<string, unknown>) ?? {};
        const message = (error.message as string) ?? (error.code as string) ?? "Google Interactions API error";
        throw new Error(message);
      }

      if (eventType === "content.start" || eventType === "content.delta" || eventType === "content.stop") {
        processStreamEvent(eventRecord, contentBlocks, providerToolCallsById);
        if (eventType === "content.stop") {
          const blockIndex = typeof eventRecord.index === "number" ? eventRecord.index : 0;
          queueTextBlockAnnotationEnrichment(
            pendingAnnotationEnrichments,
            contentBlocks.get(blockIndex),
          );
        }
        for (const part of mapGoogleEventToStreamParts(eventRecord, contentBlocks, providerToolCallsById)) {
          pendingEventDelivery = queueEventDelivery(
            pendingEventDelivery,
            emitEvent,
            part,
          );
        }
        continue;
      }
    }

    // Stream parts (including text-end) are emitted before citation fetches finish; see
    // test "queueTextBlockAnnotationEnrichment keeps slow citation fetches off the text-end hot path".
    // We still wait for enrichment before assembling assistant.content so follow-up Google steps
    // receive resolved citation URLs/titles in history.
    await Promise.all([pendingEventDelivery, Promise.all(pendingAnnotationEnrichments)]);

    if (opts.streamOptions.signal?.aborted) {
      throw new Error("Request was aborted");
    }

    // Build assistant content from collected blocks
    const contentArray: AssistantContentBlock[] = [];
    const sortedIndices = [...contentBlocks.keys()].sort((a, b) => a - b);
    for (const index of sortedIndices) {
      const block = contentBlocks.get(index)!;
      contentArray.push(block);
    }
    assistant.content = contentArray;

    // Determine stop reason
    const hasToolCalls = contentArray.some((b) => b.type === "toolCall");
    assistant.stopReason = hasToolCalls ? "tool_calls" : "stop";

    // Map usage
    if (usageData) {
      assistant.usage = {
        input: (usageData.total_input_tokens as number) ?? 0,
        output: (usageData.total_output_tokens as number) ?? 0,
        cacheRead: (usageData.total_cached_tokens as number) ?? 0,
        cacheWrite: 0,
        totalTokens: (usageData.total_tokens as number) ?? 0,
      };
    }

    return { assistant, interactionId };
  } catch (error) {
    await pendingEventDelivery.catch(() => undefined);
    await Promise.allSettled(pendingAnnotationEnrichments);
    await emitEvent({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const __internal = {
  buildGoogleNativeRequest,
  convertMessagesToInteractionsInput,
  convertToolsToInteractionsTools,
  enrichTextBlockAnnotations,
  googleTurnMessagesToModelMessages,
  mapGoogleEventToStreamParts,
  processStreamEvent,
  queueTextBlockAnnotationEnrichment,
  resolveGoogleApiKey,
} as const;
