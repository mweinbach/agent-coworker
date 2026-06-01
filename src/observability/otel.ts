import type { AttributeValue, Tracer } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

import type { AgentConfig, ObservabilityHealth } from "../types";

import {
  ensureObservabilityRuntime,
  forceFlushObservabilityRuntime,
  formatErrorMessage,
  getObservabilityHealth,
  noteObservabilityFailure,
  noteObservabilitySuccess,
} from "./runtime";

export interface ObservabilityEvent {
  name: string;
  at: string;
  status?: "ok" | "error";
  durationMs?: number;
  attributes?: Record<string, string | number | boolean>;
  forceFlush?: boolean;
}

export interface EmitObservabilityResult {
  emitted: boolean;
  healthChanged: boolean;
  health: ObservabilityHealth;
}

type RuntimeDeps = {
  ensure: typeof ensureObservabilityRuntime;
  getHealth: typeof getObservabilityHealth;
  noteFailure: typeof noteObservabilityFailure;
  noteSuccess: typeof noteObservabilitySuccess;
  forceFlush: typeof forceFlushObservabilityRuntime;
};

export interface EmitObservabilityDeps {
  tracer?: Tracer;
  runtime?: Partial<RuntimeDeps>;
}

const MAX_ATTRIBUTE_STRING_LENGTH = 2048;
const SECRET_ATTRIBUTE_TOKENS = [
  "api_key",
  "apikey",
  "secret",
  "token",
  "authorization",
  "cookie",
  "password",
  "privatekey",
  "secretkey",
];
const PAYLOAD_ATTRIBUTE_TOKENS = [
  "prompt",
  "input",
  "message",
  "response",
  "output",
  "completion",
  "command",
  "stdout",
  "stderr",
  "path",
  "filepath",
  "file_path",
  "filename",
  "file_name",
  "transcript",
  "uploaded",
  "log",
  "error",
];
const SAFE_METADATA_ATTRIBUTE_TOKENS = [
  "token",
  "tokens",
  "cost",
  "count",
  "duration",
  "latency",
  "attempt",
  "status",
  "provider",
  "model",
  "session",
  "turn",
  "run",
  "step",
  "id",
  "bytes",
  "size",
];

function isSecretLikeKey(key: string): boolean {
  const lowered = key.toLowerCase();
  const compact = lowered.replace(/[^a-z0-9]/g, "");
  if (
    compact.includes("token") &&
    !/(access|auth|api|bearer|cookie|password|private|refresh|secret|session)/.test(compact)
  ) {
    return false;
  }
  return SECRET_ATTRIBUTE_TOKENS.some((token) => lowered.includes(token));
}

function isPayloadLikeKey(key: string): boolean {
  const lowered = key.toLowerCase();
  const compact = lowered.replace(/[^a-z0-9]/g, "");
  return PAYLOAD_ATTRIBUTE_TOKENS.some((token) => {
    const compactToken = token.replace(/[^a-z0-9]/g, "");
    return lowered.includes(token) || compact.includes(compactToken);
  });
}

function isSafeMetadataKey(key: string): boolean {
  const lowered = key.toLowerCase();
  const compact = lowered.replace(/[^a-z0-9]/g, "");
  return SAFE_METADATA_ATTRIBUTE_TOKENS.some((token) => {
    const compactToken = token.replace(/[^a-z0-9]/g, "");
    return lowered.includes(token) || compact.includes(compactToken);
  });
}

function allowsPayloadAttributes(config: AgentConfig): boolean {
  return (
    config.observability?.recordInputs === true && config.observability?.recordOutputs === true
  );
}

function truncateString(value: string): string {
  if (value.length <= MAX_ATTRIBUTE_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH - 1)}…`;
}

function sanitizeAttributeValue(
  key: string,
  value: string | number | boolean,
  options: { allowPayloadAttributes: boolean },
): AttributeValue | undefined {
  if (isSecretLikeKey(key)) return "[REDACTED]";
  if (!options.allowPayloadAttributes && isPayloadLikeKey(key) && !isSafeMetadataKey(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return value;
  }

  return value;
}

function sanitizeAttributes(
  attributes: Record<string, string | number | boolean> | undefined,
  options: { allowPayloadAttributes: boolean },
): Record<string, AttributeValue> {
  if (!attributes) return {};

  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const sanitized = sanitizeAttributeValue(key, value, options);
    if (sanitized === undefined) continue;
    out[key] = sanitized;
  }
  return out;
}

function computeSpanWindow(
  atIso: string,
  durationMs: number | undefined,
): { startTime: Date; endTime: Date } {
  const parsedMs = Date.parse(atIso);
  const endMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();
  const spanDurationMs =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : 1;
  const startMs = Math.max(0, endMs - spanDurationMs);
  return {
    startTime: new Date(startMs),
    endTime: new Date(endMs),
  };
}

function sameHealth(a: ObservabilityHealth, b: ObservabilityHealth): boolean {
  return a.status === b.status && a.reason === b.reason && (a.message ?? "") === (b.message ?? "");
}

export async function emitObservabilityEvent(
  config: AgentConfig,
  event: ObservabilityEvent,
  deps?: EmitObservabilityDeps,
): Promise<EmitObservabilityResult> {
  const runtime: RuntimeDeps = {
    ensure: deps?.runtime?.ensure ?? ensureObservabilityRuntime,
    getHealth: deps?.runtime?.getHealth ?? getObservabilityHealth,
    noteFailure: deps?.runtime?.noteFailure ?? noteObservabilityFailure,
    noteSuccess: deps?.runtime?.noteSuccess ?? noteObservabilitySuccess,
    forceFlush: deps?.runtime?.forceFlush ?? forceFlushObservabilityRuntime,
  };

  const tracer = deps?.tracer ?? trace.getTracer("agent-coworker.observability");
  const before = runtime.getHealth(config);

  const runtimeState = await runtime.ensure(config);
  if (!runtimeState.ready) {
    const after = runtime.getHealth(config);
    return {
      emitted: false,
      healthChanged: runtimeState.healthChanged || !sameHealth(before, after),
      health: after,
    };
  }

  const { startTime, endTime } = computeSpanWindow(event.at, event.durationMs);
  const attributes = sanitizeAttributes(event.attributes, {
    allowPayloadAttributes: allowsPayloadAttributes(config),
  });

  let emitted = false;
  try {
    const span = tracer.startSpan(event.name, {
      startTime,
      attributes: {
        ...attributes,
        "event.at": truncateString(event.at),
        ...(event.durationMs !== undefined ? { "duration.ms": event.durationMs } : {}),
      },
    });

    if (event.status === "error") {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end(endTime);
    emitted = true;

    if (event.forceFlush) {
      try {
        await runtime.forceFlush();
        runtime.noteSuccess(config, "runtime_flush_ok");
      } catch (flushErr) {
        runtime.noteFailure("runtime_flush_failed", formatErrorMessage(flushErr));
      }
    }
  } catch (err) {
    runtime.noteFailure("span_emit_failed", formatErrorMessage(err));
  }

  const after = runtime.getHealth(config);
  return {
    emitted,
    healthChanged: runtimeState.healthChanged || !sameHealth(before, after),
    health: after,
  };
}
