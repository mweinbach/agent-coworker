/**
 * Message format adapter between AI SDK ModelMessage and Pi Message types.
 *
 * This module handles:
 * 1. Converting legacy persisted AI SDK ModelMessage to Pi Message on load
 * 2. The canonical Pi Message type is used at runtime throughout
 *
 * Pi Message types:
 *   - UserMessage:       { role: "user", content: string | (TextContent | ImageContent)[], timestamp }
 *   - AssistantMessage:  { role: "assistant", content: (TextContent | ThinkingContent | ToolCall)[], ... }
 *   - ToolResultMessage: { role: "toolResult", toolCallId, toolName, content, isError, timestamp }
 */

import type {
  AssistantMessage,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./types";

// ── Legacy AI SDK message shape (for migration) ──────────────────────────────

/**
 * Minimal shape of an AI SDK ModelMessage, used only for recognizing
 * legacy persisted sessions and converting them forward.
 */
interface LegacyModelMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowTimestamp(): number {
  return Date.now();
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if a message looks like a legacy AI SDK ModelMessage
 * rather than a Pi Message (no `timestamp` field, etc.).
 */
export function isLegacyMessage(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  // Pi messages always have a numeric `timestamp`. Legacy ones don't.
  if (typeof m.timestamp === "number") return false;
  return typeof m.role === "string";
}

/**
 * Converts a single legacy AI SDK ModelMessage to the canonical Pi Message format.
 * If the message is already a Pi Message, it is returned as-is.
 */
export function convertLegacyMessage(msg: unknown): Message {
  if (!isLegacyMessage(msg)) return msg as Message;

  const m = msg as LegacyModelMessage;
  const ts = nowTimestamp();

  switch (m.role) {
    case "user":
      return convertLegacyUserMessage(m, ts);
    case "assistant":
      return convertLegacyAssistantMessage(m, ts);
    case "tool":
      return convertLegacyToolResultMessage(m, ts);
    default:
      // Best-effort: treat unknown roles as user messages.
      return {
        role: "user",
        content: stringifyContent(m.content),
        timestamp: ts,
      };
  }
}

/**
 * Converts an array of legacy messages, preserving order.
 */
export function convertLegacyMessages(msgs: unknown[]): Message[] {
  return msgs.map(convertLegacyMessage);
}

// ── Converters ───────────────────────────────────────────────────────────────

function convertLegacyUserMessage(m: LegacyModelMessage, ts: number): UserMessage {
  return {
    role: "user",
    content: stringifyContent(m.content),
    timestamp: ts,
  };
}

function convertLegacyAssistantMessage(m: LegacyModelMessage, ts: number): AssistantMessage {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];

  if (typeof m.content === "string") {
    content.push({ type: "text", text: m.content });
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (typeof part === "string") {
        content.push({ type: "text", text: part });
        continue;
      }
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;

      if (p.type === "text" && typeof p.text === "string") {
        content.push({ type: "text", text: p.text });
      } else if (p.type === "reasoning" && typeof p.text === "string") {
        content.push({ type: "thinking", thinking: p.text });
      } else if (p.type === "tool-call") {
        content.push({
          type: "toolCall",
          id: String(p.toolCallId ?? ""),
          name: String(p.toolName ?? ""),
          arguments: (typeof p.args === "object" && p.args !== null ? p.args : {}) as Record<string, any>,
        });
      }
    }
  }

  return {
    role: "assistant",
    content,
    api: "unknown" as any,
    provider: "unknown",
    model: "unknown",
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: ts,
  };
}

function convertLegacyToolResultMessage(m: LegacyModelMessage, ts: number): ToolResultMessage {
  const resultContent = Array.isArray(m.content) ? m.content : [];
  const textParts: TextContent[] = [];

  for (const part of resultContent) {
    if (typeof part === "string") {
      textParts.push({ type: "text", text: part });
      continue;
    }
    if (typeof part === "object" && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        textParts.push({ type: "text", text: p.text });
      }
    }
  }

  if (textParts.length === 0) {
    textParts.push({ type: "text", text: stringifyContent(m.content) });
  }

  return {
    role: "toolResult",
    toolCallId: String(m.toolCallId ?? ""),
    toolName: String(m.toolName ?? ""),
    content: textParts,
    isError: m.isError === true,
    timestamp: ts,
  };
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

// ── Runtime message factories ────────────────────────────────────────────────

/**
 * Creates a new Pi UserMessage.
 */
export function createUserMessage(content: string): UserMessage {
  return {
    role: "user",
    content,
    timestamp: nowTimestamp(),
  };
}
