#!/usr/bin/env bun

import path from "node:path";

import { loadConfig } from "../src/config";
import { runObservabilityQuery } from "../src/observability/query";
import { evaluateHarnessSlo } from "../src/observability/slo";
import {
  createLocalObservabilityStack,
  startLocalObservabilityStack,
  stopLocalObservabilityStack,
  type LocalObservabilityStack,
} from "../src/observability/runtime";
import type { AgentConfig, HarnessSloCheck } from "../src/types";

type SmokeArgs = {
  runId: string;
  keepStack: boolean;
};

function parseArgs(argv: string[]): SmokeArgs {
  let runId = `smoke-${Date.now()}`;
  let keepStack = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run-id") {
      const next = argv[i + 1];
      if (!next) throw new Error("Missing value for --run-id");
      runId = next;
      i += 1;
      continue;
    }
    if (arg === "--keep-stack") {
      keepStack = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun scripts/harness_smoke.ts [--run-id <id>] [--keep-stack]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { runId, keepStack };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyStackToConfig(baseConfig: AgentConfig, stack: LocalObservabilityStack): AgentConfig {
  return {
    ...baseConfig,
    observabilityEnabled: true,
    observability: {
      ...baseConfig.observability,
      mode: "local_docker",
      otlpHttpEndpoint: stack.endpoints.otlpHttpEndpoint,
      queryApi: {
        logsBaseUrl: stack.endpoints.logsBaseUrl,
        metricsBaseUrl: stack.endpoints.metricsBaseUrl,
        tracesBaseUrl: stack.endpoints.tracesBaseUrl,
      },
      defaultWindowSec: 60,
    },
    harness: {
      ...baseConfig.harness,
      reportOnly: true,
      strictMode: false,
    },
  };
}

async function waitForPromqlReady(config: AgentConfig, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = "unknown";

  while (Date.now() - startedAt < timeoutMs) {
    const result = await runObservabilityQuery(config, {
      queryType: "promql",
      query: "up",
      limit: 5,
    });
    if (result.status === "ok") return;
    lastError = result.error ?? "query returned error";
    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for observability stack readiness: ${lastError}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = process.cwd();
  const baseConfig = await loadConfig({ cwd: repoDir });
  const stack = await createLocalObservabilityStack({
    repoDir,
    runId: args.runId,
    composeFile: path.join(repoDir, "config/observability/docker-compose.yml"),
  });

  let started = false;

  try {
    console.log(`[harness:smoke] starting stack (${stack.projectName})`);
    await startLocalObservabilityStack(stack);
    started = true;

    const config = applyStackToConfig(baseConfig, stack);
    await waitForPromqlReady(config);

    const query = await runObservabilityQuery(config, {
      queryType: "promql",
      query: "1",
      limit: 1,
    });
    if (query.status !== "ok") {
      throw new Error(`PromQL smoke query failed: ${query.error ?? "unknown error"}`);
    }

    const checks: HarnessSloCheck[] = [
      {
        id: "smoke_constant_one",
        type: "custom",
        queryType: "promql",
        query: "1",
        op: "==",
        threshold: 1,
        windowSec: 60,
      },
    ];
    const slo = await evaluateHarnessSlo(config, checks);
    if (!slo.passed) {
      const firstFailure = slo.checks.find((check) => !check.pass);
      throw new Error(
        `SLO smoke check failed: ${firstFailure?.id ?? "unknown"} ${firstFailure?.reason ?? ""}`.trim()
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          runId: args.runId,
          stack: {
            projectName: stack.projectName,
            metricsBaseUrl: stack.endpoints.metricsBaseUrl,
          },
          queryStatus: query.status,
          sloPassed: slo.passed,
        },
        null,
        2
      )
    );
  } finally {
    if (started && !args.keepStack) {
      console.log(`[harness:smoke] stopping stack (${stack.projectName})`);
      await stopLocalObservabilityStack(stack);
    } else if (started) {
      console.log(`[harness:smoke] keeping stack up (${stack.projectName})`);
    }
  }
}

main().catch((err) => {
  console.error(`[harness:smoke] ${String(err)}`);
  process.exitCode = 1;
});
