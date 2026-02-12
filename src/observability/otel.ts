import { randomBytes } from "node:crypto";

import type { AgentConfig } from "../types";

export interface ObservabilityEvent {
  name: string;
  at: string;
  status?: "ok" | "error";
  durationMs?: number;
  attributes?: Record<string, string | number | boolean>;
}

const OTLP_HTTP_TRACES_PATH = "/v1/traces";
const LEGACY_VICTORIA_TRACES_PATH = "/insert/opentelemetry/v1/traces";

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

function resolveTraceIngestUrl(config: AgentConfig): string | null {
  if (!config.observability) return null;
  const otlpEndpoint = config.observability.otlpHttpEndpoint?.trim();
  if (!otlpEndpoint) {
    return `${normalizeUrl(config.observability.queryApi.tracesBaseUrl)}${LEGACY_VICTORIA_TRACES_PATH}`;
  }

  try {
    const parsed = new URL(otlpEndpoint);
    const normalizedPath = normalizeUrl(parsed.pathname);
    if (
      normalizedPath.endsWith(OTLP_HTTP_TRACES_PATH) ||
      normalizedPath.endsWith(LEGACY_VICTORIA_TRACES_PATH)
    ) {
      return normalizeUrl(parsed.toString());
    }

    parsed.pathname = `${normalizedPath}${OTLP_HTTP_TRACES_PATH}`;
    return parsed.toString();
  } catch {
    const normalizedEndpoint = normalizeUrl(otlpEndpoint);
    if (
      normalizedEndpoint.endsWith(OTLP_HTTP_TRACES_PATH) ||
      normalizedEndpoint.endsWith(LEGACY_VICTORIA_TRACES_PATH)
    ) {
      return normalizedEndpoint;
    }
    return `${normalizedEndpoint}${OTLP_HTTP_TRACES_PATH}`;
  }
}

export async function emitObservabilityEvent(
  config: AgentConfig,
  event: ObservabilityEvent,
  deps?: { fetchImpl?: typeof fetch }
): Promise<void> {
  if (!config.observabilityEnabled || !config.observability) return;

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const attributes = Object.entries(event.attributes ?? {}).map(([key, value]) => ({
    key,
    value: toAnyValue(value),
  }));
  const { startNs, endNs } = computeSpanWindow(event.at, event.durationMs);
  const traceId = randomHex(16);
  const spanId = randomHex(8);

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "agent-coworker" } },
            { key: "service.version", value: { stringValue: "0.1.0" } },
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
  const tracesInsertUrl = resolveTraceIngestUrl(config);
  if (!tracesInsertUrl) return;

  try {
    const res = await fetchImpl(tracesInsertUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // Drain the response body to allow socket reuse and prevent connection pool exhaustion.
    await res.arrayBuffer().catch(() => {});
  } catch {
    // best-effort export; failures should not affect core runtime
  }
}
