import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { resolveObservabilityEndpoints } from "../apps/portal/lib/observability";

const ENV_KEYS = [
  "HARNESS_REPO_ROOT",
  "HARNESS_OBS_OTLP_HTTP",
  "HARNESS_OBS_LOGS_URL",
  "HARNESS_OBS_METRICS_URL",
  "HARNESS_OBS_TRACES_URL",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type EnvOverrides = Partial<Record<EnvKey, string | undefined>>;

async function withEnv(overrides: EnvOverrides, run: () => Promise<void>) {
  const prev = new Map<EnvKey, string | undefined>();
  for (const key of ENV_KEYS) prev.set(key, process.env[key]);
  for (const key of ENV_KEYS) {
    if (!(key in overrides)) continue;
    const value = overrides[key];
    if (typeof value === "string") process.env[key] = value;
    else delete process.env[key];
  }
  try {
    await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function makeRepoRoot(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "portal-observability-"));
  await fs.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "agent-coworker" }), "utf-8");
  return repoRoot;
}

describe("resolveObservabilityEndpoints", () => {
  test("applies partial HARNESS_OBS_* overrides on top of fallback resolution", async () => {
    const repoRoot = await makeRepoRoot();
    try {
      await withEnv(
        {
          HARNESS_REPO_ROOT: repoRoot,
          HARNESS_OBS_OTLP_HTTP: undefined,
          HARNESS_OBS_LOGS_URL: undefined,
          HARNESS_OBS_METRICS_URL: undefined,
          HARNESS_OBS_TRACES_URL: "http://override-traces:10428",
        },
        async () => {
          const endpoints = await resolveObservabilityEndpoints();
          expect(endpoints).toEqual({
            otlpHttpEndpoint: "http://127.0.0.1:14318",
            logsBaseUrl: "http://127.0.0.1:19428",
            metricsBaseUrl: "http://127.0.0.1:18428",
            tracesBaseUrl: "http://override-traces:10428",
          });
        }
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("returns complete HARNESS_OBS_* endpoint set when all env vars are provided", async () => {
    const repoRoot = await makeRepoRoot();
    try {
      await withEnv(
        {
          HARNESS_REPO_ROOT: repoRoot,
          HARNESS_OBS_OTLP_HTTP: "http://env-otlp:4318",
          HARNESS_OBS_LOGS_URL: "http://env-logs:9428",
          HARNESS_OBS_METRICS_URL: "http://env-metrics:8428",
          HARNESS_OBS_TRACES_URL: "http://env-traces:10428",
        },
        async () => {
          const endpoints = await resolveObservabilityEndpoints();
          expect(endpoints).toEqual({
            otlpHttpEndpoint: "http://env-otlp:4318",
            logsBaseUrl: "http://env-logs:9428",
            metricsBaseUrl: "http://env-metrics:8428",
            tracesBaseUrl: "http://env-traces:10428",
          });
        }
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
