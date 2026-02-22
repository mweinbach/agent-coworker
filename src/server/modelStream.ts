import { z } from "zod";
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

const recordSchema = z.record(z.string(), z.unknown());
const typedRawPartSchema = z.object({ type: z.string() }).passthrough();
const stringSchema = z.string();
const booleanSchema = z.boolean();
const finiteNumberSchema = z.number().finite();

function asString(value: unknown): string | undefined {
  const parsed = stringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  const parsed = booleanSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const parsed = finiteNumberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const sanitized = sanitizeUnknown(value);
  const sanitizedRecord = recordSchema.safeParse(sanitized);
  return sanitizedRecord.success ? sanitizedRecord.data : undefined;
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

  const parsedRawPart = typedRawPartSchema.safeParse(raw);
  if (!parsedRawPart.success) {
    return emit("unknown", { sdkType: typeof raw === "object" && raw !== null ? "invalid" : typeof raw, raw: rawPart });
  }

  const parsedRaw = parsedRawPart.data;
  const type = parsedRaw.type;
  const providerMetadata = sanitizeRecord(parsedRaw.providerMetadata);

  // Shorthand extractors used across multiple branches.
  const id = () => asString(parsedRaw.id) ?? "";
  const toolCallId = () => asString(parsedRaw.toolCallId) ?? id();
  const toolName = () => asString(parsedRaw.toolName) ?? "tool";
  const san = sanitizeUnknown;

  switch (type) {
    case "start":
      return emit("start", {});
    case "finish":
      return emit("finish", { finishReason: san(parsedRaw.finishReason) ?? "unknown", rawFinishReason: san(parsedRaw.rawFinishReason), totalUsage: san(parsedRaw.totalUsage) });
    case "abort":
      return emit("abort", { reason: san(parsedRaw.reason) });
    case "error":
      return emit("error", { error: san(parsedRaw.error) });
    case "start-step":
      return emit("start_step", { stepNumber: asFiniteNumber(parsedRaw.stepNumber) ?? asFiniteNumber(parsedRaw.step), request: san(parsedRaw.request), warnings: san(parsedRaw.warnings) });
    case "finish-step":
      return emit("finish_step", { stepNumber: asFiniteNumber(parsedRaw.stepNumber) ?? asFiniteNumber(parsedRaw.step), response: san(parsedRaw.response), usage: san(parsedRaw.usage), finishReason: san(parsedRaw.finishReason) ?? "unknown", rawFinishReason: san(parsedRaw.rawFinishReason), providerMetadata: san(parsedRaw.providerMetadata) });
    case "text-start":
      return emit("text_start", { id: id(), providerMetadata });
    case "text-delta":
      return emit("text_delta", { id: id(), text: asSafeString(parsedRaw.text), providerMetadata });
    case "text-end":
      return emit("text_end", { id: id(), providerMetadata });
    case "reasoning-start":
      return emit("reasoning_start", { id: id(), mode, providerMetadata });
    case "reasoning-delta":
      return emit("reasoning_delta", { id: id(), mode, text: asSafeString(parsedRaw.text), providerMetadata });
    case "reasoning-end":
      return emit("reasoning_end", { id: id(), mode, providerMetadata });
    case "tool-input-start":
      return emit("tool_input_start", { id: id(), toolName: toolName(), providerExecuted: asBoolean(parsedRaw.providerExecuted), dynamic: asBoolean(parsedRaw.dynamic), title: asString(parsedRaw.title), providerMetadata });
    case "tool-input-delta":
      return emit("tool_input_delta", { id: id(), delta: asSafeString(parsedRaw.delta), providerMetadata });
    case "tool-input-end":
      return emit("tool_input_end", { id: id(), providerMetadata });
    case "tool-call":
      return emit("tool_call", { toolCallId: toolCallId(), toolName: toolName(), input: san(parsedRaw.input) ?? {}, dynamic: asBoolean(parsedRaw.dynamic), invalid: asBoolean(parsedRaw.invalid), error: san(parsedRaw.error), providerMetadata });
    case "tool-result":
      return emit("tool_result", { toolCallId: toolCallId(), toolName: toolName(), output: san(parsedRaw.output) ?? null, dynamic: asBoolean(parsedRaw.dynamic), providerMetadata });
    case "tool-error":
      return emit("tool_error", { toolCallId: toolCallId(), toolName: toolName(), error: san(parsedRaw.error) ?? "unknown_error", dynamic: asBoolean(parsedRaw.dynamic), providerMetadata });
    case "tool-output-denied":
      return emit("tool_output_denied", { toolCallId: toolCallId(), toolName: toolName(), reason: san(parsedRaw.reason), providerMetadata });
    case "tool-approval-request":
      return emit("tool_approval_request", { approvalId: asString(parsedRaw.approvalId) ?? "", toolCall: san(parsedRaw.toolCall) ?? {} });
    case "source":
      return emit("source", { source: san(compactRecord({ ...parsedRaw, type: undefined })) ?? {} });
    case "file":
      return emit("file", { file: san(parsedRaw.file) ?? null });
    case "raw":
      return emit("raw", { raw: san("rawValue" in parsedRaw ? parsedRaw.rawValue : parsedRaw.raw) ?? null });
    default:
      return emit("unknown", { sdkType: type, raw: rawPart });
  }
}
