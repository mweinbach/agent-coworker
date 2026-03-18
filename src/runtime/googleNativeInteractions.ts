import { GoogleGenAI, type Interactions } from "@google/genai";

import type { GoogleInteractionsModelInfo } from "./googleInteractionsModel";
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

function convertToolCallId(id: string): string {
  // Strip PI-style composite IDs (call_id|item_id) → just call_id
  return id.includes("|") ? id.split("|")[0]! : id;
}

function convertMessagesToInteractionsInput(
  messages: ModelMessage[],
): InteractionsInput {
  const input: InteractionsInput = [];

  for (const msg of messages) {
    const role = msg.role;

    if (role === "user") {
      const text = extractTextFromContent(msg.content);
      if (text) {
        input.push({ type: "text", text });
      }
      continue;
    }

    if (role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const part of content) {
        const record = part as Record<string, unknown>;
        if (!record || typeof record !== "object") continue;

        if (record.type === "text") {
          input.push({ type: "text", text: record.text as string });
          continue;
        }

        if (record.type === "reasoning" || record.type === "thinking") {
          // Thought content with signature for replay
          const thoughtSignature = record.thinkingSignature as string | undefined;
          if (thoughtSignature) {
            input.push({
              type: "thought",
              signature: thoughtSignature,
              summary: record.text
                ? [{ type: "text", text: record.text as string }]
                : undefined,
            });
          }
          continue;
        }

        if (record.type === "tool-call" || record.type === "toolCall") {
          const toolCallId = (record.toolCallId ?? record.id) as string;
          const toolName = (record.toolName ?? record.name) as string;
          const args = (record.input ?? record.arguments ?? {}) as Record<string, unknown>;
          const thoughtSignature = record.thoughtSignature as string | undefined;
          input.push({
            type: "function_call",
            id: convertToolCallId(toolCallId),
            name: toolName,
            arguments: args,
            ...(thoughtSignature ? { signature: thoughtSignature } : {}),
          });
          continue;
        }
      }
      continue;
    }

    if (role === "tool") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const part of content) {
        const record = part as Record<string, unknown>;
        if (!record || typeof record !== "object") continue;

        if (record.type === "tool-result" || record.type === "toolResult") {
          const toolCallId = (record.toolCallId ?? record.id) as string;
          const isError = record.isError === true;
          const output = record.output;
          let resultText: string;
          if (typeof output === "string") {
            resultText = output;
          } else {
            const outputRecord = output as Record<string, unknown> | undefined;
            if (outputRecord?.type === "text" && typeof outputRecord.value === "string") {
              resultText = outputRecord.value;
            } else {
              resultText = JSON.stringify(output);
            }
          }

          input.push({
            type: "function_result",
            call_id: convertToolCallId(toolCallId),
            result: resultText,
            is_error: isError,
          });
        }
      }
      continue;
    }
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

        // Emit streaming parts
        if (eventType === "content.delta") {
          const delta = eventRecord.delta as Record<string, unknown> | undefined;
          if (delta) {
            const deltaType = delta.type as string;
            if (deltaType === "text") {
              pendingEventDelivery = pendingEventDelivery.then(() =>
                emitEvent({ type: "text-delta", textDelta: delta.text })
              );
            } else if (deltaType === "thought_summary") {
              const summaryContent = delta.content as Record<string, unknown> | undefined;
              if (summaryContent?.type === "text") {
                pendingEventDelivery = pendingEventDelivery.then(() =>
                  emitEvent({ type: "reasoning-delta", reasoningDelta: summaryContent.text })
                );
              }
            } else if (deltaType === "function_call") {
              const index = eventRecord.index as number;
              const block = contentBlocks.get(index);
              if (block?.type === "toolCall") {
                pendingEventDelivery = pendingEventDelivery.then(() =>
                  emitEvent({
                    type: "tool-call-delta",
                    toolCallId: block.id,
                    toolName: block.name,
                  })
                );
              }
            }
          }
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
      type: "done",
      reason: assistant.stopReason,
      message: assistant,
    });

    return { assistant, interactionId };
  } catch (error) {
    await pendingEventDelivery;
    await emitEvent({
      type: "error",
      error: {
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
};

export const __internal = {
  buildGoogleNativeRequest,
  convertMessagesToInteractionsInput,
  convertToolsToInteractionsTools,
  processStreamEvent,
  resolveGoogleApiKey,
} as const;
