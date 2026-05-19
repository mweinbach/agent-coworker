import { GoogleGenAI, type Interactions } from "@google/genai";
import { enrichCitationAnnotations } from "../server/citationMetadata";
import type { ModelMessage } from "../types";
import type { GoogleInteractionsModelInfo } from "./googleInteractionsModel";
import { piTurnMessagesToModelMessages, toolResultContentFromOutput } from "./piMessageBridge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoogleInteractionsToolChoice = Interactions.ToolChoiceType | Interactions.ToolChoiceConfig;

type GoogleInteractionsStreamOptions = {
  signal?: AbortSignal;
  temperature?: number;
  thinkingLevel?: Interactions.ThinkingLevel;
  thinkingBudget?: number;
  thinkingSummaries?: "auto" | "none";
  maxOutputTokens?: number;
  toolChoice?: GoogleInteractionsToolChoice;
  nativeWebSearch?: boolean;
  responseFormat?: unknown;
  responseMimeType?: string;
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

export type GoogleInteractionErrorKind =
  | "abort"
  | "auth"
  | "quota"
  | "stale_continuation"
  | "schema"
  | "output_size"
  | "retryable"
  | "unknown";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isGoogleGeneratedResponseSizeLimitError(error: unknown): boolean {
  const normalized = errorText(error).toLowerCase();
  return (
    (normalized.includes("generated response") &&
      (normalized.includes("exceeds") || normalized.includes("exceeded")) &&
      normalized.includes("size limit")) ||
    normalized.includes("maximum allowed size limit")
  );
}

function makeGoogleGeneratedResponseSizeLimitError(): Error & {
  code: "provider_error";
  source: "provider";
} {
  return Object.assign(
    new Error(
      "Gemini generated response exceeded the provider size limit. For large transcripts or extracted documents, write the full output to a workspace file in bounded chunks and return only the file path plus a concise summary in chat.",
    ),
    {
      code: "provider_error" as const,
      source: "provider" as const,
    },
  );
}

export function classifyGoogleInteractionError(error: unknown): GoogleInteractionErrorKind {
  const text = errorText(error);
  const normalized = text.toLowerCase();
  if (normalized.includes("abort")) return "abort";
  if (
    normalized.includes("api key") ||
    normalized.includes("unauthorized") ||
    normalized.includes("permission_denied") ||
    normalized.includes("401") ||
    normalized.includes("403")
  ) {
    return "auth";
  }
  if (
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("429")
  ) {
    return "quota";
  }
  if (
    (normalized.includes("previous_interaction") || normalized.includes("interaction_id")) &&
    (normalized.includes("not found") ||
      normalized.includes("invalid") ||
      normalized.includes("expired") ||
      normalized.includes("unknown"))
  ) {
    return "stale_continuation";
  }
  if (
    normalized.includes("schema") ||
    normalized.includes("invalid argument") ||
    normalized.includes("invalid_argument") ||
    normalized.includes("bad request") ||
    normalized.includes("400")
  ) {
    return "schema";
  }
  if (isGoogleGeneratedResponseSizeLimitError(error)) {
    return "output_size";
  }
  if (
    normalized.includes("timeout") ||
    normalized.includes("temporar") ||
    normalized.includes("unavailable") ||
    normalized.includes("internal") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504")
  ) {
    return "retryable";
  }
  return "unknown";
}

export function isRetryableGoogleInteractionError(error: unknown): boolean {
  const kind = classifyGoogleInteractionError(error);
  return kind === "retryable" || kind === "quota";
}

function resolveGoogleApiKey(explicitKey?: string): string {
  const direct = explicitKey?.trim();
  if (direct) return direct;

  const envKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (envKey) return envKey;

  throw new Error(
    "No API key for Google provider. Set GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY.",
  );
}

const googleInteractionsClientCache = new Map<string, Interactions>();

function getGoogleInteractionsClient(apiKey: string): Interactions {
  const cached = googleInteractionsClientCache.get(apiKey);
  if (cached) return cached;

  const client = new GoogleGenAI({ apiKey });
  const interactions = client.interactions;
  googleInteractionsClientCache.set(apiKey, interactions);
  return interactions;
}

// ---------------------------------------------------------------------------
// Message conversion: ModelMessage[] → Interactions API input
// ---------------------------------------------------------------------------

type InteractionsContent = Interactions.Content;
type InteractionsStep = Interactions.Step;
type InteractionsInput = InteractionsStep[];

type GoogleSignatureProviderKey = "google" | "vertex";

function convertToolCallId(id: string): string {
  // Strip PI-style composite IDs (call_id|item_id) → just call_id
  const firstSegment = id.split("|")[0];
  return firstSegment ?? id;
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
  const directSignature =
    asNonEmptyString(record.thoughtSignature) ??
    asNonEmptyString(record.thinkingSignature) ??
    asNonEmptyString(record.signature);
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

function getGoogleSignatureProviderKey(
  record: Record<string, unknown>,
): GoogleSignatureProviderKey {
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

function buildTextContent(text: unknown): Interactions.TextContent | null {
  const value = asNonEmptyString(text);
  return value ? { type: "text", text: value } : null;
}

function buildImageContent(record: Record<string, unknown>): Interactions.ImageContent | null {
  return buildBinaryContent(record, "image") as Interactions.ImageContent | null;
}

function buildBinaryContent(
  record: Record<string, unknown>,
  type: "image" | "audio" | "video" | "document",
): InteractionsContent | null {
  const data = asNonEmptyString(record.data);
  const uri = asNonEmptyString(record.uri);
  const mimeType = asNonEmptyString(record.mimeType) ?? asNonEmptyString(record.mime_type);
  if (!data && !uri) return null;
  return {
    type,
    ...(data ? { data } : {}),
    ...(uri ? { uri } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
  } as InteractionsContent;
}

function unsupportedFunctionResultBinaryPlaceholder(
  part: InteractionsContent,
): Interactions.TextContent {
  const record = part as unknown as Record<string, unknown>;
  const partType = asNonEmptyString(record.type) ?? "binary";
  const mimeType = asNonEmptyString(record.mime_type);
  const label = mimeType ? `${partType} (${mimeType})` : partType;
  return {
    type: "text",
    text: `[${label} tool result omitted: Gemini Interactions function_result supports text and image content only.]`,
  };
}

function convertRichContentParts(parts: unknown): InteractionsContent[] {
  if (!Array.isArray(parts)) return [];

  const content: InteractionsContent[] = [];
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
      continue;
    }

    if (partType === "audio" || partType === "video" || partType === "document") {
      const binaryPart = buildBinaryContent(record, partType);
      if (binaryPart) content.push(binaryPart);
    }
  }

  return content;
}

function userInputStep(content: InteractionsContent[]): InteractionsStep {
  return { type: "user_input", content } as InteractionsStep;
}

function modelOutputStep(content: InteractionsContent[]): InteractionsStep {
  return { type: "model_output", content } as InteractionsStep;
}

function stepsFromUserMessage(message: ModelMessage): InteractionsInput {
  if (typeof message.content === "string") {
    const textPart = buildTextContent(message.content);
    return textPart ? [userInputStep([textPart])] : [];
  }

  const parts = convertRichContentParts(message.content);
  return parts.length > 0 ? [userInputStep(parts)] : [];
}

function stepsFromAssistantMessage(message: ModelMessage): InteractionsInput {
  if (typeof message.content === "string") {
    const textPart = buildTextContent(message.content);
    return textPart ? [modelOutputStep([textPart])] : [];
  }
  if (!Array.isArray(message.content)) return [];

  const steps: InteractionsInput = [];
  let modelContent: InteractionsContent[] = [];
  const flushModelContent = () => {
    if (modelContent.length === 0) return;
    steps.push(modelOutputStep(modelContent));
    modelContent = [];
  };

  for (const rawPart of message.content) {
    if (typeof rawPart === "string") {
      const textPart = buildTextContent(rawPart);
      if (textPart) modelContent.push(textPart);
      continue;
    }

    const record = asRecord(rawPart);
    if (!record) continue;
    const partType = asNonEmptyString(record.type);

    if (partType === "text" || partType === "input_text" || partType === "output_text") {
      const textPart = buildTextContent(
        record.text ?? record.inputText ?? record.outputText ?? record.value,
      );
      if (textPart) modelContent.push(textPart);
      continue;
    }

    if (partType === "reasoning" || partType === "thinking") {
      const signature = getGoogleThoughtSignature(record);
      if (!signature) continue;
      const summaryPart = buildTextContent(record.text ?? record.thinking);
      flushModelContent();
      steps.push({
        type: "thought",
        signature,
        ...(summaryPart ? { summary: [summaryPart] } : {}),
      } as InteractionsStep);
      continue;
    }

    if (partType === "tool-call" || partType === "toolCall") {
      const toolCallId = asNonEmptyString(record.toolCallId) ?? asNonEmptyString(record.id);
      const toolName = asNonEmptyString(record.toolName) ?? asNonEmptyString(record.name);
      if (!toolCallId || !toolName) continue;
      const args = asRecord(record.input) ?? asRecord(record.arguments) ?? {};
      const signature = getGoogleThoughtSignature(record);
      flushModelContent();
      steps.push({
        type: "function_call",
        id: convertToolCallId(toolCallId),
        name: toolName,
        arguments: args,
        ...(signature ? { signature } : {}),
      } as InteractionsStep);
      continue;
    }

    if (partType === "providerToolCall") {
      const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
      const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
      if (!toolCallId || !toolName) continue;
      const nativeToolName = nativeToolNameFromWireName(toolName);
      if (!nativeToolName) continue;
      const args = asRecord(record.arguments) ?? asRecord(record.input) ?? {};
      const signature = getGoogleThoughtSignature(record);
      flushModelContent();
      steps.push({
        type: nativeGoogleToolCallContentType(nativeToolName),
        id: convertToolCallId(toolCallId),
        arguments: args,
        ...(signature ? { signature } : {}),
      } as InteractionsStep);
      continue;
    }

    if (partType === "providerToolResult") {
      const toolCallId =
        asNonEmptyString(record.callId) ??
        asNonEmptyString(record.toolCallId) ??
        asNonEmptyString(record.id);
      const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
      if (!toolCallId || !toolName) continue;
      const nativeToolName = nativeToolNameFromWireName(toolName);
      if (!nativeToolName) continue;
      const signature = getGoogleThoughtSignature(record);
      flushModelContent();
      steps.push({
        type: nativeGoogleToolResultContentType(nativeToolName),
        call_id: convertToolCallId(toolCallId),
        result: record.result,
        ...(record.isError === true ? { is_error: true } : {}),
        ...(signature ? { signature } : {}),
      } as InteractionsStep);
    }
  }

  flushModelContent();
  return steps;
}

function stepsFromToolMessage(message: ModelMessage): InteractionsInput {
  if (!Array.isArray(message.content)) return [];

  const steps: InteractionsInput = [];
  for (const rawPart of message.content) {
    const record = asRecord(rawPart);
    if (!record) continue;
    if (record.type !== "tool-result" && record.type !== "toolResult") continue;

    const toolCallId = asNonEmptyString(record.toolCallId) ?? asNonEmptyString(record.id);
    if (!toolCallId) continue;

    const toolName = asNonEmptyString(record.toolName);
    const richResult = toolResultContentFromOutput(record.output ?? record.content);
    const resultParts = richResult.flatMap<InteractionsContent>((part) => {
      if (part.type === "text") {
        const textPart = buildTextContent(part.text);
        return textPart ? [textPart] : [];
      }
      if (part.type === "image") {
        const imagePart = buildImageContent(part);
        return imagePart ? [imagePart] : [];
      }
      if (part.type === "audio" || part.type === "video" || part.type === "document") {
        const binaryPart = buildBinaryContent(part, part.type);
        if (!binaryPart) return [];
        return [unsupportedFunctionResultBinaryPlaceholder(binaryPart)];
      }
      return [];
    });

    const result =
      resultParts.length === 1 && resultParts[0]?.type === "text"
        ? resultParts[0].text
        : resultParts.length > 0
          ? resultParts
          : safeJsonStringify(record.output ?? record.content);
    const signature = getGoogleThoughtSignature(record);

    steps.push({
      type: "function_result",
      call_id: convertToolCallId(toolCallId),
      result,
      is_error: record.isError === true,
      ...(toolName ? { name: toolName } : {}),
      ...(signature ? { signature } : {}),
    } as InteractionsStep);
  }

  return steps;
}

function convertMessagesToInteractionsInput(messages: ModelMessage[]): InteractionsInput {
  const input: InteractionsInput = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      input.push(...stepsFromUserMessage(msg));
    } else if (msg.role === "assistant") {
      input.push(...stepsFromAssistantMessage(msg));
    } else if (msg.role === "tool") {
      input.push(...stepsFromToolMessage(msg));
    }
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
    const text =
      asNonEmptyString(record.text) ??
      asNonEmptyString(record.inputText) ??
      asNonEmptyString(record.outputText) ??
      asNonEmptyString(record.value);
    if (!text) return null;

    const annotations = asRecordArray(record.annotations);
    return {
      type: "text",
      text,
      ...(annotations.length > 0 ? { annotations } : {}),
    };
  }

  if (
    partType === "image" ||
    partType === "audio" ||
    partType === "video" ||
    partType === "document"
  ) {
    return {
      type: partType,
      ...(asNonEmptyString(record.data) ? { data: asNonEmptyString(record.data) } : {}),
      ...(asNonEmptyString(record.uri) ? { uri: asNonEmptyString(record.uri) } : {}),
      ...(asNonEmptyString(record.mime_type)
        ? { mimeType: asNonEmptyString(record.mime_type) }
        : {}),
    };
  }

  if (partType === "thought" || partType === "thinking" || partType === "reasoning") {
    const summary = Array.isArray(record.summary) ? record.summary : [];
    const summaryText = summary
      .map((entry) => asNonEmptyString(asRecord(entry)?.text))
      .filter((entry): entry is string => !!entry)
      .join("\n");
    const thinking =
      asNonEmptyString(record.thinking) ?? asNonEmptyString(record.text) ?? summaryText;
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

  if (partType === "function_call" || partType === "toolCall" || partType === "tool-call") {
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

  if (partType && isNativeGoogleToolCallContentType(partType)) {
    const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
    const toolName = nativeToolNameFromContentType(partType);
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

  if (partType && isNativeGoogleToolResultContentType(partType)) {
    const toolCallId =
      asNonEmptyString(record.call_id) ??
      asNonEmptyString(record.callId) ??
      asNonEmptyString(record.toolCallId) ??
      asNonEmptyString(record.id);
    const toolName = nativeToolNameFromContentType(partType);
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
    const toolCallId =
      asNonEmptyString(record.callId) ??
      asNonEmptyString(record.toolCallId) ??
      asNonEmptyString(record.id);
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

function _extractTextFromContent(content: unknown): string | undefined {
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

type NativeGoogleToolName =
  | "nativeWebSearch"
  | "nativeUrlContext"
  | "nativeFileSearch"
  | "nativeGoogleMaps"
  | "nativeMcpServerTool";

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
  if (contentType === "file_search_call" || contentType === "file_search_result") {
    return "nativeFileSearch";
  }
  if (contentType === "google_maps_call" || contentType === "google_maps_result") {
    return "nativeGoogleMaps";
  }
  if (contentType === "mcp_server_tool_call" || contentType === "mcp_server_tool_result") {
    return "nativeMcpServerTool";
  }
  return null;
}

function nativeToolNameFromWireName(name: string): NativeGoogleToolName | null {
  return (
    nativeToolNameFromContentType(name) ??
    (
      [
        "nativeWebSearch",
        "nativeUrlContext",
        "nativeFileSearch",
        "nativeGoogleMaps",
        "nativeMcpServerTool",
      ] as const
    ).find((entry) => entry === name) ??
    null
  );
}

function nativeGoogleToolCallContentType(name: NativeGoogleToolName): string {
  switch (name) {
    case "nativeWebSearch":
      return "google_search_call";
    case "nativeUrlContext":
      return "url_context_call";
    case "nativeFileSearch":
      return "file_search_call";
    case "nativeGoogleMaps":
      return "google_maps_call";
    case "nativeMcpServerTool":
      return "mcp_server_tool_call";
  }
}

function nativeGoogleToolResultContentType(name: NativeGoogleToolName): string {
  switch (name) {
    case "nativeWebSearch":
      return "google_search_result";
    case "nativeUrlContext":
      return "url_context_result";
    case "nativeFileSearch":
      return "file_search_result";
    case "nativeGoogleMaps":
      return "google_maps_result";
    case "nativeMcpServerTool":
      return "mcp_server_tool_result";
  }
}

function isNativeGoogleToolCallContentType(contentType: string): boolean {
  return nativeToolNameFromContentType(contentType) !== null && contentType.endsWith("_call");
}

function isNativeGoogleToolResultContentType(contentType: string): boolean {
  return nativeToolNameFromContentType(contentType) !== null && contentType.endsWith("_result");
}

function isGoogleCodeExecutionContentType(contentType: unknown): boolean {
  return contentType === "code_execution_call" || contentType === "code_execution_result";
}

function googleStreamEventContentType(event: Record<string, unknown>): string | undefined {
  return (
    asNonEmptyString(asRecord(event.content)?.type) ??
    asNonEmptyString(asRecord(event.step)?.type) ??
    asNonEmptyString(asRecord(event.delta)?.type)
  );
}

function appendJsonObjectDelta(target: Record<string, unknown>, delta: string): void {
  const previous = typeof target.__jsonDelta === "string" ? target.__jsonDelta : "";
  const next = `${previous}${delta}`;
  target.__jsonDelta = next;
  try {
    const parsed = JSON.parse(next) as unknown;
    const parsedRecord = asRecord(parsed);
    if (parsedRecord) {
      delete target.__jsonDelta;
      Object.assign(target, parsedRecord);
    }
  } catch {
    // Keep buffering until a later arguments_delta completes the JSON object.
  }
}

function isGoogleToolChoiceType(value: unknown): value is Interactions.ToolChoiceType {
  return value === "auto" || value === "any" || value === "none" || value === "validated";
}

function normalizeGoogleToolChoice(value: unknown): GoogleInteractionsToolChoice | undefined {
  if (isGoogleToolChoiceType(value)) return value;
  const record = asRecord(value);
  return record && record.allowed_tools !== undefined
    ? ({ allowed_tools: record.allowed_tools } as Interactions.ToolChoiceConfig)
    : undefined;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asNonEmptyString(entry)).filter((entry): entry is string => !!entry);
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

  if (name === "nativeFileSearch") {
    return {
      provider: "google",
      status: "completed",
      callId,
      results: extractResultEntries(result),
      raw: result,
    };
  }

  if (name === "nativeGoogleMaps") {
    return {
      provider: "google",
      status: "completed",
      callId,
      results: extractResultEntries(result),
      raw: result,
    };
  }

  if (name === "nativeMcpServerTool") {
    return {
      provider: "google",
      status: "completed",
      callId,
      serverName: asNonEmptyString(callArguments.server_name),
      name: asNonEmptyString(callArguments.name),
      result,
      raw: result,
    };
  }

  throw new Error(`Unknown native Google tool: ${name}`);
}

async function enrichTextBlockAnnotations(block: AssistantContentBlock | undefined): Promise<void> {
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
): Interactions.Tool[] {
  return tools.map(
    (tool) =>
      ({
        type: "function",
        name: asNonEmptyString(tool.name),
        description: asNonEmptyString(tool.description),
        parameters: tool.parameters,
      }) satisfies Interactions.Function,
  );
}

function hasToolNamed(tools: Array<Record<string, unknown>>, name: string): boolean {
  return tools.some((tool) => asNonEmptyString(tool.name) === name);
}

function canUseProviderNativeWebTools(tools: Array<Record<string, unknown>>): boolean {
  return hasToolNamed(tools, "webSearch") || hasToolNamed(tools, "webFetch");
}

function buildGoogleBuiltInTools(opts: GoogleNativeStepRequest): Interactions.Tool[] {
  const allowProviderNativeWebTools = canUseProviderNativeWebTools(opts.tools);
  const nativeWebSearchEnabled =
    opts.streamOptions.nativeWebSearch === true && allowProviderNativeWebTools;

  if (nativeWebSearchEnabled) {
    return [{ type: "google_search", search_types: ["web_search"] }, { type: "url_context" }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Build request
// ---------------------------------------------------------------------------

export function buildGoogleNativeRequest(
  opts: GoogleNativeStepRequest,
): Interactions.CreateModelInteractionParamsStreaming {
  const input = convertMessagesToInteractionsInput(opts.messages);
  const tools = [...convertToolsToInteractionsTools(opts.tools), ...buildGoogleBuiltInTools(opts)];

  const generationConfig: Interactions.GenerationConfig = {};

  if (opts.streamOptions.thinkingLevel) {
    generationConfig.thinking_level = opts.streamOptions.thinkingLevel;
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
  const toolChoice = normalizeGoogleToolChoice(opts.streamOptions.toolChoice);
  if (toolChoice) {
    generationConfig.tool_choice = toolChoice;
  }

  const request: Interactions.CreateModelInteractionParamsStreaming = {
    model: opts.model.id,
    input,
    stream: true,
    store: true,
    system_instruction: opts.systemPrompt,
    ...(opts.streamOptions.responseFormat !== undefined
      ? { response_format: opts.streamOptions.responseFormat }
      : {}),
    ...(opts.streamOptions.responseMimeType
      ? { response_mime_type: opts.streamOptions.responseMimeType }
      : {}),
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
  | {
      type: "image" | "audio" | "video" | "document";
      data?: string;
      uri?: string;
      mime_type?: string;
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | {
      type: "providerToolCall";
      id: string;
      name: NativeGoogleToolName;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | {
      type: "providerToolResult";
      callId: string;
      name: NativeGoogleToolName;
      result: unknown;
      isError?: boolean;
      thoughtSignature?: string;
    };

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
  providerToolCallsById: Map<string, ProviderToolCallState> | undefined,
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
    providerToolCallsById?.set(id, state);
  }
}

type GoogleStreamEventKind =
  | "interaction_start"
  | "interaction_complete"
  | "interaction_status"
  | "content"
  | "error"
  | "unknown";

function normalizeGoogleStreamEvent(event: Record<string, unknown>): {
  kind: GoogleStreamEventKind;
  eventType: string;
  index?: number;
  content?: Record<string, unknown> | null;
  delta?: Record<string, unknown> | null;
} {
  const eventType = asNonEmptyString(event.event_type) ?? "unknown";
  if (eventType === "interaction.start" || eventType === "interaction.created") {
    return { kind: "interaction_start", eventType };
  }
  if (eventType === "interaction.complete" || eventType === "interaction.completed") {
    return { kind: "interaction_complete", eventType };
  }
  if (eventType === "interaction.status_update") {
    return { kind: "interaction_status", eventType };
  }
  if (eventType === "error") {
    return { kind: "error", eventType };
  }
  if (
    eventType === "content.start" ||
    eventType === "content.delta" ||
    eventType === "content.stop" ||
    eventType === "step.start" ||
    eventType === "step.delta" ||
    eventType === "step.stop"
  ) {
    return {
      kind: "content",
      eventType,
      index: typeof event.index === "number" ? event.index : undefined,
      content: asRecord(event.content ?? event.step),
      delta: asRecord(event.delta),
    };
  }
  return { kind: "unknown", eventType };
}

function processStreamEvent(
  event: Record<string, unknown>,
  contentBlocks: Map<number, AssistantContentBlock>,
  providerToolCallsById?: Map<string, ProviderToolCallState>,
): void {
  const eventType = event.event_type as string;

  if (eventType === "content.start" || eventType === "step.start") {
    const index = event.index as number;
    const content = asRecord(event.content ?? event.step);
    if (!content) return;

    const contentType = asNonEmptyString(content.type);
    if (!contentType) return;
    if (contentType === "model_output") {
      const modelOutputContent = Array.isArray(content.content) ? content.content : [];
      const text = modelOutputContent
        .map((part) => asNonEmptyString(asRecord(part)?.text))
        .filter((part): part is string => !!part)
        .join("");
      const annotations = modelOutputContent.flatMap((part) =>
        asRecordArray(asRecord(part)?.annotations),
      );
      if (text || annotations.length > 0) {
        contentBlocks.set(index, {
          type: "text",
          text,
          ...(annotations.length > 0 ? { annotations } : {}),
        });
      }
    } else if (contentType === "text") {
      contentBlocks.set(index, {
        type: "text",
        text: asNonEmptyString(content.text) ?? "",
        ...(mergeAnnotationArrays(undefined, content.annotations)
          ? { annotations: mergeAnnotationArrays(undefined, content.annotations) }
          : {}),
      });
    } else if (
      contentType === "image" ||
      contentType === "audio" ||
      contentType === "video" ||
      contentType === "document"
    ) {
      contentBlocks.set(index, {
        type: contentType,
        ...(asNonEmptyString(content.data) ? { data: asNonEmptyString(content.data) } : {}),
        ...(asNonEmptyString(content.uri) ? { uri: asNonEmptyString(content.uri) } : {}),
        ...(asNonEmptyString(content.mime_type)
          ? { mime_type: asNonEmptyString(content.mime_type) }
          : {}),
      });
    } else if (contentType === "function_call") {
      contentBlocks.set(index, {
        type: "toolCall",
        id: asNonEmptyString(content.id) ?? `tool_${Date.now()}_${index}`,
        name: asNonEmptyString(content.name) ?? "tool",
        arguments: asRecord(content.arguments) ?? {},
        ...(asNonEmptyString(content.signature)
          ? { thoughtSignature: asNonEmptyString(content.signature) }
          : {}),
      });
    } else if (contentType === "thought") {
      const block = ensureThinkingBlock(contentBlocks, index);
      if (!block) return;
      const signature = asNonEmptyString(content.signature);
      if (signature) {
        block.thinkingSignature = signature;
      }
      const summary = Array.isArray(content.summary) ? content.summary : [];
      for (const entry of summary) {
        const text = asNonEmptyString(asRecord(entry)?.text);
        if (text) block.thinking += text;
      }
    } else if (isNativeGoogleToolCallContentType(contentType)) {
      const name = nativeToolNameFromContentType(contentType);
      if (!name) return;
      const id = asNonEmptyString(content.id) ?? `provider_tool_${Date.now()}_${index}`;
      const argumentsRecord = {
        ...(asRecord(content.arguments) ?? {}),
        ...(asNonEmptyString(content.name) ? { name: asNonEmptyString(content.name) } : {}),
        ...(asNonEmptyString(content.server_name)
          ? { server_name: asNonEmptyString(content.server_name) }
          : {}),
      };
      contentBlocks.set(index, {
        type: "providerToolCall",
        id,
        name,
        arguments: argumentsRecord,
        ...(asNonEmptyString(content.signature)
          ? { thoughtSignature: asNonEmptyString(content.signature) }
          : {}),
      });
      rememberProviderToolCall(providerToolCallsById, [id], id, name, argumentsRecord);
    } else if (isNativeGoogleToolResultContentType(contentType)) {
      const callId = asNonEmptyString(content.call_id);
      const providerToolCall = providerToolCallsById?.get(callId ?? "");
      const name = providerToolCall?.name ?? nativeToolNameFromContentType(contentType);
      const emittedCallId = providerToolCall?.emittedId ?? callId;
      if (!name || !callId || !emittedCallId) return;
      contentBlocks.set(index, {
        type: "providerToolResult",
        callId: emittedCallId,
        name,
        result: content.result,
        isError: content.is_error === true,
        ...(asNonEmptyString(content.signature)
          ? { thoughtSignature: asNonEmptyString(content.signature) }
          : {}),
      });
    }
    return;
  }

  if (eventType === "content.delta" || eventType === "step.delta") {
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
        ...(mergeAnnotationArrays(undefined, delta.annotations)
          ? { annotations: mergeAnnotationArrays(undefined, delta.annotations) }
          : {}),
      });
    } else if (
      deltaType === "image" ||
      deltaType === "audio" ||
      deltaType === "video" ||
      deltaType === "document"
    ) {
      const mediaBlock = existing?.type === deltaType ? existing : undefined;
      contentBlocks.set(index, {
        type: deltaType,
        ...(mediaBlock?.data ? { data: mediaBlock.data } : {}),
        ...(mediaBlock?.uri ? { uri: mediaBlock.uri } : {}),
        ...(mediaBlock?.mime_type ? { mime_type: mediaBlock.mime_type } : {}),
        ...(asNonEmptyString(delta.data) ? { data: asNonEmptyString(delta.data) } : {}),
        ...(asNonEmptyString(delta.uri) ? { uri: asNonEmptyString(delta.uri) } : {}),
        ...(asNonEmptyString(delta.mime_type)
          ? { mime_type: asNonEmptyString(delta.mime_type) }
          : {}),
      });
    } else if (deltaType === "text_annotation" || deltaType === "text_annotation_delta") {
      const annotations = mergeAnnotationArrays(
        existing?.type === "text" ? existing.annotations : undefined,
        delta.annotations,
      );
      if (existing?.type === "text") {
        existing.annotations = annotations;
      } else if (annotations && annotations.length > 0) {
        contentBlocks.set(index, { type: "text", text: "", annotations });
      }
    } else if (deltaType === "arguments_delta") {
      const deltaText = typeof delta.arguments === "string" ? delta.arguments : undefined;
      if (!deltaText) return;
      if (existing?.type === "toolCall" || existing?.type === "providerToolCall") {
        appendJsonObjectDelta(existing.arguments, deltaText);
      }
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
          ...(asNonEmptyString(delta.signature)
            ? { thoughtSignature: asNonEmptyString(delta.signature) }
            : {}),
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
        const deltaToolName = asNonEmptyString(delta.name);
        if (deltaToolName) {
          existing.arguments.name = deltaToolName;
        }
        const deltaServerName = asNonEmptyString(delta.server_name);
        if (deltaServerName) {
          existing.arguments.server_name = deltaServerName;
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
        const argumentsRecord = {
          ...(asRecord(delta.arguments) ?? {}),
          ...(asNonEmptyString(delta.name) ? { name: asNonEmptyString(delta.name) } : {}),
          ...(asNonEmptyString(delta.server_name)
            ? { server_name: asNonEmptyString(delta.server_name) }
            : {}),
        };
        contentBlocks.set(index, {
          type: "providerToolCall",
          id,
          name,
          arguments: argumentsRecord,
          ...(asNonEmptyString(delta.signature)
            ? { thoughtSignature: asNonEmptyString(delta.signature) }
            : {}),
        });
        rememberProviderToolCall(providerToolCallsById, [id], id, name, argumentsRecord);
      }
    } else if (isNativeGoogleToolResultContentType(deltaType)) {
      const callId = asNonEmptyString(delta.call_id);
      const providerToolCall = callId ? providerToolCallsById?.get(callId) : undefined;
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
          ...(asNonEmptyString(delta.signature)
            ? { thoughtSignature: asNonEmptyString(delta.signature) }
            : {}),
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
  providerToolCallsById?: Map<string, ProviderToolCallState>,
): Array<Record<string, unknown>> {
  const eventType = event.event_type as string;
  if (
    eventType !== "content.start" &&
    eventType !== "content.delta" &&
    eventType !== "content.stop" &&
    eventType !== "step.start" &&
    eventType !== "step.delta" &&
    eventType !== "step.stop"
  ) {
    return [];
  }

  const index = typeof event.index === "number" ? event.index : 0;

  if (eventType === "content.start" || eventType === "step.start") {
    const content = asRecord(event.content ?? event.step);
    const contentType = asNonEmptyString(content?.type);

    if (contentType === "text" || contentType === "model_output") {
      const parts: Array<Record<string, unknown>> = [
        { type: "text-start", id: streamIdForIndex(index) },
      ];
      const initialText =
        contentType === "model_output"
          ? (Array.isArray(content?.content) ? content.content : [])
              .map((part) => asNonEmptyString(asRecord(part)?.text))
              .filter((part): part is string => !!part)
              .join("")
          : asNonEmptyString(content?.text);
      if (initialText) {
        parts.push({ type: "text-delta", id: streamIdForIndex(index), text: initialText });
      }
      return parts;
    }

    if (contentType === "thought") {
      const parts: Array<Record<string, unknown>> = [
        { type: "reasoning-start", id: streamIdForIndex(index) },
      ];
      const summary = Array.isArray(content?.summary) ? content.summary : [];
      for (const entry of summary) {
        const text = asNonEmptyString(asRecord(entry)?.text);
        if (text) parts.push({ type: "reasoning-delta", id: streamIdForIndex(index), text });
      }
      return parts;
    }

    if (contentType === "function_call") {
      const block = contentBlocks.get(index);
      if (block?.type !== "toolCall") return [];
      const parts: Array<Record<string, unknown>> = [
        { type: "tool-input-start", id: block.id, toolName: block.name },
      ];
      if (Object.keys(block.arguments).length > 0) {
        parts.push({
          type: "tool-input-delta",
          id: block.id,
          delta: safeJsonStringify(block.arguments),
        });
      }
      return parts;
    }

    if (contentType && isNativeGoogleToolCallContentType(contentType)) {
      const block = contentBlocks.get(index);
      if (block?.type !== "providerToolCall") return [];
      const parts: Array<Record<string, unknown>> = [
        {
          type: "tool-input-start",
          id: block.id,
          toolName: block.name,
          providerExecuted: true,
        },
      ];
      if (Object.keys(block.arguments).length > 0) {
        parts.push({
          type: "tool-input-delta",
          id: block.id,
          delta: safeJsonStringify(block.arguments),
        });
      }
      return parts;
    }

    return [];
  }

  if (eventType === "content.delta" || eventType === "step.delta") {
    const delta = asRecord(event.delta);
    const deltaType = asNonEmptyString(delta?.type);

    if (deltaType === "text") {
      return [{ type: "text-delta", id: streamIdForIndex(index), text: String(delta?.text ?? "") }];
    }

    if (deltaType === "thought_summary") {
      const summaryContent = asRecord(delta?.content);
      if (summaryContent?.type === "text") {
        return [
          {
            type: "reasoning-delta",
            id: streamIdForIndex(index),
            text: String(summaryContent.text ?? ""),
          },
        ];
      }
      return [];
    }

    if (deltaType === "arguments_delta") {
      const block = contentBlocks.get(index);
      const deltaText = typeof delta?.arguments === "string" ? delta.arguments : undefined;
      if (!deltaText || (block?.type !== "toolCall" && block?.type !== "providerToolCall")) {
        return [];
      }
      return [{ type: "tool-input-delta", id: block.id, delta: deltaText }];
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
    return [
      {
        type: "text-end",
        id: streamIdForIndex(index),
        ...(block.annotations && block.annotations.length > 0
          ? { annotations: block.annotations }
          : {}),
      },
    ];
  }
  if (block?.type === "thinking") {
    return [{ type: "reasoning-end", id: streamIdForIndex(index) }];
  }
  if (
    block?.type === "image" ||
    block?.type === "audio" ||
    block?.type === "video" ||
    block?.type === "document"
  ) {
    const { type, ...media } = block;
    return [{ type: "file", mediaType: type, ...media }];
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
    const call = providerToolCallsById?.get(block.callId);
    const output = buildNativeGoogleToolResultOutput(
      block.name,
      block.callId,
      call?.arguments ?? {},
      block.result,
    );
    return [
      block.isError
        ? {
            type: "tool-error",
            toolCallId: block.callId,
            toolName: block.name,
            error: output,
            providerExecuted: true,
          }
        : {
            type: "tool-result",
            toolCallId: block.callId,
            toolName: block.name,
            output,
            providerExecuted: true,
          },
    ];
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
  const client = getGoogleInteractionsClient(apiKey);

  const request = buildGoogleNativeRequest(opts);

  // Create streaming interaction
  const stream = await client.create(
    request,
    opts.streamOptions.signal ? { signal: opts.streamOptions.signal } : undefined,
  );

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
      const normalizedEvent = normalizeGoogleStreamEvent(eventRecord);
      const eventType = normalizedEvent.eventType;

      // Emit raw event for observability and replay.
      pendingEventDelivery = pendingEventDelivery.then(() => emitRawEvent(eventRecord));

      if (isGoogleCodeExecutionContentType(googleStreamEventContentType(eventRecord))) {
        throw new Error(
          "Google native code execution is disabled. Use the harness bash tool for code execution.",
        );
      }

      if (eventType === "interaction.start" || eventType === "interaction.created") {
        const interaction = eventRecord.interaction as Record<string, unknown> | undefined;
        interactionId =
          asNonEmptyString(interaction?.id) ??
          asNonEmptyString(eventRecord.interaction_id) ??
          interactionId;
        continue;
      }

      if (eventType === "interaction.complete" || eventType === "interaction.completed") {
        const interaction = eventRecord.interaction as Record<string, unknown> | undefined;
        interactionId =
          asNonEmptyString(interaction?.id) ??
          asNonEmptyString(eventRecord.interaction_id) ??
          interactionId;
        usageData = interaction?.usage as Record<string, unknown> | undefined;
        continue;
      }

      if (eventType === "interaction.status_update") {
        interactionId = asNonEmptyString(eventRecord.interaction_id) ?? interactionId;
        continue;
      }

      if (eventType === "error") {
        const error = (eventRecord.error as Record<string, unknown>) ?? {};
        const message =
          (error.message as string) ?? (error.code as string) ?? "Google Interactions API error";
        if (isGoogleGeneratedResponseSizeLimitError(message)) {
          throw makeGoogleGeneratedResponseSizeLimitError();
        }
        throw new Error(message);
      }

      if (normalizedEvent.kind === "content") {
        processStreamEvent(eventRecord, contentBlocks, providerToolCallsById);
        if (eventType === "content.stop" || eventType === "step.stop") {
          const blockIndex = typeof eventRecord.index === "number" ? eventRecord.index : 0;
          queueTextBlockAnnotationEnrichment(
            pendingAnnotationEnrichments,
            contentBlocks.get(blockIndex),
          );
        }
        for (const part of mapGoogleEventToStreamParts(
          eventRecord,
          contentBlocks,
          providerToolCallsById,
        )) {
          pendingEventDelivery = queueEventDelivery(pendingEventDelivery, emitEvent, part);
        }
        continue;
      }

      if (normalizedEvent.kind === "unknown") {
        pendingEventDelivery = queueEventDelivery(pendingEventDelivery, emitEvent, {
          type: "unknown",
          provider: "google",
          eventType,
          event: eventRecord,
        });
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
      const block = contentBlocks.get(index);
      if (!block) continue;
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
    const normalizedError = isGoogleGeneratedResponseSizeLimitError(error)
      ? makeGoogleGeneratedResponseSizeLimitError()
      : error;
    await pendingEventDelivery.catch(() => undefined);
    await Promise.allSettled(pendingAnnotationEnrichments);
    await emitEvent({
      type: "error",
      error: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
    });
    throw normalizedError;
  }
};

export const __internal = {
  buildGoogleNativeRequest,
  convertMessagesToInteractionsInput,
  convertToolsToInteractionsTools,
  enrichTextBlockAnnotations,
  getGoogleInteractionsClient,
  googleTurnMessagesToModelMessages,
  classifyGoogleInteractionError,
  isGoogleGeneratedResponseSizeLimitError,
  isRetryableGoogleInteractionError,
  mapGoogleEventToStreamParts,
  normalizeGoogleStreamEvent,
  processStreamEvent,
  queueTextBlockAnnotationEnrichment,
  resolveGoogleApiKey,
  isGoogleCodeExecutionContentType,
  __testResetGoogleInteractionsClientCache: () => {
    googleInteractionsClientCache.clear();
  },
  __testGetGoogleInteractionsClientCacheSize: () => googleInteractionsClientCache.size,
} as const;
