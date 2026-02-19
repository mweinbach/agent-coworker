import { describe, expect, test } from "bun:test";
import path from "node:path";

import { createLocalObservabilityStack } from "../src/observability/runtime";

describe("createLocalObservabilityStack", () => {
  const repoDir = "/tmp/fake-repo";
  const findAvailablePortImpl = async (start: number) => start;
  const makeStack = (opts: { runId: string; composeFile?: string }) =>
    createLocalObservabilityStack({
      repoDir,
      runId: opts.runId,
      composeFile: opts.composeFile,
      findAvailablePortImpl,
    });

  test("returns a stack with the correct projectName format (sanitized from runId)", async () => {
    const stack = await makeStack({ runId: "abc123" });
    expect(stack.projectName).toBe("cowork-obs-abc123");
  });

  test("project name handles special characters in runId", async () => {
    const stack = await makeStack({ runId: "run/123" });
    // "run/123" → lowercase → "cowork-obs-run/123" → sanitize replaces / with - → "cowork-obs-run-123"
    expect(stack.projectName).toBe("cowork-obs-run-123");
  });

  test("project name handles empty runId", async () => {
    const stack = await makeStack({ runId: "" });
    // "" → "cowork-obs-" → sanitize strips trailing hyphens → "cowork-obs"
    expect(stack.projectName).toBe("cowork-obs");
  });

  test("composeFile defaults to config/observability/docker-compose.yml under repoDir", async () => {
    const stack = await makeStack({ runId: "test" });
    expect(stack.composeFile).toBe(
      path.join(repoDir, "config/observability/docker-compose.yml")
    );
  });

  test("custom composeFile is respected", async () => {
    const customPath = "/some/custom/docker-compose.yml";
    const stack = await makeStack({ runId: "test", composeFile: customPath });
    expect(stack.composeFile).toBe(customPath);
  });

  test("endpoints are constructed with correct port numbers", async () => {
    const stack = await makeStack({ runId: "test" });
    expect(stack.endpoints.otlpHttpEndpoint).toBe(
      `http://127.0.0.1:${stack.ports.vectorOtlpHttp}`
    );
    expect(stack.endpoints.logsBaseUrl).toBe(
      `http://127.0.0.1:${stack.ports.victoriaLogs}`
    );
    expect(stack.endpoints.metricsBaseUrl).toBe(
      `http://127.0.0.1:${stack.ports.victoriaMetrics}`
    );
    expect(stack.endpoints.tracesBaseUrl).toBe(
      `http://127.0.0.1:${stack.ports.victoriaTraces}`
    );
  });

  test("env contains all port environment variables as strings", async () => {
    const stack = await makeStack({ runId: "test" });
    expect(typeof stack.env.VECTOR_OTLP_HTTP_PORT).toBe("string");
    expect(typeof stack.env.VICTORIA_LOGS_PORT).toBe("string");
    expect(typeof stack.env.VICTORIA_METRICS_PORT).toBe("string");
    expect(typeof stack.env.VICTORIA_TRACES_PORT).toBe("string");

    // Env values should match the ports as strings
    expect(stack.env.VECTOR_OTLP_HTTP_PORT).toBe(String(stack.ports.vectorOtlpHttp));
    expect(stack.env.VICTORIA_LOGS_PORT).toBe(String(stack.ports.victoriaLogs));
    expect(stack.env.VICTORIA_METRICS_PORT).toBe(String(stack.ports.victoriaMetrics));
    expect(stack.env.VICTORIA_TRACES_PORT).toBe(String(stack.ports.victoriaTraces));
  });

  test("ports object contains all 4 port types", async () => {
    const stack = await makeStack({ runId: "test" });
    expect(stack.ports).toHaveProperty("vectorOtlpHttp");
    expect(stack.ports).toHaveProperty("victoriaLogs");
    expect(stack.ports).toHaveProperty("victoriaMetrics");
    expect(stack.ports).toHaveProperty("victoriaTraces");
  });

  test("each port is a valid number > 0", async () => {
    const stack = await makeStack({ runId: "test" });
    for (const [key, port] of Object.entries(stack.ports)) {
      expect(typeof port).toBe("number");
      expect(port).toBeGreaterThan(0);
    }
  });
});

describe("LocalObservabilityStack structure", () => {
  const repoDir = "/tmp/fake-repo";
  const findAvailablePortImpl = async (start: number) => start;
  const makeStack = (runId: string) =>
    createLocalObservabilityStack({
      repoDir,
      runId,
      findAvailablePortImpl,
    });

  test("endpoints.otlpHttpEndpoint matches port from ports.vectorOtlpHttp", async () => {
    const stack = await makeStack("struct-test");
    expect(stack.endpoints.otlpHttpEndpoint).toBe(
      `http://127.0.0.1:${stack.ports.vectorOtlpHttp}`
    );
  });

  test("endpoints.logsBaseUrl matches ports.victoriaLogs", async () => {
    const stack = await makeStack("struct-test");
    expect(stack.endpoints.logsBaseUrl).toBe(
      `http://127.0.0.1:${stack.ports.victoriaLogs}`
    );
  });

  test("endpoints.metricsBaseUrl matches ports.victoriaMetrics", async () => {
    const stack = await makeStack("struct-test");
    expect(stack.endpoints.metricsBaseUrl).toBe(
      `http://127.0.0.1:${stack.ports.victoriaMetrics}`
    );
  });

  test("endpoints.tracesBaseUrl matches ports.victoriaTraces", async () => {
    const stack = await makeStack("struct-test");
    expect(stack.endpoints.tracesBaseUrl).toBe(
      `http://127.0.0.1:${stack.ports.victoriaTraces}`
    );
  });
});
