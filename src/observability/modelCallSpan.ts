import { type AttributeValue, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

import type { TelemetrySettings } from "../observability/runtime";
import type { RuntimeRunTurnParams, RuntimeUsage } from "../runtime/types";
import { asFiniteNumber, asNonEmptyString, asRecord, asString } from "../shared/recordParsing";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactTelemetrySecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((entry) => redactTelemetrySecrets(entry, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const sensitive = /(?:api[_-]?key|token|secret|password|authorization)/i.test(key);
    out[key] = sensitive ? "[REDACTED]" : redactTelemetrySecrets(raw, seen);
  }
  return out;
}

export function parseTelemetrySettings(raw: unknown): TelemetrySettings | undefined {
  const parsed = asRecord(raw);
  if (!parsed || parsed.isEnabled !== true) return undefined;

  const metadataInput = asRecord(parsed.metadata);
  const metadata: Record<string, AttributeValue> = {};
  if (metadataInput) {
    for (const [key, value] of Object.entries(metadataInput)) {
      if (typeof value === "string" || typeof value === "boolean") {
        metadata[key] = value;
        continue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        metadata[key] = value;
      }
    }
  }

  return {
    isEnabled: true,
    recordInputs: parsed.recordInputs === true,
    recordOutputs: parsed.recordOutputs === true,
    functionId: asNonEmptyString(parsed.functionId),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export type ModelCallSpanContext = {
  runtimeLabel: string;
  provider: string;
  modelId: string;
  stepNumber: number;
};

export function startModelCallSpan(
  telemetry: TelemetrySettings | undefined,
  context: ModelCallSpanContext,
  input: unknown,
  defaultFunctionId: string,
): Span | null {
  if (!telemetry?.isEnabled) return null;

  const attributes: Record<string, AttributeValue> = {
    "llm.runtime": context.runtimeLabel,
    "llm.provider": context.provider,
    "llm.model": context.modelId,
    "llm.step_number": context.stepNumber,
    ...(telemetry.metadata ?? {}),
  };

  if (telemetry.recordInputs) {
    if (typeof input === "object" && input !== null && "system" in input) {
      const structured = input as { system?: string; messages?: unknown; options?: unknown };
      attributes["llm.input.system"] = structured.system ?? "";
      attributes["llm.input.messages"] = safeJsonStringify(structured.messages);
      if (structured.options !== undefined) {
        attributes["llm.input.options"] = safeJsonStringify(
          redactTelemetrySecrets(structured.options),
        );
      }
    } else {
      attributes["llm.input.messages"] = safeJsonStringify(input);
    }
  }

  return trace
    .getTracer("agent-coworker.runtime")
    .startSpan(telemetry.functionId ?? defaultFunctionId, { attributes });
}

export function startPiModelCallSpan(
  telemetry: TelemetrySettings | undefined,
  params: RuntimeRunTurnParams,
  modelId: string,
  stepNumber: number,
  stepOptions: Record<string, unknown>,
  piMessages: unknown,
  runtimeLabel = "pi",
  defaultFunctionId = "agent.runtime.pi.model_call",
): Span | null {
  return startModelCallSpan(
    telemetry,
    { runtimeLabel, provider: params.config.provider, modelId, stepNumber },
    { system: params.system, messages: piMessages, options: stepOptions },
    defaultFunctionId,
  );
}

export function startCodexModelCallSpan(
  telemetry: TelemetrySettings | undefined,
  params: RuntimeRunTurnParams,
  effectiveModel: string,
  stepNumber: number,
  input: unknown,
  runtimeLabel = "codex-app-server",
  defaultFunctionId = "agent.runtime.codex.model_call",
): Span | null {
  return startModelCallSpan(
    telemetry,
    { runtimeLabel, provider: params.config.provider, modelId: effectiveModel, stepNumber },
    input,
    defaultFunctionId,
  );
}

export function markModelCallSpanSuccessFromAssistantRecord(
  span: Span | null,
  telemetry: TelemetrySettings | undefined,
  assistantRecord: Record<string, unknown>,
): void {
  if (!span) return;

  if (telemetry?.recordOutputs) {
    span.setAttribute("llm.output.stop_reason", asString(assistantRecord.stopReason) ?? "unknown");
    span.setAttribute("llm.output.response", safeJsonStringify(assistantRecord));
  }

  const usage = asRecord(assistantRecord.usage);
  const input = asFiniteNumber(usage?.input);
  const output = asFiniteNumber(usage?.output);
  const total = asFiniteNumber(usage?.totalTokens);
  if (input !== undefined) span.setAttribute("llm.usage.input_tokens", input);
  if (output !== undefined) span.setAttribute("llm.usage.output_tokens", output);
  if (total !== undefined) span.setAttribute("llm.usage.total_tokens", total);

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export function markModelCallSpanSuccessFromTextAndUsage(
  span: Span | null,
  telemetry: TelemetrySettings | undefined,
  text: string,
  usage: RuntimeUsage | undefined,
): void {
  if (!span) return;

  if (telemetry?.recordOutputs) {
    span.setAttribute("llm.output.response", text);
  }

  if (usage) {
    if (usage.promptTokens !== undefined)
      span.setAttribute("llm.usage.input_tokens", usage.promptTokens);
    if (usage.cachedPromptTokens !== undefined)
      span.setAttribute("llm.usage.cached_input_tokens", usage.cachedPromptTokens);
    if (usage.cacheWritePromptTokens !== undefined)
      span.setAttribute("llm.usage.cache_write_input_tokens", usage.cacheWritePromptTokens);
    if (usage.completionTokens !== undefined)
      span.setAttribute("llm.usage.output_tokens", usage.completionTokens);
    if (usage.reasoningOutputTokens !== undefined)
      span.setAttribute("llm.usage.reasoning_output_tokens", usage.reasoningOutputTokens);
    if (usage.totalTokens !== undefined)
      span.setAttribute("llm.usage.total_tokens", usage.totalTokens);
  }

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export function markModelCallSpanError(span: Span | null, error: unknown): void {
  if (!span) return;
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  if (error instanceof Error) {
    span.recordException(error);
  }
  span.end();
}
