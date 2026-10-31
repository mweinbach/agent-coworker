import type { ProviderName } from "../types";
import { reasoningModeForProvider } from "./modelStreamParts";

type RuntimeUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number;
  cacheWritePromptTokens: number;
  reasoningOutputTokens?: number;
  estimatedCostUsd?: number;
};

type ResponsesTextAnnotation = Record<string, unknown>;

type AssistantContentBlock =
  | { type: "thinking"; thinking?: string; thinkingSignature?: string }
  | {
      type: "text";
      text: string;
      textSignature?: string;
      phase?: string;
      annotations?: ResponsesTextAnnotation[];
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      partialJson?: string;
    };

type ResponsesProjectorOutput = Record<string, unknown> & {
  content: AssistantContentBlock[];
  usage?: Record<string, unknown>;
  stopReason?: string;
};

export type ResponsesStreamProjector = {
  output: ResponsesProjectorOutput;
  currentItem: Record<string, unknown> | null;
  currentBlock: AssistantContentBlock | null;
  completed: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseBestEffortJsonObject(partialJson: string): Record<string, unknown> {
  const trimmed = partialJson.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed) ?? {};
  } catch {
    // Best-effort completion of truncated object literals during client replay.
    let inString = false;
    let escaped = false;
    const closers: string[] = [];
    let safePrefix = trimmed;

    for (let i = 0; i < safePrefix.length; i += 1) {
      const ch = safePrefix[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") closers.push("}");
      else if (ch === "[") closers.push("]");
      else if ((ch === "}" || ch === "]") && closers.at(-1) === ch) closers.pop();
    }

    if (escaped) safePrefix = safePrefix.slice(0, -1);
    if (inString) safePrefix += '"';
    safePrefix = safePrefix.replace(/[,:\s]+$/, "");
    try {
      const repaired = JSON.parse(safePrefix + closers.reverse().join(""));
      return asRecord(repaired) ?? {};
    } catch {
      return {};
    }
  }
}

function mapStopReason(status: unknown): string {
  if (typeof status !== "string" || !status) return "stop";
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${String(status)}`);
  }
}

function normalizeProjectedUsage(usage: unknown): RuntimeUsage | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;

  const cachedPromptTokens =
    asFiniteNumber(record.cachedPromptTokens) ?? asFiniteNumber(record.cacheRead) ?? 0;
  const cacheWritePromptTokens =
    asFiniteNumber(record.cacheWritePromptTokens) ?? asFiniteNumber(record.cacheWrite) ?? 0;
  const costRecord = asRecord(record.cost);
  const promptTokens =
    asFiniteNumber(record.promptTokens) ??
    (asFiniteNumber(record.input) ?? 0) + cachedPromptTokens + cacheWritePromptTokens;
  const completionTokens =
    asFiniteNumber(record.completionTokens) ?? asFiniteNumber(record.output) ?? 0;
  const reasoningOutputTokens =
    asFiniteNumber(record.reasoningOutputTokens) ??
    asFiniteNumber(record.reasoning_output_tokens) ??
    asFiniteNumber(record.reasoningTokens) ??
    asFiniteNumber(record.reasoning_tokens);
  const totalTokens = asFiniteNumber(record.totalTokens) ?? promptTokens + completionTokens;
  const estimatedCostUsd =
    asFiniteNumber(record.estimatedCostUsd) ?? asFiniteNumber(costRecord?.total);

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    totalTokens === 0 &&
    cachedPromptTokens === 0 &&
    cacheWritePromptTokens === 0 &&
    reasoningOutputTokens === undefined &&
    estimatedCostUsd === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    cacheWritePromptTokens,
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
}

export function createResponsesStreamProjector(
  output: Record<string, unknown>,
): ResponsesStreamProjector {
  const withContent = output as ResponsesProjectorOutput;
  if (!Array.isArray(withContent.content)) {
    withContent.content = [];
  }
  return {
    output: withContent,
    currentItem: null,
    currentBlock: null,
    completed: false,
  };
}

export function projectResponsesStreamEvent(
  projector: ResponsesStreamProjector,
  event: Record<string, unknown>,
  stream: { push: (event: Record<string, unknown>) => void },
): void {
  const { output } = projector;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  if (event.type === "response.output_item.added") {
    const item = asRecord(event.item);
    if (!item) return;
    if (item.type === "reasoning") {
      projector.currentItem = {
        ...item,
        summary: Array.isArray(item.summary) ? [...item.summary] : [],
      };
      projector.currentBlock = { type: "thinking", thinking: "" };
      blocks.push(projector.currentBlock);
      stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
    } else if (item.type === "message") {
      projector.currentItem = {
        ...item,
        content: Array.isArray(item.content) ? [...item.content] : [],
      };
      projector.currentBlock = {
        type: "text",
        text: "",
        ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
      };
      blocks.push(projector.currentBlock);
      stream.push({
        type: "text_start",
        contentIndex: blockIndex(),
        partial: output,
        ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
      });
    } else if (item.type === "function_call") {
      projector.currentItem = { ...item };
      projector.currentBlock = {
        type: "toolCall",
        id: `${String(item.call_id ?? "")}|${String(item.id ?? "")}`,
        name: typeof item.name === "string" ? item.name : "tool",
        arguments: {},
        partialJson: typeof item.arguments === "string" ? item.arguments : "",
      };
      blocks.push(projector.currentBlock);
      stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
    }
    return;
  }

  if (event.type === "response.reasoning_summary_part.added") {
    if (projector.currentItem?.type === "reasoning") {
      const summary = Array.isArray(projector.currentItem.summary)
        ? projector.currentItem.summary
        : [];
      const part = asRecord(event.part);
      summary.push(part ? { ...part, text: typeof part.text === "string" ? part.text : "" } : {});
      projector.currentItem.summary = summary;
    }
    return;
  }

  if (event.type === "response.reasoning_summary_text.delta") {
    if (
      projector.currentItem?.type === "reasoning" &&
      projector.currentBlock?.type === "thinking"
    ) {
      const summary = Array.isArray(projector.currentItem.summary)
        ? projector.currentItem.summary
        : [];
      const lastPart = asRecord(summary[summary.length - 1]);
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (lastPart) {
        projector.currentBlock.thinking = `${projector.currentBlock.thinking ?? ""}${delta}`;
        lastPart.text = `${typeof lastPart.text === "string" ? lastPart.text : ""}${delta}`;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta,
          partial: output,
        });
      }
    }
    return;
  }

  if (event.type === "response.reasoning_summary_part.done") {
    if (
      projector.currentItem?.type === "reasoning" &&
      projector.currentBlock?.type === "thinking"
    ) {
      const summary = Array.isArray(projector.currentItem.summary)
        ? projector.currentItem.summary
        : [];
      const lastPart = asRecord(summary[summary.length - 1]);
      if (lastPart) {
        projector.currentBlock.thinking = `${projector.currentBlock.thinking ?? ""}\n\n`;
        lastPart.text = `${typeof lastPart.text === "string" ? lastPart.text : ""}\n\n`;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: "\n\n",
          partial: output,
        });
      }
    }
    return;
  }

  if (event.type === "response.content_part.added") {
    if (projector.currentItem?.type === "message") {
      const content = Array.isArray(projector.currentItem.content)
        ? projector.currentItem.content
        : [];
      const part = asRecord(event.part);
      if (part?.type === "output_text" || part?.type === "refusal") {
        content.push({ ...part });
        projector.currentItem.content = content;
      }
    }
    return;
  }

  if (event.type === "response.output_text.delta") {
    if (projector.currentItem?.type === "message" && projector.currentBlock?.type === "text") {
      const content = Array.isArray(projector.currentItem.content)
        ? projector.currentItem.content
        : [];
      const lastPart = asRecord(content[content.length - 1]);
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (lastPart?.type === "output_text") {
        projector.currentBlock.text += delta;
        lastPart.text = `${typeof lastPart.text === "string" ? lastPart.text : ""}${delta}`;
        stream.push({
          type: "text_delta",
          contentIndex: blockIndex(),
          delta,
          partial: output,
          ...(typeof projector.currentBlock.phase === "string"
            ? { phase: projector.currentBlock.phase }
            : {}),
        });
      }
    }
    return;
  }

  if (event.type === "response.refusal.delta") {
    if (projector.currentItem?.type === "message" && projector.currentBlock?.type === "text") {
      const content = Array.isArray(projector.currentItem.content)
        ? projector.currentItem.content
        : [];
      const lastPart = asRecord(content[content.length - 1]);
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (lastPart?.type === "refusal") {
        projector.currentBlock.text += delta;
        lastPart.refusal = `${typeof lastPart.refusal === "string" ? lastPart.refusal : ""}${delta}`;
        stream.push({
          type: "text_delta",
          contentIndex: blockIndex(),
          delta,
          partial: output,
          ...(typeof projector.currentBlock.phase === "string"
            ? { phase: projector.currentBlock.phase }
            : {}),
        });
      }
    }
    return;
  }

  if (event.type === "response.function_call_arguments.delta") {
    if (
      projector.currentItem?.type === "function_call" &&
      projector.currentBlock?.type === "toolCall"
    ) {
      const delta = typeof event.delta === "string" ? event.delta : "";
      projector.currentBlock.partialJson = `${projector.currentBlock.partialJson ?? ""}${delta}`;
      projector.currentBlock.arguments = parseBestEffortJsonObject(
        projector.currentBlock.partialJson,
      );
      stream.push({
        type: "toolcall_delta",
        contentIndex: blockIndex(),
        delta,
        partial: output,
      });
    }
    return;
  }

  if (event.type === "response.function_call_arguments.done") {
    if (
      projector.currentItem?.type === "function_call" &&
      projector.currentBlock?.type === "toolCall"
    ) {
      projector.currentBlock.partialJson =
        typeof event.arguments === "string" ? event.arguments : "";
      projector.currentBlock.arguments = parseBestEffortJsonObject(
        projector.currentBlock.partialJson,
      );
    }
    return;
  }

  if (event.type === "response.output_item.done") {
    const item = asRecord(event.item);
    if (!item) return;
    if (item.type === "reasoning" && projector.currentBlock?.type === "thinking") {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      projector.currentBlock.thinking =
        summary
          .map((part) => {
            const rec = asRecord(part);
            return typeof rec?.text === "string" ? rec.text : "";
          })
          .join("\n\n") || "";
      projector.currentBlock.thinkingSignature = JSON.stringify(item);
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: projector.currentBlock.thinking,
        partial: output,
      });
      projector.currentBlock = null;
    } else if (item.type === "message" && projector.currentBlock?.type === "text") {
      const annotations = Array.isArray(item.content)
        ? item.content.flatMap((rawContent) => {
            const content = asRecord(rawContent);
            if (content?.type !== "output_text" || !Array.isArray(content.annotations)) {
              return [];
            }
            return content.annotations.filter(
              (annotation): annotation is ResponsesTextAnnotation =>
                typeof annotation === "object" && annotation !== null && !Array.isArray(annotation),
            );
          })
        : [];
      if (Array.isArray(item.content) && item.content.length > 0) {
        projector.currentBlock.text = item.content
          .map((rawContent) => {
            const content = asRecord(rawContent);
            return content?.type === "output_text"
              ? typeof content.text === "string"
                ? content.text
                : ""
              : typeof content?.refusal === "string"
                ? content.refusal
                : "";
          })
          .join("");
      }
      if (typeof item.id === "string") {
        projector.currentBlock.textSignature = item.id;
      }
      projector.currentBlock.annotations = annotations;
      if (typeof item.phase === "string") {
        projector.currentBlock.phase = item.phase;
      }
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: projector.currentBlock.text,
        ...(annotations.length > 0 ? { annotations } : {}),
        partial: output,
        ...(typeof projector.currentBlock.phase === "string"
          ? { phase: projector.currentBlock.phase }
          : {}),
      });
      projector.currentBlock = null;
    } else if (item.type === "function_call") {
      const rawArgs =
        projector.currentBlock?.type === "toolCall" && projector.currentBlock.partialJson
          ? projector.currentBlock.partialJson
          : typeof item.arguments === "string" && item.arguments
            ? item.arguments
            : "{}";
      const args = parseBestEffortJsonObject(rawArgs);
      const toolCall = {
        type: "toolCall" as const,
        id: `${String(item.call_id ?? "")}|${String(item.id ?? "")}`,
        name: typeof item.name === "string" ? item.name : "tool",
        arguments: args,
      };
      if (projector.currentBlock?.type === "toolCall") {
        projector.currentBlock.id = toolCall.id;
        projector.currentBlock.name = toolCall.name;
        projector.currentBlock.arguments = args;
        delete projector.currentBlock.partialJson;
      } else {
        blocks.push(toolCall);
      }
      projector.currentBlock = null;
      stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
    }
    return;
  }

  if (
    event.type === "response.completed" ||
    event.type === "response.incomplete" ||
    event.type === "response.failed"
  ) {
    const response = asRecord(event.response);
    const usage = asRecord(response?.usage);
    if (usage) {
      const inputDetails = asRecord(usage.input_tokens_details);
      const outputDetails = asRecord(usage.output_tokens_details);
      const cachedTokens = asFiniteNumber(inputDetails?.cached_tokens) ?? 0;
      output.usage = {
        input: (asFiniteNumber(usage.input_tokens) ?? 0) - cachedTokens,
        output: asFiniteNumber(usage.output_tokens) ?? 0,
        cacheRead: cachedTokens,
        cacheWrite: 0,
        totalTokens: asFiniteNumber(usage.total_tokens) ?? 0,
        ...(outputDetails?.reasoning_tokens !== undefined
          ? { reasoningOutputTokens: outputDetails.reasoning_tokens }
          : {}),
      };
    }
    output.stopReason =
      event.type === "response.failed" ? "error" : mapStopReason(response?.status);
    if (event.type !== "response.completed") {
      throw new Error(
        asNonEmptyString(asRecord(response?.error)?.message) ??
          asNonEmptyString(asRecord(event.error)?.message) ??
          (event.type === "response.incomplete"
            ? "OpenAI response incomplete."
            : "OpenAI response failed."),
      );
    }
    projector.completed = true;
    if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
      output.stopReason = "toolUse";
    }
    return;
  }

  if (event.type === "error") {
    output.stopReason = "error";
    throw new Error(
      asNonEmptyString(asRecord(event.error)?.message) ??
        asNonEmptyString(event.message) ??
        "OpenAI response failed.",
    );
  }
}

function toolCallFromProjectedEvent(event: unknown): {
  toolCallId: string;
  toolName: string;
  input?: unknown;
} {
  const eventRecord = asRecord(event);
  const partial = asRecord(eventRecord?.partial);
  const contentIndex =
    typeof eventRecord?.contentIndex === "number" ? eventRecord.contentIndex : -1;
  const partialContent = Array.isArray(partial?.content) ? partial.content : [];
  const part = contentIndex >= 0 ? asRecord(partialContent[contentIndex]) : null;
  const fallbackId = contentIndex >= 0 ? `tool_call_${contentIndex}` : `tool_${Date.now()}`;
  const toolCallId =
    asNonEmptyString(part?.id) ??
    asNonEmptyString(asRecord(eventRecord?.toolCall)?.id) ??
    fallbackId;
  const toolName = asNonEmptyString(part?.name) ?? "tool";
  const input = part?.arguments ?? {};
  return { toolCallId, toolName, input };
}

export function mapProjectedResponsesEventToRawParts(
  event: unknown,
  provider: ProviderName,
): unknown[] {
  const eventRecord = asRecord(event);
  const mode = reasoningModeForProvider(provider);
  const contentIndex = typeof eventRecord?.contentIndex === "number" ? eventRecord.contentIndex : 0;
  const streamId = `s${contentIndex}`;

  switch (eventRecord?.type) {
    case "start":
      return [{ type: "start" }];
    case "text_start":
      return [
        {
          type: "text-start",
          id: streamId,
          ...(typeof eventRecord.phase === "string" ? { phase: eventRecord.phase } : {}),
        },
      ];
    case "text_delta":
      return [
        {
          type: "text-delta",
          id: streamId,
          text: String(eventRecord.delta ?? ""),
          ...(typeof eventRecord.phase === "string" ? { phase: eventRecord.phase } : {}),
        },
      ];
    case "text_end":
      return [
        {
          type: "text-end",
          id: streamId,
          ...(Array.isArray(eventRecord.annotations)
            ? { annotations: eventRecord.annotations }
            : {}),
          ...(typeof eventRecord.phase === "string" ? { phase: eventRecord.phase } : {}),
        },
      ];
    case "thinking_start":
      return [{ type: "reasoning-start", id: streamId, mode }];
    case "thinking_delta":
      return [
        { type: "reasoning-delta", id: streamId, mode, text: String(eventRecord.delta ?? "") },
      ];
    case "thinking_end":
      return [{ type: "reasoning-end", id: streamId, mode }];
    case "toolcall_start": {
      const toolCall = toolCallFromProjectedEvent(event);
      return [
        {
          type: "tool-input-start",
          id: toolCall.toolCallId,
          toolName: toolCall.toolName,
        },
      ];
    }
    case "toolcall_delta": {
      const toolCall = toolCallFromProjectedEvent(event);
      return [
        {
          type: "tool-input-delta",
          id: toolCall.toolCallId,
          delta: String(eventRecord.delta ?? ""),
        },
      ];
    }
    case "toolcall_end": {
      const toolCall = toolCallFromProjectedEvent(event);
      return [
        {
          type: "tool-input-end",
          id: toolCall.toolCallId,
        },
        {
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: asRecord(toolCall.input) ?? {},
        },
      ];
    }
    case "done": {
      const totalUsage = normalizeProjectedUsage(asRecord(eventRecord.message)?.usage);
      return [
        {
          type: "finish",
          finishReason: eventRecord.reason,
          totalUsage,
        },
      ];
    }
    case "error":
      return [
        {
          type: "error",
          error:
            asNonEmptyString(asRecord(eventRecord.error)?.errorMessage) ??
            eventRecord.error ??
            "Stream error",
        },
      ];
    default:
      return [
        {
          type: "unknown",
          sdkType: String(eventRecord?.type ?? "unknown"),
          raw: event,
        },
      ];
  }
}
