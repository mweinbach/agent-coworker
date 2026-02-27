import type { Message as PiMessage } from "@mariozechner/pi-ai";

import type { ModelMessage } from "../types";
import type { RuntimeUsage } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text ? text : undefined;
}

function safeJsonStringify(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : String(value);
  } catch {
    return String(value);
  }
}

function contentTextParts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part.trim()) parts.push(part);
      continue;
    }
    const record = asRecord(part);
    if (!record) continue;
    const text = asString(record.text) ?? asString(record.inputText);
    if (text?.trim()) parts.push(text);
  }
  return parts;
}

function assistantContentFromModelContent(content: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (typeof content === "string") {
    if (content.trim()) out.push({ type: "text", text: content });
    return out;
  }

  if (!Array.isArray(content)) return out;
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;

    const partType = asString(record.type);
    if (partType === "tool-call" || partType === "toolCall") {
      out.push({
        type: "toolCall",
        id:
          asNonEmptyString(record.toolCallId) ??
          asNonEmptyString(record.id) ??
          `tool_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name: asNonEmptyString(record.toolName) ?? "tool",
        arguments: asRecord(record.input) ?? asRecord(record.arguments) ?? {},
      });
      continue;
    }

    if (partType === "reasoning" || partType === "thinking") {
      const thinkingText = asString(record.text) ?? asString(record.thinking);
      if (thinkingText?.trim()) {
        out.push({ type: "thinking", thinking: thinkingText });
      }
      continue;
    }

    const text = asString(record.text) ?? asString(record.inputText);
    if (text?.trim()) {
      out.push({ type: "text", text });
    }
  }

  return out;
}

function toolResultTextFromOutput(output: unknown): string {
  if (typeof output === "string") return output;
  const record = asRecord(output);
  if (!record) return safeJsonStringify(output);

  if (typeof record.value === "string") return record.value;
  if (record.type === "json" && record.value !== undefined) return safeJsonStringify(record.value);
  if (record.value !== undefined) return safeJsonStringify(record.value);
  return safeJsonStringify(output);
}

function toolResultMessagesFromModelMessage(message: Record<string, unknown>): PiMessage[] {
  const content = message.content;
  const roleToolCallId = asNonEmptyString(message.toolCallId) ?? asNonEmptyString(message.tool_call_id);
  const roleToolName = asNonEmptyString(message.toolName) ?? asNonEmptyString(message.tool_name) ?? "tool";
  const timestamp = Date.now();

  if (!Array.isArray(content)) {
    const text = contentTextParts(content).join("\n").trim();
    if (!text) return [];
    return [{
      role: "toolResult",
      toolCallId: roleToolCallId ?? `tool_${timestamp}`,
      toolName: roleToolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp,
    }] as PiMessage[];
  }

  const out: PiMessage[] = [];
  for (const rawPart of content) {
    const part = asRecord(rawPart);
    if (!part) continue;
    const partType = asString(part.type);
    if (partType !== "tool-result" && partType !== "toolResult") continue;

    const toolCallId =
      asNonEmptyString(part.toolCallId) ??
      asNonEmptyString(part.id) ??
      roleToolCallId ??
      `tool_${timestamp}_${out.length + 1}`;
    const toolName = asNonEmptyString(part.toolName) ?? roleToolName;
    const outputText = toolResultTextFromOutput(part.output ?? part.content);
    const isError = part.isError === true;

    out.push({
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: outputText }],
      isError,
      timestamp,
    } as PiMessage);
  }

  return out;
}

export function modelMessagesToPiMessages(messages: ModelMessage[], provider: string = "openai"): PiMessage[] {
  const out: PiMessage[] = [];
  const now = Date.now();
  for (const rawMessage of messages) {
    const message = asRecord(rawMessage);
    if (!message) continue;
    const role = asString(message.role);
    if (!role) continue;

    if (role === "user") {
      const textParts = contentTextParts(message.content);
      const text = textParts.join("\n").trim();
      if (!text) continue;
      out.push({
        role: "user",
        content: text,
        timestamp: now,
      } as PiMessage);
      continue;
    }

    if (role === "assistant") {
      const content = assistantContentFromModelContent(message.content);
      if (content.length === 0) {
        const fallback = contentTextParts(message.content).join("\n").trim();
        if (fallback) content.push({ type: "text", text: fallback });
      }
      if (content.length === 0) continue;

      out.push({
        role: "assistant",
        content: content as any,
        api: provider === "codex-cli" ? "openai-codex-responses" : `${provider}-responses`,
        provider: provider,
        model: "unknown",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now,
      } as PiMessage);
      continue;
    }

    if (role === "tool") {
      out.push(...toolResultMessagesFromModelMessage(message));
    }
  }
  return out;
}

function modelContentFromAssistantPart(part: Record<string, unknown>): Record<string, unknown> | null {
  const partType = asString(part.type);
  if (partType === "text") {
    const text = asString(part.text);
    return text === undefined ? null : { type: "text", text };
  }
  if (partType === "thinking") {
    const text = asString(part.thinking);
    return text === undefined ? null : { type: "reasoning", text };
  }
  if (partType === "toolCall") {
    return {
      type: "tool-call",
      toolCallId:
        asNonEmptyString(part.id) ??
        `tool_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      toolName: asNonEmptyString(part.name) ?? "tool",
      input: asRecord(part.arguments) ?? {},
    };
  }
  return null;
}

function toolResultContentToText(content: unknown): string {
  if (!Array.isArray(content)) return safeJsonStringify(content);
  const chunks: string[] = [];
  for (const rawPart of content) {
    const part = asRecord(rawPart);
    if (!part) continue;
    if (part.type === "text") {
      const text = asString(part.text);
      if (text !== undefined) chunks.push(text);
      continue;
    }
    if (part.type === "image") {
      chunks.push("[image]");
      continue;
    }
    chunks.push(safeJsonStringify(part));
  }
  return chunks.join("\n");
}

export function piTurnMessagesToModelMessages(messages: PiMessage[]): ModelMessage[] {
  // Note: This intentionally never emits 'user' role messages,
  // as it is only used to extract the new turn output (assistant/toolResults) to append to the chat.
  const out: ModelMessage[] = [];
  for (const rawMessage of messages as any[]) {
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const role = asString(rawMessage.role);
    if (role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      const rawContent = Array.isArray(rawMessage.content) ? rawMessage.content : [];
      for (const partRaw of rawContent) {
        const part = asRecord(partRaw);
        if (!part) continue;
        const mapped = modelContentFromAssistantPart(part);
        if (mapped) parts.push(mapped);
      }
      if (parts.length === 0) {
        const fallbackText = safeJsonStringify(rawMessage.content);
        if (fallbackText.trim()) {
          parts.push({ type: "text", text: fallbackText });
        }
      }
      out.push({ role: "assistant", content: parts } as ModelMessage);
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = asNonEmptyString(rawMessage.toolCallId) ?? `tool_${Date.now()}`;
      const toolName = asNonEmptyString(rawMessage.toolName) ?? "tool";
      const outputText = toolResultContentToText(rawMessage.content);
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "text", value: outputText },
          isError: rawMessage.isError === true,
        }],
      } as ModelMessage);
    }
  }
  return out;
}

export function extractPiAssistantText(messages: PiMessage[]): string {
  const chunks: string[] = [];
  for (const rawMessage of messages as any[]) {
    if (!rawMessage || rawMessage.role !== "assistant" || !Array.isArray(rawMessage.content)) continue;
    for (const rawPart of rawMessage.content) {
      const part = asRecord(rawPart);
      if (!part || part.type !== "text") continue;
      const text = asString(part.text);
      if (text?.trim()) chunks.push(text);
    }
  }
  return chunks.join("\n\n").trim();
}

export function extractPiReasoningText(messages: PiMessage[]): string | undefined {
  const chunks: string[] = [];
  for (const rawMessage of messages as any[]) {
    if (!rawMessage || rawMessage.role !== "assistant" || !Array.isArray(rawMessage.content)) continue;
    for (const rawPart of rawMessage.content) {
      const part = asRecord(rawPart);
      if (!part || part.type !== "thinking") continue;
      const text = asString(part.thinking);
      if (text?.trim()) chunks.push(text);
    }
  }
  if (chunks.length === 0) return undefined;
  return chunks.join("\n\n");
}

export function mergePiUsage(into: RuntimeUsage | undefined, usage: unknown): RuntimeUsage | undefined {
  const record = asRecord(usage);
  if (!record) return into;

  const input = typeof record.input === "number" && Number.isFinite(record.input) ? record.input : 0;
  const output = typeof record.output === "number" && Number.isFinite(record.output) ? record.output : 0;
  const total =
    typeof record.totalTokens === "number" && Number.isFinite(record.totalTokens)
      ? record.totalTokens
      : input + output;

  if (!into) {
    if (input === 0 && output === 0 && total === 0) return undefined;
    return {
      promptTokens: input,
      completionTokens: output,
      totalTokens: total,
    };
  }

  return {
    promptTokens: into.promptTokens + input,
    completionTokens: into.completionTokens + output,
    totalTokens: into.totalTokens + total,
  };
}
