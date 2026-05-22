import { asRecord, asString } from "../../shared/recordParsing";
import type { ModelMessage } from "../../types";
import type { CodexTextElement, CodexTurnInputPart } from "./types";

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        const record = asRecord(item);
        return asString(record?.text) ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(content);
  return asString(record?.text) ?? "";
}

export function latestUserMessage(messages: readonly ModelMessage[]): ModelMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const text = extractTextContent(message.content).trim();
      const hasElements = extractTextElements(message.content).length > 0;
      if (text || hasElements) return message;
    }
  }
  return null;
}

export function extractTextElements(content: unknown): CodexTextElement[] {
  if (!Array.isArray(content)) return [];
  const elements: CodexTextElement[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    const type = asString(record.type);
    const mimeType = asString(record.mimeType);
    const data = asString(record.data);
    const path = asString(record.path);
    const filename = asString(record.filename);
    if (!type && !mimeType && !data && !path && !filename) continue;
    if (type === "text" || type === "inputText" || type === "output_text") continue;
    elements.push({
      ...(type ? { type } : { type: "file" }),
      ...(mimeType ? { mimeType } : {}),
      ...(data ? { data } : {}),
      ...(path ? { path } : {}),
      ...(filename ? { filename } : {}),
    });
  }
  return elements;
}

function codexInputTextForMessage(message: ModelMessage, opts: { includeRole: boolean }): string {
  const text = extractTextContent(message.content).trim();
  if (!opts.includeRole) return text;
  const role = String(message.role || "message");
  const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role;
  return text ? `${label}: ${text}` : `${label}: [attachment]`;
}

function codexInputPartForMessage(
  message: ModelMessage,
  opts: { includeRole: boolean },
): CodexTurnInputPart | null {
  const textElements = extractTextElements(message.content);
  const text = codexInputTextForMessage(message, opts);
  if (!text && textElements.length === 0) return null;
  return {
    type: "text",
    text: text || "[attachment]",
    text_elements: textElements,
  };
}

export function buildCodexTurnInput(
  messages: readonly ModelMessage[],
  opts: { resumedThread: boolean },
): CodexTurnInputPart[] {
  if (opts.resumedThread) {
    const latest = latestUserMessage(messages);
    const part = latest ? codexInputPartForMessage(latest, { includeRole: false }) : null;
    return part ? [part] : [];
  }
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => codexInputPartForMessage(message, { includeRole: true }))
    .filter((part): part is CodexTurnInputPart => part !== null);
}
