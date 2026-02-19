import { randomBytes } from "node:crypto";

import type { AgentConfig } from "../types";

export interface ObservabilityEvent {
  name: string;
  at: string;
  status?: "ok" | "error";
  durationMs?: number;
  attributes?: Record<string, string | number | boolean>;
}

const LANGFUSE_OTEL_TRACES_PATH = "/api/public/otel/v1/traces";

const WARN_ONCE_KEYS = new Set<string>();

const BLOCKED_ATTRIBUTE_SUBSTRINGS = [
  "prompt",
  "content",
  "body",
  "input",
  "output",
  "response",
  "message",
  "error",
  "query",
  "argument",
  "payload",
  "raw",
];

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "sessionId",
  "turnId",
  "runId",
  "taskId",
  "provider",
  "model",
  "tool",
  "toolName",
  "command",
  "commandName",
  "skillName",
  "methodId",
  "mode",
  "reasonCode",
  "scenario",
  "status",
  "objectiveLength",
  "providers",
  "checks",
  "passed",
  "limit",
  "attempt",
  "maxAttempts",
]);

function warnOnce(key: string, message: string): void {
  if (WARN_ONCE_KEYS.has(key)) return;
  WARN_ONCE_KEYS.add(key);
  console.warn(message);
}

function toAnyValue(v: string | number | boolean): Record<string, unknown> {
  if (typeof v === "number") return { doubleValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: v };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function computeSpanWindow(atIso: string, durationMs: number | undefined): { startNs: string; endNs: string } {
  const parsedMs = Date.parse(atIso);
  const endMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();
  const spanDurationMs = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 1;
  const startMs = Math.max(0, endMs - spanDurationMs);
  return {
    startNs: String(BigInt(Math.floor(startMs)) * 1_000_000n),
    endNs: String(BigInt(Math.floor(endMs)) * 1_000_000n),
  };
}

function normalizeUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

function resolveLangfuseTraceIngestUrl(baseUrl: string): string {
  return `${normalizeUrl(baseUrl)}${LANGFUSE_OTEL_TRACES_PATH}`;
}

function shouldIncludeAttribute(key: string, value: string | number | boolean): boolean {
  if (typeof value === "string" && value.length > 512) return false;

  if (ALLOWED_ATTRIBUTE_KEYS.has(key)) return true;
  if (key.endsWith("Id")) return true;

  const lowered = key.toLowerCase();
  return !BLOCKED_ATTRIBUTE_SUBSTRINGS.some((token) => lowered.includes(token));
}

function sanitizeAttributes(attributes: Record<string, string | number | boolean> | undefined): Array<{ key: string; value: Record<string, unknown> }> {
  if (!attributes) return [];
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (!shouldIncludeAttribute(key, value)) continue;
    out.push({ key, value: toAnyValue(value) });
  }
  return out;
}

function resolveLangfuseConfig(
  config: AgentConfig
):
  | {
      baseUrl: string;
      publicKey: string;
      secretKey: string;
      tracingEnvironment?: string;
      release?: string;
    }
  | null {
  if (!config.observabilityEnabled) return null;

  const obs = config.observability;
  if (!obs) {
    warnOnce(
      "langfuse-missing-config",
      "[observability] Langfuse telemetry is enabled but no observability config is present. Continuing without telemetry export."
    );
    return null;
  }

  const baseUrl = obs.baseUrl.trim();
  const publicKey = obs.publicKey?.trim() ?? "";
  const secretKey = obs.secretKey?.trim() ?? "";

  if (!baseUrl || !publicKey || !secretKey) {
    warnOnce(
      "langfuse-missing-credentials",
      "[observability] Langfuse telemetry is enabled but LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY (and base URL) are not fully configured. Continuing without telemetry export."
    );
    return null;
  }

  return {
    baseUrl,
    publicKey,
    secretKey,
    tracingEnvironment: obs.tracingEnvironment,
    release: obs.release,
  };
}

export async function emitObservabilityEvent(
  config: AgentConfig,
  event: ObservabilityEvent,
  deps?: { fetchImpl?: typeof fetch }
): Promise<void> {
  const langfuse = resolveLangfuseConfig(config);
  if (!langfuse) return;

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const attributes = sanitizeAttributes(event.attributes);
  const { startNs, endNs } = computeSpanWindow(event.at, event.durationMs);
  const traceId = randomHex(16);
  const spanId = randomHex(8);

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "agent-coworker" } },
            { key: "service.version", value: { stringValue: langfuse.release ?? "0.1.0" } },
            ...(langfuse.tracingEnvironment
              ? [{ key: "deployment.environment", value: { stringValue: langfuse.tracingEnvironment } }]
              : []),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "agent-coworker" },
            spans: [
              {
                traceId,
                spanId,
                name: event.name,
                kind: 1,
                startTimeUnixNano: startNs,
                endTimeUnixNano: endNs,
                attributes: [
                  ...attributes,
                  { key: "event.at", value: { stringValue: event.at } },
                  ...(event.durationMs !== undefined
                    ? [{ key: "duration.ms", value: { doubleValue: event.durationMs } }]
                    : []),
                ],
                status: {
                  code: event.status === "error" ? 2 : 1,
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const ingestUrl = resolveLangfuseTraceIngestUrl(langfuse.baseUrl);
  const auth = Buffer.from(`${langfuse.publicKey}:${langfuse.secretKey}`).toString("base64");

  try {
    const res = await fetchImpl(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
    });

    // Drain body to avoid leaked sockets and keep exports best-effort.
    await res.arrayBuffer().catch(() => {});
  } catch {
    // best-effort export; failures should not affect core runtime
  }
}
