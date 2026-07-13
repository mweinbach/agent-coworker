import type { AttributeValue } from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import { z } from "zod";

import { isNetworkTelemetryGloballyDisabled } from "../telemetry/config";
import type { AgentConfig, ObservabilityHealth } from "../types";
import { nowIso } from "../utils/typeGuards";

export type TelemetrySettings = {
  isEnabled: boolean;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  functionId?: string;
  metadata?: Record<string, AttributeValue>;
};

type EnsureObservabilityRuntimeResult = {
  ready: boolean;
  health: ObservabilityHealth;
  healthChanged: boolean;
};

const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_RUNTIME_INITIALIZATION_TIMEOUT_MS = 3_000;
const WARN_ONCE_KEYS = new Set<string>();
const MAX_METADATA_STRING_LENGTH = 2048;
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

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

type ReadyRuntime = Extract<ResolvedRuntime, { kind: "ready" }>;
type RuntimeSdk = Pick<NodeSDK, "start" | "shutdown"> & {
  forceFlush?: () => Promise<void>;
};
type RuntimeSpanProcessor = {
  forceFlush: () => Promise<void> | void;
};
type RuntimeFactory = (
  resolved: ReadyRuntime,
) => Promise<{ sdk: RuntimeSdk; spanProcessor: RuntimeSpanProcessor }>;

type RuntimeState = {
  sdk: RuntimeSdk | null;
  spanProcessor: RuntimeSpanProcessor | null;
  initPromise: Promise<void> | null;
  signature: string | null;
  generation: number;
  health: ObservabilityHealth;
};

const state: RuntimeState = {
  sdk: null,
  spanProcessor: null,
  initPromise: null,
  signature: null,
  generation: 0,
  health: {
    status: "disabled",
    reason: "observability_disabled",
    updatedAt: new Date().toISOString(),
  },
};

async function createDefaultRuntime(
  resolved: ReadyRuntime,
): Promise<{ sdk: RuntimeSdk; spanProcessor: RuntimeSpanProcessor }> {
  const [{ LangfuseSpanProcessor }, { NodeSDK }] = await Promise.all([
    import("@langfuse/otel"),
    import("@opentelemetry/sdk-node"),
  ]);
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: resolved.publicKey,
    secretKey: resolved.secretKey,
    baseUrl: resolved.baseUrl,
    ...(resolved.tracingEnvironment ? { environment: resolved.tracingEnvironment } : {}),
    ...(resolved.release ? { release: resolved.release } : {}),
  });
  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  return { sdk, spanProcessor };
}

let runtimeFactory: RuntimeFactory = createDefaultRuntime;
let runtimeInitializationTimeoutMs = DEFAULT_RUNTIME_INITIALIZATION_TIMEOUT_MS;

export function formatErrorMessage(err: unknown): string {
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
  const parsed = nonEmptyTrimmedStringSchema.safeParse(value);
  return parsed.success ? parsed.data : "";
}

function resolveRuntime(config: AgentConfig): ResolvedRuntime {
  if (isNetworkTelemetryGloballyDisabled()) {
    return {
      kind: "disabled",
      reason: "network_telemetry_disabled",
      message: "Network telemetry is disabled by COWORK_DISABLE_NETWORK_TELEMETRY.",
    };
  }

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
    asNonEmptyString(observability.baseUrl) || normalizeBaseUrl(DEFAULT_LANGFUSE_BASE_URL),
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

function setHealth(next: Omit<ObservabilityHealth, "updatedAt">): {
  changed: boolean;
  health: ObservabilityHealth;
} {
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
      `[observability] ${state.health.message ?? state.health.reason}`,
    );
  }

  return { changed: true, health: state.health };
}

async function shutdownRuntime(): Promise<void> {
  const sdk = state.sdk;
  state.generation += 1;
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

async function shutdownSdkBestEffort(sdk: RuntimeSdk): Promise<void> {
  try {
    await sdk.shutdown();
  } catch {
    // best-effort cleanup for failed or superseded initialization attempts
  }
}

async function waitForInitialization(
  initPromise: Promise<void>,
  timeoutMs: number,
): Promise<"completed" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([initPromise.then(() => "completed" as const), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

async function waitForRuntimeInitialization(
  resolved: ReadyRuntime,
  initPromise: Promise<void>,
  healthChangeOwner: boolean,
): Promise<EnsureObservabilityRuntimeResult> {
  const timeoutMs = runtimeInitializationTimeoutMs;
  const waitResult = await waitForInitialization(initPromise, timeoutMs);
  if (
    waitResult === "timeout" &&
    state.initPromise === initPromise &&
    state.signature === resolved.signature
  ) {
    const update = setHealth({
      status: "degraded",
      reason: "runtime_init_timeout",
      message: `Langfuse runtime initialization exceeded ${timeoutMs}ms; it will continue in the background.`,
    });
    return {
      ready: false,
      health: update.health,
      // A joiner may win the timer race and apply the shared health state first,
      // but only the call that created this initialization attempt owns the
      // outward health-change notification.
      healthChanged: healthChangeOwner,
    };
  }

  const attemptStillCurrent = state.signature === resolved.signature;
  const health = state.health;
  return {
    ready: attemptStillCurrent && state.sdk !== null && health.status === "ready",
    health,
    healthChanged:
      healthChangeOwner && attemptStillCurrent && health.reason === "runtime_initialized",
  };
}

function applyResolutionHealth(
  resolved: ResolvedRuntime,
  fallbackReadyReason = "configured",
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
  config: AgentConfig,
): Promise<EnsureObservabilityRuntimeResult> {
  const resolved = resolveRuntime(config);

  if (resolved.kind !== "ready") {
    if (state.sdk || state.initPromise) {
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
    if (state.health.status === "degraded" && state.health.reason === "runtime_init_timeout") {
      return { ready: false, health: state.health, healthChanged: false };
    }
    return await waitForRuntimeInitialization(resolved, state.initPromise, false);
  }

  if (state.sdk && state.signature !== resolved.signature) {
    await shutdownRuntime();
  }

  state.signature = resolved.signature;
  const generation = state.generation + 1;
  state.generation = generation;
  const initPromise = (async () => {
    let sdk: RuntimeSdk | null = null;
    try {
      const components = await runtimeFactory(resolved);
      sdk = components.sdk;
      if (state.generation !== generation || state.signature !== resolved.signature) {
        await shutdownSdkBestEffort(sdk);
        return;
      }
      await Promise.resolve(sdk.start());
      if (state.generation !== generation || state.signature !== resolved.signature) {
        await shutdownSdkBestEffort(sdk);
        return;
      }
      state.sdk = sdk;
      state.spanProcessor = components.spanProcessor;
      setHealth({
        status: "ready",
        reason: "runtime_initialized",
      });
    } catch (err) {
      if (sdk) await shutdownSdkBestEffort(sdk);
      if (state.generation === generation && state.signature === resolved.signature) {
        state.sdk = null;
        state.spanProcessor = null;
        setHealth({
          status: "degraded",
          reason: "runtime_init_failed",
          message: formatErrorMessage(err),
        });
      }
    }
  })();

  state.initPromise = initPromise;
  void initPromise.finally(() => {
    if (state.initPromise === initPromise) {
      state.initPromise = null;
    }
  });
  return await waitForRuntimeInitialization(resolved, initPromise, true);
}

let ensureObservabilityRuntimeForTelemetry = ensureObservabilityRuntime;

export function noteObservabilityFailure(
  reason: string,
  message: string,
): { changed: boolean; health: ObservabilityHealth } {
  return setHealth({
    status: "degraded",
    reason,
    message,
  });
}

export function noteObservabilitySuccess(
  config: AgentConfig,
  reason = "runtime_ready",
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
  const sdkWithFlush = state.sdk as
    | (typeof state.sdk & { forceFlush?: () => Promise<void> })
    | null;
  if (sdkWithFlush && typeof sdkWithFlush.forceFlush === "function") {
    await sdkWithFlush.forceFlush();
    return;
  }
  if (state.spanProcessor) {
    await state.spanProcessor.forceFlush();
  }
}

export async function shutdownObservabilityRuntime(): Promise<void> {
  await shutdownRuntime();
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
  metadata: Record<string, string | number | boolean | null | undefined>,
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

export async function buildRuntimeTelemetrySettings(
  config: AgentConfig,
  context: TelemetryContext,
): Promise<TelemetrySettings | undefined> {
  const runtime = await ensureObservabilityRuntimeForTelemetry(config);
  if (!runtime.ready) return undefined;

  return {
    isEnabled: true,
    recordInputs: config.observability?.recordInputs === true,
    recordOutputs: config.observability?.recordOutputs === true,
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
    ensureObservabilityRuntimeForTelemetry = ensureObservabilityRuntime;
    runtimeFactory = createDefaultRuntime;
    runtimeInitializationTimeoutMs = DEFAULT_RUNTIME_INITIALIZATION_TIMEOUT_MS;
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
  setEnsureObservabilityRuntimeForTests(
    ensureRuntime: (config: AgentConfig) => Promise<EnsureObservabilityRuntimeResult>,
  ) {
    ensureObservabilityRuntimeForTelemetry = ensureRuntime;
  },
  setRuntimeFactoryForTests(factory: RuntimeFactory) {
    runtimeFactory = factory;
  },
  setRuntimeInitializationTimeoutForTests(timeoutMs: number) {
    runtimeInitializationTimeoutMs = Math.max(1, timeoutMs);
  },
  resolveRuntime,
} as const;
