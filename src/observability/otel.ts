import type { AttributeValue, Tracer } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

import type { AgentConfig, ObservabilityHealth } from "../types";

import {
  ensureObservabilityRuntime,
  forceFlushObservabilityRuntime,
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

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function isSecretLikeKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_ATTRIBUTE_TOKENS.some((token) => lowered.includes(token));
}

function truncateString(value: string): string {
  if (value.length <= MAX_ATTRIBUTE_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_ATTRIBUTE_STRING_LENGTH - 1)}…`;
}

function sanitizeAttributeValue(
  key: string,
  value: string | number | boolean
): AttributeValue | undefined {
  if (isSecretLikeKey(key)) return "[REDACTED]";

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
  attributes: Record<string, string | number | boolean> | undefined
): Record<string, AttributeValue> {
  if (!attributes) return {};

  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const sanitized = sanitizeAttributeValue(key, value);
    if (sanitized === undefined) continue;
    out[key] = sanitized;
  }
  return out;
}

function computeSpanWindow(atIso: string, durationMs: number | undefined): { startTime: Date; endTime: Date } {
  const parsedMs = Date.parse(atIso);
  const endMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();
  const spanDurationMs =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 1;
  const startMs = Math.max(0, endMs - spanDurationMs);
  return {
    startTime: new Date(startMs),
    endTime: new Date(endMs),
  };
}

function sameHealth(a: ObservabilityHealth, b: ObservabilityHealth): boolean {
  return (
    a.status === b.status &&
    a.reason === b.reason &&
    (a.message ?? "") === (b.message ?? "")
  );
}

export async function emitObservabilityEvent(
  config: AgentConfig,
  event: ObservabilityEvent,
  deps?: EmitObservabilityDeps
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
  const attributes = sanitizeAttributes(event.attributes);

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

    try {
      await runtime.forceFlush();
      runtime.noteSuccess(config, "runtime_flush_ok");
    } catch (flushErr) {
      runtime.noteFailure("runtime_flush_failed", formatErrorMessage(flushErr));
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
