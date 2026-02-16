import type { ProviderName } from "../types";

export type ModelStreamPartType =
  | "start"
  | "finish"
  | "abort"
  | "error"
  | "start_step"
  | "finish_step"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "tool_output_denied"
  | "tool_approval_request"
  | "source"
  | "file"
  | "raw"
  | "unknown";

export type ModelStreamReasoningMode = "reasoning" | "summary";

export interface NormalizedModelStreamPart {
  partType: ModelStreamPartType;
  part: Record<string, unknown>;
  rawPart?: unknown;
}

export interface NormalizeModelStreamPartOptions {
  provider: ProviderName;
  includeRawPart?: boolean;
}

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_KEYS = 128;
const MAX_STRING_LENGTH = 4000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asSafeString(value: unknown): string {
  if (typeof value === "string") return value;
  const sanitized = sanitizeUnknown(value);
  if (typeof sanitized === "string") return sanitized;
  if (sanitized === undefined || sanitized === null) return "";
  if (typeof sanitized === "number" || typeof sanitized === "boolean") return String(sanitized);
  try {
    return JSON.stringify(sanitized) ?? "";
  } catch {
    return String(sanitized);
  }
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function sanitizeUnknown(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null) return null;

  const t = typeof value;
  if (t === "string") return truncateString(value);
  if (t === "boolean") return value;
  if (t === "number") return Number.isFinite(value) ? value : String(value);
  if (t === "bigint") return value.toString();
  if (t === "undefined") return undefined;
  if (t === "symbol" || t === "function") return String(value);

  if (depth >= MAX_DEPTH) return "[max_depth]";

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : String(value);
  }

  if (value instanceof Error) {
    return compactRecord({
      name: value.name,
      message: value.message,
      stack: typeof value.stack === "string" ? truncateString(value.stack) : undefined,
    });
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const take = Math.min(value.length, MAX_ARRAY_ITEMS);
    for (let i = 0; i < take; i++) out.push(sanitizeUnknown(value[i], depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    return out;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    try {
      const entries = Object.entries(obj);
      const out: Record<string, unknown> = {};
      const take = Math.min(entries.length, MAX_OBJECT_KEYS);
      for (let i = 0; i < take; i++) {
        const [k, v] = entries[i]!;
        const sanitized = sanitizeUnknown(v, depth + 1, seen);
        if (sanitized !== undefined) out[k] = sanitized;
      }
      if (entries.length > MAX_OBJECT_KEYS) {
        out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  }

  return String(value);
}

function sanitizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const sanitized = sanitizeUnknown(value);
  return isPlainObject(sanitized) ? sanitized : undefined;
}

export function reasoningModeForProvider(provider: ProviderName): ModelStreamReasoningMode {
  return provider === "openai" || provider === "codex-cli" ? "summary" : "reasoning";
}

function withRaw(
  payload: Omit<NormalizedModelStreamPart, "rawPart">,
  includeRawPart: boolean,
  rawPart: unknown
): NormalizedModelStreamPart {
  if (!includeRawPart) return payload;
  return { ...payload, rawPart };
}

export function normalizeModelStreamPart(
  raw: unknown,
  opts: NormalizeModelStreamPartOptions
): NormalizedModelStreamPart {
  const includeRawPart = opts.includeRawPart ?? false;
  const rawPart = sanitizeUnknown(raw);
  const mode = reasoningModeForProvider(opts.provider);

  if (!isPlainObject(raw) || typeof raw.type !== "string") {
    return withRaw(
      {
        partType: "unknown",
        part: compactRecord({
          sdkType: typeof raw === "object" && raw !== null ? "invalid" : typeof raw,
          raw: rawPart,
        }),
      },
      includeRawPart,
      rawPart
    );
  }

  const type = raw.type;
  const providerMetadata = sanitizeRecord(raw.providerMetadata);

  switch (type) {
    case "start":
      return withRaw({ partType: "start", part: {} }, includeRawPart, rawPart);
    case "finish":
      const finishReason = sanitizeUnknown(raw.finishReason) ?? "unknown";
      return withRaw(
        {
          partType: "finish",
          part: compactRecord({
            finishReason,
            rawFinishReason: sanitizeUnknown(raw.rawFinishReason),
            totalUsage: sanitizeUnknown(raw.totalUsage),
          }),
        },
        includeRawPart,
        rawPart
      );
    case "abort":
      return withRaw(
        {
          partType: "abort",
          part: compactRecord({
            reason: sanitizeUnknown(raw.reason),
          }),
        },
        includeRawPart,
        rawPart
      );
    case "error":
      return withRaw(
        {
          partType: "error",
          part: { error: sanitizeUnknown(raw.error) },
        },
        includeRawPart,
        rawPart
      );
    case "start-step":
      return withRaw(
        {
          partType: "start_step",
          part: compactRecord({
            request: sanitizeUnknown(raw.request),
            warnings: sanitizeUnknown(raw.warnings),
          }),
        },
        includeRawPart,
        rawPart
      );
    case "finish-step":
      const stepFinishReason = sanitizeUnknown(raw.finishReason) ?? "unknown";
      return withRaw(
        {
          partType: "finish_step",
          part: compactRecord({
            response: sanitizeUnknown(raw.response),
            usage: sanitizeUnknown(raw.usage),
            finishReason: stepFinishReason,
            rawFinishReason: sanitizeUnknown(raw.rawFinishReason),
            providerMetadata: sanitizeUnknown(raw.providerMetadata),
          }),
        },
        includeRawPart,
        rawPart
      );
    case "text-start":
      return withRaw(
        {
          partType: "text_start",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "text-delta":
      return withRaw(
        {
          partType: "text_delta",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            text: asSafeString(raw.text),
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "text-end":
      return withRaw(
        {
          partType: "text_end",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "reasoning-start":
      return withRaw(
        {
          partType: "reasoning_start",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            mode,
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "reasoning-delta":
      return withRaw(
        {
          partType: "reasoning_delta",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            mode,
            text: asSafeString(raw.text),
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "reasoning-end":
      return withRaw(
        {
          partType: "reasoning_end",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            mode,
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "tool-input-start":
      return withRaw(
        {
          partType: "tool_input_start",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            toolName: asString(raw.toolName) ?? "tool",
            providerExecuted: asBoolean(raw.providerExecuted),
            dynamic: asBoolean(raw.dynamic),
            title: asString(raw.title),
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "tool-input-delta":
      return withRaw(
        {
          partType: "tool_input_delta",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            delta: asSafeString(raw.delta),
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "tool-input-end":
      return withRaw(
        {
          partType: "tool_input_end",
          part: compactRecord({
            id: asString(raw.id) ?? "",
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "tool-call":
      return withRaw(
        {
          partType: "tool_call",
          part: compactRecord({
            toolCallId: asString(raw.toolCallId) ?? asString(raw.id) ?? "",
            toolName: asString(raw.toolName) ?? "tool",
            input: sanitizeUnknown(raw.input) ?? {},
            dynamic: asBoolean(raw.dynamic),
            invalid: asBoolean(raw.invalid),
            error: sanitizeUnknown(raw.error),
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "tool-result":
      return withRaw(
        {
          partType: "tool_result",
          part: compactRecord({
            toolCallId: asString(raw.toolCallId) ?? asString(raw.id) ?? "",
            toolName: asString(raw.toolName) ?? "tool",
            output: sanitizeUnknown(raw.output) ?? null,
            dynamic: asBoolean(raw.dynamic),
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "tool-error":
      return withRaw(
        {
          partType: "tool_error",
          part: compactRecord({
            toolCallId: asString(raw.toolCallId) ?? asString(raw.id) ?? "",
            toolName: asString(raw.toolName) ?? "tool",
            error: sanitizeUnknown(raw.error) ?? "unknown_error",
            dynamic: asBoolean(raw.dynamic),
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "tool-output-denied":
      return withRaw(
        {
          partType: "tool_output_denied",
          part: compactRecord({
            toolCallId: asString(raw.toolCallId) ?? asString(raw.id) ?? "",
            toolName: asString(raw.toolName) ?? "tool",
            reason: sanitizeUnknown(raw.reason),
            providerMetadata,
          }),
        },
        includeRawPart,
        rawPart
      );
    case "tool-approval-request":
      return withRaw(
        {
          partType: "tool_approval_request",
          part: compactRecord({
            approvalId: asString(raw.approvalId) ?? "",
            toolCall: sanitizeUnknown(raw.toolCall) ?? {},
          }),
        },
        includeRawPart,
        rawPart
      );
    case "source":
      const sourcePayload = sanitizeUnknown(
        compactRecord({
          ...raw,
          type: undefined,
        })
      ) ?? {};
      return withRaw(
        {
          partType: "source",
          part: {
            source: sourcePayload,
          },
        },
        includeRawPart,
        rawPart
      );
    case "file":
      const filePayload = sanitizeUnknown(raw.file) ?? null;
      return withRaw(
        {
          partType: "file",
          part: { file: filePayload },
        },
        includeRawPart,
        rawPart
      );
    case "raw":
      const rawValue = sanitizeUnknown(
        "rawValue" in raw ? raw.rawValue : raw.raw
      ) ?? null;
      return withRaw(
        {
          partType: "raw",
          part: { raw: rawValue },
        },
        includeRawPart,
        rawPart
      );
    default:
      return withRaw(
        {
          partType: "unknown",
          part: compactRecord({
            sdkType: type,
            raw: rawPart,
          }),
        },
        includeRawPart,
        rawPart
      );
  }
}
