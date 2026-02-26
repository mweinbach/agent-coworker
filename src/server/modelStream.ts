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
  fallbackIdSeed?: string;
  rawPartMode?: "sanitized" | "full";
}

type SanitizeLimits = {
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxStringLength: number;
};

const DEFAULT_SANITIZE_LIMITS: SanitizeLimits = {
  maxDepth: 8,
  maxArrayItems: 128,
  maxObjectKeys: 128,
  maxStringLength: 4000,
};

const FULL_SANITIZE_LIMITS: SanitizeLimits = {
  maxDepth: 24,
  maxArrayItems: 1024,
  maxObjectKeys: 1024,
  maxStringLength: 20000,
};

const recordSchema = z.record(z.string(), z.unknown());
const typedRawPartSchema = z.object({ type: z.string() }).passthrough();
const stringSchema = z.string();
const booleanSchema = z.boolean();
const finiteNumberSchema = z.number().finite();
type ParsedRawPart = z.infer<typeof typedRawPartSchema>;
type EmitPart = (partType: ModelStreamPartType, part: Record<string, unknown>) => NormalizedModelStreamPart;
type PartNormalizerContext = {
  emit: EmitPart;
  parsedRaw: ParsedRawPart;
  providerMetadata?: unknown;
  mode: ModelStreamReasoningMode;
  id: () => string;
  toolCallId: () => string;
  toolName: () => string;
  fallbackId: (kind: string) => string;
  san: (value: unknown) => unknown;
};

const streamPartNormalizers: Record<string, (ctx: PartNormalizerContext) => NormalizedModelStreamPart> = {
  start: ({ emit }) => emit("start", {}),
  finish: ({ emit, parsedRaw, san }) =>
    emit("finish", {
      finishReason: san(parsedRaw.finishReason) ?? "unknown",
      rawFinishReason: san(parsedRaw.rawFinishReason),
      totalUsage: san(parsedRaw.totalUsage),
    }),
  abort: ({ emit, parsedRaw, san }) => emit("abort", { reason: san(parsedRaw.reason) }),
  error: ({ emit, parsedRaw, san }) => emit("error", { error: san(parsedRaw.error) }),
  "start-step": ({ emit, parsedRaw, san }) =>
    emit("start_step", {
      stepNumber: asFiniteNumber(parsedRaw.stepNumber) ?? asFiniteNumber(parsedRaw.step),
      request: san(parsedRaw.request),
      warnings: san(parsedRaw.warnings),
    }),
  "finish-step": ({ emit, parsedRaw, san }) =>
    emit("finish_step", {
      stepNumber: asFiniteNumber(parsedRaw.stepNumber) ?? asFiniteNumber(parsedRaw.step),
      response: san(parsedRaw.response),
      usage: san(parsedRaw.usage),
      finishReason: san(parsedRaw.finishReason) ?? "unknown",
      rawFinishReason: san(parsedRaw.rawFinishReason),
      providerMetadata: san(parsedRaw.providerMetadata),
    }),
  "text-start": ({ emit, id, providerMetadata }) => emit("text_start", { id: id(), providerMetadata }),
  "text-delta": ({ emit, parsedRaw, id, providerMetadata }) =>
    emit("text_delta", {
      id: id(),
      text: asSafeString(parsedRaw.text),
      providerMetadata,
    }),
  "text-end": ({ emit, id, providerMetadata }) => emit("text_end", { id: id(), providerMetadata }),
  "reasoning-start": ({ emit, id, mode, providerMetadata }) =>
    emit("reasoning_start", {
      id: id(),
      mode,
      providerMetadata,
    }),
  "reasoning-delta": ({ emit, parsedRaw, id, mode, providerMetadata }) =>
    emit("reasoning_delta", {
      id: id(),
      mode,
      text: asSafeString(parsedRaw.text),
      providerMetadata,
    }),
  "reasoning-end": ({ emit, id, mode, providerMetadata }) =>
    emit("reasoning_end", {
      id: id(),
      mode,
      providerMetadata,
    }),
  "tool-input-start": ({ emit, parsedRaw, toolCallId, toolName, providerMetadata }) =>
    emit("tool_input_start", {
      id: toolCallId(),
      toolName: toolName(),
      providerExecuted: asBoolean(parsedRaw.providerExecuted),
      dynamic: asBoolean(parsedRaw.dynamic),
      title: asString(parsedRaw.title),
      providerMetadata,
    }),
  "tool-input-delta": ({ emit, parsedRaw, toolCallId, providerMetadata }) =>
    emit("tool_input_delta", {
      id: toolCallId(),
      delta: asSafeString(parsedRaw.delta),
      providerMetadata,
    }),
  "tool-input-end": ({ emit, toolCallId, providerMetadata }) =>
    emit("tool_input_end", { id: toolCallId(), providerMetadata }),
  "tool-call": ({ emit, parsedRaw, toolCallId, toolName, san, providerMetadata }) =>
    emit("tool_call", {
      toolCallId: toolCallId(),
      toolName: toolName(),
      input: san(parsedRaw.input) ?? {},
      dynamic: asBoolean(parsedRaw.dynamic),
      invalid: asBoolean(parsedRaw.invalid),
      error: san(parsedRaw.error),
      providerMetadata,
    }),
  "tool-result": ({ emit, parsedRaw, toolCallId, toolName, san, providerMetadata }) =>
    emit("tool_result", {
      toolCallId: toolCallId(),
      toolName: toolName(),
      output: san(parsedRaw.output) ?? null,
      dynamic: asBoolean(parsedRaw.dynamic),
      providerMetadata,
    }),
  "tool-error": ({ emit, parsedRaw, toolCallId, toolName, san, providerMetadata }) =>
    emit("tool_error", {
      toolCallId: toolCallId(),
      toolName: toolName(),
      error: san(parsedRaw.error) ?? "unknown_error",
      dynamic: asBoolean(parsedRaw.dynamic),
      providerMetadata,
    }),
  "tool-output-denied": ({ emit, parsedRaw, toolCallId, toolName, san, providerMetadata }) =>
    emit("tool_output_denied", {
      toolCallId: toolCallId(),
      toolName: toolName(),
      reason: san(parsedRaw.reason),
      providerMetadata,
    }),
  "tool-approval-request": ({ emit, parsedRaw, fallbackId, san }) =>
    emit("tool_approval_request", {
      approvalId: asIdString(parsedRaw.approvalId) ?? fallbackId("approval"),
      toolCall: san(parsedRaw.toolCall) ?? {},
    }),
  source: ({ emit, parsedRaw, san }) =>
    emit("source", {
      source: san(compactRecord({ ...parsedRaw, type: undefined })) ?? {},
    }),
  file: ({ emit, parsedRaw, san }) => emit("file", { file: san(parsedRaw.file) ?? null }),
  raw: ({ emit, parsedRaw, san }) =>
    emit("raw", {
      raw: san("rawValue" in parsedRaw ? parsedRaw.rawValue : parsedRaw.raw) ?? null,
    }),
};

function asString(value: unknown): string | undefined {
  const parsed = stringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function asIdString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
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

function truncateString(value: string, limits: SanitizeLimits): string {
  if (value.length <= limits.maxStringLength) return value;
  return `${value.slice(0, limits.maxStringLength)}...[truncated ${value.length - limits.maxStringLength} chars]`;
}

function sanitizeUnknown(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
  limits: SanitizeLimits = DEFAULT_SANITIZE_LIMITS
): unknown {
  if (value === null) return null;

  const t = typeof value;
  if (t === "string") return truncateString(value as string, limits);
  if (t === "boolean") return value;
  if (t === "number") return Number.isFinite(value as number) ? value : String(value);
  if (t === "bigint") return value.toString();
  if (t === "undefined") return undefined;
  if (t === "symbol" || t === "function") return String(value);

  if (depth >= limits.maxDepth) return "[max_depth]";

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : String(value);
  }

  if (value instanceof Error) {
    return compactRecord({
      name: value.name,
      message: value.message,
      stack: typeof value.stack === "string" ? truncateString(value.stack, limits) : undefined,
    });
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const take = Math.min(value.length, limits.maxArrayItems);
    for (let i = 0; i < take; i++) out.push(sanitizeUnknown(value[i], depth + 1, seen, limits));
    if (value.length > limits.maxArrayItems) out.push(`[truncated ${value.length - limits.maxArrayItems} items]`);
    return out;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    try {
      const entries = Object.entries(obj);
      const out: Record<string, unknown> = {};
      const take = Math.min(entries.length, limits.maxObjectKeys);
      for (let i = 0; i < take; i++) {
        const [k, v] = entries[i]!;
        const sanitized = sanitizeUnknown(v, depth + 1, seen, limits);
        if (sanitized !== undefined) out[k] = sanitized;
      }
      if (entries.length > limits.maxObjectKeys) {
        out.__truncatedKeys = entries.length - limits.maxObjectKeys;
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  }

  return String(value);
}

export function reasoningModeForProvider(provider: ProviderName): ModelStreamReasoningMode {
  return provider === "openai" || provider === "codex-cli" ? "summary" : "reasoning";
}

export function normalizeModelStreamPart(
  raw: unknown,
  opts: NormalizeModelStreamPartOptions
): NormalizedModelStreamPart {
  const includeRawPart = opts.includeRawPart ?? false;
  const sanitizeLimits = opts.rawPartMode === "full" ? FULL_SANITIZE_LIMITS : DEFAULT_SANITIZE_LIMITS;
  const san = (value: unknown) => sanitizeUnknown(value, 0, new WeakSet<object>(), sanitizeLimits);
  const rawPart = san(raw);
  const mode = reasoningModeForProvider(opts.provider);
  const fallbackId = (kind: string) => `anon:${opts.fallbackIdSeed ?? "unseeded"}:${kind}`;

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
  const providerMetadata = san(parsedRaw.providerMetadata);

  // Shorthand extractors used across multiple branches.
  const id = () => asIdString(parsedRaw.id) ?? fallbackId("id");
  const toolCallId = () => asIdString(parsedRaw.toolCallId) ?? asIdString(parsedRaw.id) ?? fallbackId("tool");
  const toolName = () => asString(parsedRaw.toolName) ?? "tool";
  const normalizer = streamPartNormalizers[type];
  if (normalizer) {
    return normalizer({
      emit,
      parsedRaw,
      providerMetadata,
      mode,
      id,
      toolCallId,
      toolName,
      fallbackId,
      san,
    });
  }

  return emit("unknown", { sdkType: type, raw: rawPart });
}
