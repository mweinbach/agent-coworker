import { type AttributeValue, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

import { redactCredentialFields } from "../diagnostics/credentials";
import { redactDiagnosticText } from "../diagnostics/redaction";
import { redactCredentialText } from "../diagnostics/sensitiveText";
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

export function parseTelemetrySettings(raw: unknown): TelemetrySettings | undefined {
  const parsed = asRecord(raw);
  if (parsed?.isEnabled !== true) return undefined;

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

type ModelCallSpanContext = {
  runtimeLabel: string;
  provider: string;
  modelId: string;
  stepNumber: number;
};

function startModelCallSpan(
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
          redactCredentialFields(structured.options),
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

function safeErrorMetadata(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value) &&
    redactCredentialText(value) === value
  ) {
    return value;
  }
  return undefined;
}

export function markModelCallSpanError(
  span: Span | null,
  error: unknown,
  telemetry?: TelemetrySettings,
): void {
  if (!span) return;
  const details = asRecord(error);
  const safeName = safeErrorMetadata(details?.name);
  const name = typeof safeName === "string" ? safeName : "Error";
  const code = safeErrorMetadata(details?.code);
  // Provider errors can contain both the request and response. Partial payload
  // consent is insufficient, and exception objects must never bypass redaction.
  const allowPayload =
    telemetry?.isEnabled === true &&
    telemetry.recordInputs === true &&
    telemetry.recordOutputs === true;
  const message = allowPayload
    ? redactDiagnosticText(asString(details?.message) ?? String(error))
    : undefined;
  const stack =
    allowPayload && typeof details?.stack === "string"
      ? redactDiagnosticText(details.stack)
      : undefined;

  span.setAttribute("error.type", name);
  if (code !== undefined) span.setAttribute("error.code", code);
  span.setStatus({ code: SpanStatusCode.ERROR, ...(message !== undefined ? { message } : {}) });
  span.recordException({
    name,
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(stack !== undefined ? { stack } : {}),
  });
  span.end();
}
