import type { ProviderName } from "../types";
import { reasoningModeForProvider } from "../server/modelStream";
import { normalizePiUsage } from "./piMessageBridge";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toolCallFromPartialLite(event: any): {
  toolCallId: string;
  toolName: string;
  input?: unknown;
} {
  const partial = asRecord(event?.partial);
  const contentIndex = typeof event?.contentIndex === "number" ? event.contentIndex : -1;
  const partialContent = Array.isArray(partial?.content) ? partial.content : [];
  const part = contentIndex >= 0 ? asRecord(partialContent[contentIndex]) : null;
  const fallbackId = contentIndex >= 0 ? `tool_call_${contentIndex}` : `tool_${Date.now()}`;
  const toolCallId = asNonEmptyString(part?.id) ?? asNonEmptyString(event?.toolCall?.id) ?? fallbackId;
  const toolName = asNonEmptyString(part?.name) ?? "tool";
  const input = part?.arguments ?? {};
  return { toolCallId, toolName, input };
}

export function mapPiEventToRawParts(
  event: any,
  provider: ProviderName,
  includeUnknown: boolean,
): unknown[] {
  const mode = reasoningModeForProvider(provider);
  const contentIndex = typeof event?.contentIndex === "number" ? event.contentIndex : 0;
  const streamId = `s${contentIndex}`;

  switch (event?.type) {
    case "start":
      return [{ type: "start" }];
    case "text_start":
      return [{
        type: "text-start",
        id: streamId,
        ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
      }];
    case "text_delta":
      return [{
        type: "text-delta",
        id: streamId,
        text: String(event.delta ?? ""),
        ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
      }];
    case "text_end":
      return [{
        type: "text-end",
        id: streamId,
        ...(Array.isArray(event.annotations) ? { annotations: event.annotations } : {}),
        ...(typeof event.phase === "string" ? { phase: event.phase } : {}),
      }];
    case "thinking_start":
      return [{ type: "reasoning-start", id: streamId, mode }];
    case "thinking_delta":
      return [{ type: "reasoning-delta", id: streamId, mode, text: String(event.delta ?? "") }];
    case "thinking_end":
      return [{ type: "reasoning-end", id: streamId, mode }];
    case "toolcall_start": {
      const toolCall = toolCallFromPartialLite(event);
      return [{
        type: "tool-input-start",
        id: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }];
    }
    case "toolcall_delta": {
      const toolCall = toolCallFromPartialLite(event);
      return [{
        type: "tool-input-delta",
        id: toolCall.toolCallId,
        delta: String(event.delta ?? ""),
      }];
    }
    case "toolcall_end": {
      const toolCall = toolCallFromPartialLite(event);
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
      const totalUsage = normalizePiUsage(event.message?.usage);
      return [{
        type: "finish",
        finishReason: event.reason,
        totalUsage,
      }];
    }
    case "error":
      return [{
        type: "error",
        error: event.error?.errorMessage ?? event.error ?? "PI stream error",
      }];
    default:
      if (!includeUnknown) return [];
      return [{
        type: "unknown",
        sdkType: String(event?.type ?? "unknown"),
        raw: event,
      }];
  }
}
