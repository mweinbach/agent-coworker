import { GoogleGenAI, type Interactions } from "@google/genai";

import type { GoogleInteractionsModelInfo } from "./googleInteractionsModel";
import { toolResultContentFromOutput } from "./piMessageBridge";
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
  if (!Array.isArray(message.content)) return null;

  const parts: Array<Record<string, unknown>> = [];
  for (const rawPart of message.content) {
    const record = asRecord(rawPart);
    if (!record) continue;

    if (record.type === "text") {
      const textPart = buildTextContent(record.text);
      if (textPart) parts.push(textPart);
      continue;
    }

    if (record.type === "reasoning" || record.type === "thinking") {
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

    if (record.type === "tool-call" || record.type === "toolCall") {
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

// ---------------------------------------------------------------------------
// Build request
// ---------------------------------------------------------------------------

export function buildGoogleNativeRequest(
  opts: GoogleNativeStepRequest,
): Record<string, unknown> {
  const input = convertMessagesToInteractionsInput(opts.messages);
  const tools = convertToolsToInteractionsTools(opts.tools);

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
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string };

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

function processStreamEvent(
  event: Record<string, unknown>,
  contentBlocks: Map<number, AssistantContentBlock>,
): void {
  const eventType = event.event_type as string;

  if (eventType === "content.start") {
    const index = event.index as number;
    const content = event.content as Record<string, unknown> | undefined;
    if (!content) return;

    const contentType = content.type as string;
    if (contentType === "text") {
      contentBlocks.set(index, { type: "text", text: (content.text as string) ?? "" });
    } else if (contentType === "function_call") {
      contentBlocks.set(index, {
        type: "toolCall",
        id: (content.id as string) ?? `tool_${Date.now()}_${index}`,
        name: (content.name as string) ?? "tool",
        arguments: (content.arguments as Record<string, unknown>) ?? {},
        ...(content.signature ? { thoughtSignature: content.signature as string } : {}),
      });
    } else if (contentType === "thought") {
      contentBlocks.set(index, {
        type: "thinking",
        thinking: "",
        ...(content.signature ? { thinkingSignature: content.signature as string } : {}),
      });
    }
    return;
  }

  if (eventType === "content.delta") {
    const index = event.index as number;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!delta) return;

    const deltaType = delta.type as string;
    const existing = contentBlocks.get(index);

    if (deltaType === "text" && existing?.type === "text") {
      existing.text += (delta.text as string) ?? "";
    } else if (deltaType === "text" && !existing) {
      contentBlocks.set(index, { type: "text", text: (delta.text as string) ?? "" });
    } else if (deltaType === "function_call") {
      if (existing?.type === "toolCall") {
        const deltaName = asNonEmptyString(delta.name);
        if (deltaName) {
          existing.name = deltaName;
        }
        const deltaId = asNonEmptyString(delta.id);
        if (deltaId) {
          existing.id = deltaId;
        }
        const deltaSignature = asNonEmptyString(delta.signature);
        if (deltaSignature) {
          existing.thoughtSignature = deltaSignature;
        }
        // Merge arguments incrementally
        const deltaArgs = delta.arguments as Record<string, unknown> | undefined;
        if (deltaArgs) {
          Object.assign(existing.arguments, deltaArgs);
        }
      } else {
        contentBlocks.set(index, {
          type: "toolCall",
          id: (delta.id as string) ?? `tool_${Date.now()}_${index}`,
          name: (delta.name as string) ?? "tool",
          arguments: (delta.arguments as Record<string, unknown>) ?? {},
          ...(delta.signature ? { thoughtSignature: delta.signature as string } : {}),
        });
      }
    } else if (deltaType === "thought_summary") {
      if (existing?.type === "thinking") {
        const summaryContent = delta.content as Record<string, unknown> | undefined;
        if (summaryContent?.type === "text" && typeof summaryContent.text === "string") {
          existing.thinking += summaryContent.text;
        }
      }
    } else if (deltaType === "thought_signature") {
      if (existing?.type === "thinking" && typeof delta.signature === "string") {
        existing.thinkingSignature = delta.signature;
      }
    }
    return;
  }
}

function mapGoogleEventToStreamParts(
  event: Record<string, unknown>,
  contentBlocks: Map<number, AssistantContentBlock>,
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

    return [];
  }

  const block = contentBlocks.get(index);
  if (block?.type === "text") {
    return [{ type: "text-end", id: streamIdForIndex(index) }];
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

  await emitEvent({ type: "start" });

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
        processStreamEvent(eventRecord, contentBlocks);
        for (const part of mapGoogleEventToStreamParts(eventRecord, contentBlocks)) {
          pendingEventDelivery = queueEventDelivery(
            pendingEventDelivery,
            emitEvent,
            part,
          );
        }
        continue;
      }
    }

    await pendingEventDelivery;

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

    await emitEvent({
      type: "finish",
      finishReason: assistant.stopReason,
      totalUsage: assistant.usage,
    });

    return { assistant, interactionId };
  } catch (error) {
    await pendingEventDelivery;
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
  mapGoogleEventToStreamParts,
  processStreamEvent,
  resolveGoogleApiKey,
} as const;
