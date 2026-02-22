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

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value as number) ? value : undefined;
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
  if (t === "string") return truncateString(value as string);
  if (t === "boolean") return value;
  if (t === "number") return Number.isFinite(value as number) ? value : String(value);
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

export function normalizeModelStreamPart(
  raw: unknown,
  opts: NormalizeModelStreamPartOptions
): NormalizedModelStreamPart {
  const includeRawPart = opts.includeRawPart ?? false;
  const rawPart = sanitizeUnknown(raw);
  const mode = reasoningModeForProvider(opts.provider);

  /** Emit a normalized part, compacting undefined fields from the record. */
  const emit = (partType: ModelStreamPartType, part: Record<string, unknown>): NormalizedModelStreamPart => {
    const payload: NormalizedModelStreamPart = { partType, part: compactRecord(part) };
    if (includeRawPart) payload.rawPart = rawPart;
    return payload;
  };

  if (!isPlainObject(raw) || typeof raw.type !== "string") {
    return emit("unknown", { sdkType: typeof raw === "object" && raw !== null ? "invalid" : typeof raw, raw: rawPart });
  }

  const type = raw.type;
  const providerMetadata = sanitizeRecord(raw.providerMetadata);

  // Shorthand extractors used across multiple branches.
  const id = () => asString(raw.id) ?? "";
  const toolCallId = () => asString(raw.toolCallId) ?? id();
  const toolName = () => asString(raw.toolName) ?? "tool";
  const san = sanitizeUnknown;

  switch (type) {
    case "start":
      return emit("start", {});
    case "finish":
      return emit("finish", { finishReason: san(raw.finishReason) ?? "unknown", rawFinishReason: san(raw.rawFinishReason), totalUsage: san(raw.totalUsage) });
    case "abort":
      return emit("abort", { reason: san(raw.reason) });
    case "error":
      return emit("error", { error: san(raw.error) });
    case "start-step":
      return emit("start_step", { stepNumber: asFiniteNumber(raw.stepNumber) ?? asFiniteNumber(raw.step), request: san(raw.request), warnings: san(raw.warnings) });
    case "finish-step":
      return emit("finish_step", { stepNumber: asFiniteNumber(raw.stepNumber) ?? asFiniteNumber(raw.step), response: san(raw.response), usage: san(raw.usage), finishReason: san(raw.finishReason) ?? "unknown", rawFinishReason: san(raw.rawFinishReason), providerMetadata: san(raw.providerMetadata) });
    case "text-start":
      return emit("text_start", { id: id(), providerMetadata });
    case "text-delta":
      return emit("text_delta", { id: id(), text: asSafeString(raw.text), providerMetadata });
    case "text-end":
      return emit("text_end", { id: id(), providerMetadata });
    case "reasoning-start":
      return emit("reasoning_start", { id: id(), mode, providerMetadata });
    case "reasoning-delta":
      return emit("reasoning_delta", { id: id(), mode, text: asSafeString(raw.text), providerMetadata });
    case "reasoning-end":
      return emit("reasoning_end", { id: id(), mode, providerMetadata });
    case "tool-input-start":
      return emit("tool_input_start", { id: id(), toolName: toolName(), providerExecuted: asBoolean(raw.providerExecuted), dynamic: asBoolean(raw.dynamic), title: asString(raw.title), providerMetadata });
    case "tool-input-delta":
      return emit("tool_input_delta", { id: id(), delta: asSafeString(raw.delta), providerMetadata });
    case "tool-input-end":
      return emit("tool_input_end", { id: id(), providerMetadata });
    case "tool-call":
      return emit("tool_call", { toolCallId: toolCallId(), toolName: toolName(), input: san(raw.input) ?? {}, dynamic: asBoolean(raw.dynamic), invalid: asBoolean(raw.invalid), error: san(raw.error), providerMetadata });
    case "tool-result":
      return emit("tool_result", { toolCallId: toolCallId(), toolName: toolName(), output: san(raw.output) ?? null, dynamic: asBoolean(raw.dynamic), providerMetadata });
    case "tool-error":
      return emit("tool_error", { toolCallId: toolCallId(), toolName: toolName(), error: san(raw.error) ?? "unknown_error", dynamic: asBoolean(raw.dynamic), providerMetadata });
    case "tool-output-denied":
      return emit("tool_output_denied", { toolCallId: toolCallId(), toolName: toolName(), reason: san(raw.reason), providerMetadata });
    case "tool-approval-request":
      return emit("tool_approval_request", { approvalId: asString(raw.approvalId) ?? "", toolCall: san(raw.toolCall) ?? {} });
    case "source":
      return emit("source", { source: san(compactRecord({ ...raw, type: undefined })) ?? {} });
    case "file":
      return emit("file", { file: san(raw.file) ?? null });
    case "raw":
      return emit("raw", { raw: san("rawValue" in raw ? raw.rawValue : raw.raw) ?? null });
    default:
      return emit("unknown", { sdkType: type, raw: rawPart });
  }
}
