import { createHash } from "node:crypto";
import path from "node:path";

import type {
  ConversationImportSource,
  ConversationImportWarning,
  ExternalConversation,
  ExternalConversationItem,
} from "./types";

const MAX_ITEM_TEXT_CHARS = 80_000;
const MAX_TITLE_CHARS = 180;

export function stableHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex");
}

export function shortHash(value: unknown, length = 16): string {
  return stableHash(value).slice(0, length);
}

export function normalizeIsoTimestamp(
  value: unknown,
  fallback = new Date(0).toISOString(),
): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = Math.abs(value) > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

export function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .trim();
}

export function truncateText(
  value: string,
  limit: number,
  warnings?: ConversationImportWarning[],
): string {
  if (value.length <= limit) return value;
  warnings?.push({
    code: "truncated",
    message: `Imported text was truncated to ${limit} characters.`,
  });
  return `${value.slice(0, limit)}\n\n[truncated]`;
}

export function titleFromText(value: string, fallback: string): string {
  const text =
    normalizeText(value)
      .split("\n")
      .find((line) => line.trim()) ?? "";
  if (!text) return fallback;
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}...` : text;
}

export function safePathBasename(value: string | null | undefined): string {
  if (!value) return "Imported chat";
  return path.basename(value) || value;
}

export function extractTextFromContent(value: unknown): string {
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) {
    return normalizeText(
      value
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.input_text === "string") return record.input_text;
          if (typeof record.inputText === "string") return record.inputText;
          if (typeof record.content === "string") return record.content;
          return "";
        })
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return normalizeText(record.text);
    if (typeof record.content === "string") return normalizeText(record.content);
  }
  return "";
}

export function makeExternalItemId(input: {
  source: ConversationImportSource;
  sourceId: string;
  index: number;
  kind: ExternalConversationItem["kind"];
  seed?: unknown;
}): string {
  return `import-${input.source}-${shortHash({
    sourceId: input.sourceId,
    index: input.index,
    kind: input.kind,
    seed: input.seed,
  })}`;
}

export function makeConversationFingerprint(input: {
  source: ConversationImportSource;
  sourceId: string;
  sourcePath: string | null;
  createdAt: string;
  updatedAt: string;
  items: ExternalConversationItem[];
}): string {
  const first = input.items[0];
  const last = input.items.at(-1);
  return stableHash({
    source: input.source,
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    count: input.items.length,
    first,
    last,
  });
}

export function normalizeExternalConversation(
  input: Omit<ExternalConversation, "fingerprint"> & { fingerprint?: string | null },
): ExternalConversation {
  const warnings = [...input.warnings];
  const fallbackTs = normalizeIsoTimestamp(input.updatedAt, new Date(0).toISOString());
  const items = input.items
    .map((item, index): ExternalConversationItem => {
      const ts = normalizeIsoTimestamp(item.ts, fallbackTs);
      if (item.kind === "tool") {
        const error = item.error
          ? truncateText(normalizeText(item.error), MAX_ITEM_TEXT_CHARS, warnings)
          : undefined;
        return {
          ...item,
          id:
            item.id ||
            makeExternalItemId({
              source: input.source,
              sourceId: input.sourceId,
              index,
              kind: item.kind,
              seed: item,
            }),
          ts,
          name: normalizeText(item.name) || "tool",
          ...(error ? { error } : {}),
        };
      }
      const text = truncateText(normalizeText(item.text), MAX_ITEM_TEXT_CHARS, warnings);
      return {
        ...item,
        id:
          item.id ||
          makeExternalItemId({
            source: input.source,
            sourceId: input.sourceId,
            index,
            kind: item.kind,
            seed: item,
          }),
        ts,
        text,
      };
    })
    .filter((item) => item.kind === "tool" || item.text.length > 0)
    .toSorted((left, right) => left.ts.localeCompare(right.ts));

  const createdAt = normalizeIsoTimestamp(input.createdAt, items[0]?.ts ?? fallbackTs);
  const updatedAt = normalizeIsoTimestamp(input.updatedAt, items.at(-1)?.ts ?? createdAt);
  const title = titleFromText(
    input.title,
    titleFromText(items.find((item) => item.kind === "user")?.text ?? "", "Imported chat"),
  );
  const conversation = {
    ...input,
    title,
    createdAt,
    updatedAt,
    items,
    summary: input.summary
      ? truncateText(normalizeText(input.summary), MAX_ITEM_TEXT_CHARS, warnings)
      : null,
    warnings,
  };
  return {
    ...conversation,
    fingerprint:
      input.fingerprint ||
      makeConversationFingerprint({
        source: conversation.source,
        sourceId: conversation.sourceId,
        sourcePath: conversation.sourcePath,
        createdAt,
        updatedAt,
        items,
      }),
  };
}
