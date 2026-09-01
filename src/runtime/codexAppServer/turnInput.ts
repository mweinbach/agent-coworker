import { asFiniteNumber, asRecord, asString } from "../../shared/recordParsing";
import type { ModelMessage } from "../../types";
import type { CodexImageDetail, CodexTextElement, CodexTurnInputPart } from "./types";

function serializeHistoricalToolRecord(record: unknown): string {
  const ancestors: object[] = [];
  const errorDetails = new WeakMap<Error, Record<string, unknown>>();
  try {
    return JSON.stringify(record, function (this: Record<string, unknown>, key, value: unknown) {
      while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
      const original = this[key];
      const valueRecord = asRecord(value);
      if (
        ArrayBuffer.isView(original) ||
        original instanceof ArrayBuffer ||
        original instanceof Blob ||
        (valueRecord?.type === "Buffer" && Array.isArray(valueRecord.data))
      ) {
        return "[binary data omitted]";
      }
      const mediaPayload =
        (key === "data" || key === "image") &&
        ancestors.some((ancestor) => {
          const owner = asRecord(ancestor);
          return (
            owner &&
            (owner.mimeType !== undefined ||
              owner.mime_type !== undefined ||
              owner.mediaType !== undefined ||
              /^(image|input_?image|image_url|audio|input_audio|video|document|file|base64)$/.test(
                asString(owner.type)?.toLowerCase() ?? "",
              ))
          );
        });
      if (
        (typeof value === "string" && value.startsWith("data:")) ||
        ((typeof value === "string" || Array.isArray(value)) &&
          (mediaPayload || key === "blob" || key === "base64"))
      ) {
        return "[media data omitted]";
      }
      if (typeof value === "string" && /^\s*[{[]/.test(value)) {
        try {
          const parsed: unknown = JSON.parse(value);
          const sanitized = serializeHistoricalToolRecord(parsed);
          // Preserve ordinary JSON text byte-for-byte unless media was omitted.
          if (sanitized !== JSON.stringify(parsed)) return sanitized;
        } catch {
          // Tool text beginning with a brace or bracket need not be JSON.
        }
      }
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Error) {
        const details = errorDetails.get(value) ?? {
          ...value,
          name: value.name,
          message: value.message,
        };
        errorDetails.set(value, details);
        value = details;
      }
      if (value !== null && typeof value === "object") {
        if (ancestors.includes(value)) return "[circular reference omitted]";
        ancestors.push(value);
      }
      return value;
    });
  } catch {
    return "[unserializable historical tool record]";
  }
}

function extractTextContent(content: unknown, includeToolHistory: boolean): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextContent(item, includeToolHistory))
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(content);
  if (includeToolHistory && record) {
    const type = asString(record.type);
    if (type === "tool-call" || type === "toolCall") {
      return `[Historical tool call] ${serializeHistoricalToolRecord(record)}`;
    }
    if (type === "tool-result" || type === "toolResult" || type === "tool-error") {
      return `[Historical tool result] ${serializeHistoricalToolRecord(record)}`;
    }
  }
  return asString(record?.text) ?? "";
}

function latestUserMessage(messages: readonly ModelMessage[]): ModelMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      if (codexInputPartsForMessage(message, { includeRole: false }).length > 0) return message;
    }
  }
  return null;
}

function extractTextElements(content: unknown): CodexTextElement[] {
  if (!Array.isArray(content)) return [];
  const elements: CodexTextElement[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    const byteRange = asRecord(record.byteRange);
    const start = asFiniteNumber(byteRange?.start);
    const end = asFiniteNumber(byteRange?.end);
    if (start === undefined || end === undefined) continue;
    elements.push({
      byteRange: { start, end },
      placeholder: asString(record.placeholder) ?? null,
    });
  }
  return elements;
}

function codexImageDetail(value: unknown): CodexImageDetail | undefined {
  const detail = asString(value);
  if (detail === "low" || detail === "high" || detail === "original") return detail;
  return undefined;
}

function codexImageInputPartForRecord(record: Record<string, unknown>): CodexTurnInputPart | null {
  const type = asString(record.type);
  const mimeType = asString(record.mimeType) ?? asString(record.mime_type);
  const path = asString(record.path);
  const url = asString(record.url) ?? asString(record.imageUrl) ?? asString(record.image_url);
  const data = asString(record.data);
  const detail = codexImageDetail(record.detail);
  const imageMimeType = mimeType?.toLowerCase().startsWith("image/") ? mimeType : null;
  const imageTyped = type === "image" || type === "input_image" || type === "inputImage";

  if ((type === "localImage" || type === "local_image" || imageMimeType) && path) {
    return {
      type: "localImage",
      path,
      ...(detail ? { detail } : {}),
    };
  }
  if (url && (imageTyped || imageMimeType)) {
    return {
      type: "image",
      url,
      ...(detail ? { detail } : {}),
    };
  }
  if (data && (imageTyped || imageMimeType)) {
    return {
      type: "image",
      url: `data:${imageMimeType ?? "image/png"};base64,${data}`,
      ...(detail ? { detail } : {}),
    };
  }
  return null;
}

function extractImageInputParts(content: unknown): CodexTurnInputPart[] {
  if (!Array.isArray(content)) return [];
  const parts: CodexTurnInputPart[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    const imagePart = codexImageInputPartForRecord(record);
    if (imagePart) parts.push(imagePart);
  }
  return parts;
}

function roleLabel(role: ModelMessage["role"]): string {
  return role === "user" ? "User" : role === "assistant" ? "Assistant" : String(role || "message");
}

function codexInputTextForMessage(message: ModelMessage, opts: { includeRole: boolean }): string {
  const text = extractTextContent(message.content, opts.includeRole).trim();
  if (!opts.includeRole) return text;
  return text ? `${roleLabel(message.role)}: ${text}` : "";
}

function codexInputPartsForMessage(
  message: ModelMessage,
  opts: { includeRole: boolean },
): CodexTurnInputPart[] {
  const textElements = extractTextElements(message.content);
  const text = codexInputTextForMessage(message, opts);
  const imageParts = extractImageInputParts(message.content);
  if (!text && textElements.length === 0 && imageParts.length === 0) return [];

  const parts: CodexTurnInputPart[] = [];
  const textForPart =
    text ||
    (imageParts.length > 0 || textElements.length > 0
      ? opts.includeRole
        ? `${roleLabel(message.role)}: [attachment]`
        : "[attachment]"
      : "");
  if (textForPart || textElements.length > 0) {
    parts.push({
      type: "text",
      text: textForPart || "[attachment]",
      text_elements: textElements,
    });
  }
  parts.push(...imageParts);
  return parts;
}

export function buildCodexTurnInput(
  messages: readonly ModelMessage[],
  opts: { resumedThread: boolean },
): CodexTurnInputPart[] {
  if (opts.resumedThread) {
    const latest = latestUserMessage(messages);
    return latest ? codexInputPartsForMessage(latest, { includeRole: false }) : [];
  }
  return messages.flatMap((message) =>
    message.role === "system" ? [] : codexInputPartsForMessage(message, { includeRole: true }),
  );
}
