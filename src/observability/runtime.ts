import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { AttributeValue } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { TelemetrySettings } from "ai";

import type { AgentConfig, ObservabilityConfig, ObservabilityHealth } from "../types";

const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
const WARN_ONCE_KEYS = new Set<string>();
const MAX_METADATA_STRING_LENGTH = 2048;

type ResolvedRuntime =
  | { kind: "disabled"; reason: string; message: string }
  | { kind: "degraded"; reason: string; message: string }
  | {
      kind: "ready";
      signature: string;
      baseUrl: string;
      publicKey: string;
      secretKey: string;
      tracingEnvironment?: string;
      release?: string;
    };

type RuntimeState = {
  sdk: NodeSDK | null;
  spanProcessor: LangfuseSpanProcessor | null;
  initPromise: Promise<void> | null;
  signature: string | null;
  health: ObservabilityHealth;
};

const state: RuntimeState = {
  sdk: null,
  spanProcessor: null,
  initPromise: null,
  signature: null,
  health: {
    status: "disabled",
    reason: "observability_disabled",
    updatedAt: new Date().toISOString(),
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function warnOnce(key: string, message: string): void {
  if (WARN_ONCE_KEYS.has(key)) return;
  WARN_ONCE_KEYS.add(key);
  console.warn(message);
}

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveRuntime(config: AgentConfig): ResolvedRuntime {
  if (!config.observabilityEnabled) {
    return {
      kind: "disabled",
      reason: "observability_disabled",
      message: "Langfuse observability is disabled.",
    };
  }

  const observability = config.observability;
  if (!observability) {
    return {
      kind: "degraded",
      reason: "missing_config",
      message: "Langfuse observability is enabled but no observability config is present.",
    };
  }

  const baseUrl = normalizeBaseUrl(
    asNonEmptyString(observability.baseUrl) || normalizeBaseUrl(DEFAULT_LANGFUSE_BASE_URL)
  );
  const publicKey = asNonEmptyString(observability.publicKey);
  const secretKey = asNonEmptyString(observability.secretKey);
  const tracingEnvironment = asNonEmptyString(observability.tracingEnvironment) || undefined;
  const release = asNonEmptyString(observability.release) || undefined;

  if (!baseUrl || !publicKey || !secretKey) {
    return {
      kind: "degraded",
      reason: "missing_credentials",
      message:
        "Langfuse observability is enabled but base URL and credentials are not fully configured.",
    };
  }

  return {
    kind: "ready",
    signature: [baseUrl, publicKey, secretKey, tracingEnvironment ?? "", release ?? ""].join("|"),
    baseUrl,
    publicKey,
    secretKey,
    tracingEnvironment,
    release,
  };
}

function setHealth(next: Omit<ObservabilityHealth, "updatedAt">): { changed: boolean; health: ObservabilityHealth } {
  const prev = state.health;
  const changed =
    prev.status !== next.status ||
    prev.reason !== next.reason ||
    (prev.message ?? "") !== (next.message ?? "");

  if (!changed) {
    return { changed: false, health: prev };
  }

  state.health = {
    ...next,
    updatedAt: nowIso(),
  };

  if (state.health.status === "degraded") {
    warnOnce(
      `observability-degraded:${state.health.reason}:${state.health.message ?? ""}`,
      `[observability] ${state.health.message ?? state.health.reason}`
    );
  }

  return { changed: true, health: state.health };
}

async function shutdownRuntime(): Promise<void> {
  const sdk = state.sdk;
  state.sdk = null;
  state.spanProcessor = null;
  state.initPromise = null;
  state.signature = null;

  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // best-effort shutdown
  }
}

function applyResolutionHealth(
  resolved: ResolvedRuntime,
  fallbackReadyReason = "configured"
): { changed: boolean; health: ObservabilityHealth } {
  if (resolved.kind === "disabled") {
    return setHealth({
      status: "disabled",
      reason: resolved.reason,
      message: resolved.message,
    });
  }

  if (resolved.kind === "degraded") {
    return setHealth({
      status: "degraded",
      reason: resolved.reason,
      message: resolved.message,
    });
  }

  if (state.signature === resolved.signature && state.health.status === "degraded") {
    return { changed: false, health: state.health };
  }

  return setHealth({
    status: "ready",
    reason: fallbackReadyReason,
  });
}

export function getObservabilityHealth(config: AgentConfig): ObservabilityHealth {
  const resolved = resolveRuntime(config);
  return applyResolutionHealth(resolved).health;
}

export async function ensureObservabilityRuntime(
  config: AgentConfig
): Promise<{ ready: boolean; health: ObservabilityHealth; healthChanged: boolean }> {
  const resolved = resolveRuntime(config);

  if (resolved.kind !== "ready") {
    if (state.sdk) {
      await shutdownRuntime();
    }
    const update = applyResolutionHealth(resolved);
    return { ready: false, health: update.health, healthChanged: update.changed };
  }

  if (state.signature === resolved.signature && state.sdk) {
    const update = setHealth({ status: "ready", reason: "runtime_ready" });
    return { ready: true, health: update.health, healthChanged: update.changed };
  }

  if (state.initPromise && state.signature === resolved.signature) {
    await state.initPromise;
    const health = getObservabilityHealth(config);
    return { ready: health.status === "ready", health, healthChanged: false };
  }

  if (state.sdk && state.signature !== resolved.signature) {
    await shutdownRuntime();
  }

  state.signature = resolved.signature;
  const initPromise = (async () => {
    try {
      const spanProcessor = new LangfuseSpanProcessor({
        publicKey: resolved.publicKey,
        secretKey: resolved.secretKey,
        baseUrl: resolved.baseUrl,
        ...(resolved.tracingEnvironment ? { environment: resolved.tracingEnvironment } : {}),
        ...(resolved.release ? { release: resolved.release } : {}),
      });

      const sdk = new NodeSDK({
        spanProcessors: [spanProcessor],
      });

      await Promise.resolve(sdk.start());
      state.sdk = sdk;
      state.spanProcessor = spanProcessor;
      setHealth({
        status: "ready",
        reason: "runtime_initialized",
      });
    } catch (err) {
      state.sdk = null;
      state.spanProcessor = null;
      setHealth({
        status: "degraded",
        reason: "runtime_init_failed",
        message: formatErrorMessage(err),
      });
    }
  })();

  state.initPromise = initPromise;
  await initPromise.finally(() => {
    if (state.initPromise === initPromise) {
      state.initPromise = null;
    }
  });

  const health = getObservabilityHealth(config);
  return {
    ready: health.status === "ready",
    health,
    healthChanged: health.reason === "runtime_initialized",
  };
}

export function noteObservabilityFailure(
  reason: string,
  message: string
): { changed: boolean; health: ObservabilityHealth } {
  return setHealth({
    status: "degraded",
    reason,
    message,
  });
}

export function noteObservabilitySuccess(
  config: AgentConfig,
  reason = "runtime_ready"
): { changed: boolean; health: ObservabilityHealth } {
  const resolved = resolveRuntime(config);
  if (resolved.kind !== "ready") {
    return applyResolutionHealth(resolved);
  }
  return setHealth({
    status: "ready",
    reason,
  });
}

export async function forceFlushObservabilityRuntime(): Promise<void> {
  if (state.sdk && typeof state.sdk.forceFlush === "function") {
    await state.sdk.forceFlush();
    return;
  }
  if (state.spanProcessor) {
    await state.spanProcessor.forceFlush();
  }
}

export interface TelemetryContext {
  functionId: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

function truncateString(value: string): string {
  if (value.length <= MAX_METADATA_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_METADATA_STRING_LENGTH - 1)}…`;
}

function sanitizeTelemetryMetadata(
  metadata: Record<string, string | number | boolean | null | undefined>
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key] = truncateString(value);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export async function buildAiSdkTelemetrySettings(
  config: AgentConfig,
  context: TelemetryContext
): Promise<TelemetrySettings | undefined> {
  const runtime = await ensureObservabilityRuntime(config);
  if (!runtime.ready) return undefined;

  return {
    isEnabled: true,
    recordInputs: true,
    recordOutputs: true,
    functionId: context.functionId,
    metadata: sanitizeTelemetryMetadata({
      provider: config.provider,
      model: config.model,
      ...(context.metadata ?? {}),
    }),
  };
}

export const __internal = {
  async resetForTests() {
    WARN_ONCE_KEYS.clear();
    await shutdownRuntime();
    state.health = {
      status: "disabled",
      reason: "observability_disabled",
      updatedAt: nowIso(),
    };
  },
  getStateSnapshot() {
    return {
      signature: state.signature,
      health: state.health,
      hasSdk: !!state.sdk,
      hasSpanProcessor: !!state.spanProcessor,
      initializing: !!state.initPromise,
    };
  },
  resolveRuntime,
} as const;

export type ObservabilityRuntimeConfig = Pick<
  ObservabilityConfig,
  "baseUrl" | "publicKey" | "secretKey" | "tracingEnvironment" | "release"
>;
