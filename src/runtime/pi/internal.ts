import {
  markModelCallSpanError,
  markModelCallSpanSuccessFromAssistantRecord as markModelCallSpanSuccess,
  parseTelemetrySettings,
  startPiModelCallSpan as startModelCallSpan,
} from "../../observability/modelCallSpan";
import { asFiniteNumber, asNonEmptyString, asRecord, toPiJsonSchema } from "../piRuntimeOptions";
import {
  preparePiModelForStream,
  resolvePiModel,
  stripPlaceholderCostFromAssistantRecord,
} from "./modelResolution";
import { normalizeNvidiaChatCompletionsBody } from "./nvidiaFetchPatch";
import {
  buildInitialStepMessages,
  buildStepState,
  isAbortLikeError,
  matchingProviderState,
  messagesAfterLastAssistant,
  nextProviderState,
  splitStepOverrides,
} from "./stepState";
import {
  emitPiEventAsRawPart,
  executeToolCall,
  extractToolExecutionErrorMessage,
  toolMapToPiTools,
} from "./tools";

function redactTelemetrySecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactTelemetrySecrets(entry, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    const sensitive =
      normalized.includes("api_key") ||
      normalized.includes("apikey") ||
      normalized.includes("authorization") ||
      normalized.includes("access_token") ||
      normalized.includes("refresh_token") ||
      normalized.includes("id_token") ||
      normalized === "token";
    out[key] = sensitive ? "[REDACTED]" : redactTelemetrySecrets(raw, seen);
  }
  return out;
}

export const __internal = {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  buildStepState,
  redactTelemetrySecrets,
  splitStepOverrides,
  emitPiEventAsRawPart,
  extractToolExecutionErrorMessage,
  executeToolCall,
  isAbortLikeError,
  markModelCallSpanError,
  markModelCallSpanSuccess,
  messagesAfterLastAssistant,
  matchingProviderState,
  buildInitialStepMessages,
  nextProviderState,
  normalizeNvidiaChatCompletionsBody,
  parseTelemetrySettings,
  resolvePiModel,
  startModelCallSpan,
  toolMapToPiTools,
  toPiJsonSchema,
} as const;
