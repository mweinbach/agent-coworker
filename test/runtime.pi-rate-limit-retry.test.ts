import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunTurn, type RunTurnParams } from "../src/agent";
import {
  isRateLimitError,
  isVisibleAssistantStreamPart,
  RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS,
  RATE_LIMIT_RETRY_MAX_DELAY_MS,
  rateLimitBackoffDelayMs,
  resolveRateLimitMaxAttempts,
  sleepWithAbort,
} from "../src/runtime/pi/rateLimitRetry";
import { createPiRuntime } from "../src/runtime/piRuntime";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../src/types";

const NVIDIA_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b";
const RATE_LIMIT_MESSAGE = "ResourceExhausted: Worker local total request limit reached (43/32)";

function makeConfig(homeDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "nvidia",
    model: NVIDIA_MODEL_ID,
    preferredChildModel: NVIDIA_MODEL_ID,
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(homeDir, ".agent-project"),
    userCoworkDir: path.join(homeDir, ".cowork"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [path.join(homeDir, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    observabilityEnabled: false,
    ...overrides,
  };
}

function makeParams(
  config: AgentConfig,
  overrides: Partial<RuntimeRunTurnParams> = {},
): RuntimeRunTurnParams {
  return {
    config,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }] as ModelMessage[],
    tools: {},
    maxSteps: 1,
    ...overrides,
  };
}

type FakeStream = {
  events: unknown[];
  result: () => Promise<Record<string, unknown>> | Record<string, unknown>;
};

function fakeStream({ events, result }: FakeStream) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return await result();
    },
  };
}

function rateLimitErrorEvent() {
  return { type: "error", reason: "error", error: { errorMessage: RATE_LIMIT_MESSAGE } };
}

function rateLimitAssistantRecord() {
  return {
    role: "assistant",
    content: [],
    usage: { input: 0, output: 0, totalTokens: 0 },
    stopReason: "error",
    errorMessage: RATE_LIMIT_MESSAGE,
  };
}

function okAssistantRecord(text = "done") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1, totalTokens: 2 },
    stopReason: "stop",
  };
}

type RetryHarness = {
  runtime: ReturnType<typeof createPiRuntime>;
  streamCount: () => number;
  sleeps: number[];
  emitted: Array<Record<string, unknown>>;
  logs: string[];
};

function createRetryHarness(streamForAttempt: (attempt: number) => FakeStream): RetryHarness {
  let streamCount = 0;
  const sleeps: number[] = [];
  const emitted: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const runtime = createPiRuntime({
    piStreamImpl: (() => {
      streamCount += 1;
      return fakeStream(streamForAttempt(streamCount));
    }) as never,
    retrySleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { runtime, streamCount: () => streamCount, sleeps, emitted, logs };
}

function harnessParams(config: AgentConfig, harness: RetryHarness): RuntimeRunTurnParams {
  return makeParams(config, {
    onModelStreamPart: (part) => {
      harness.emitted.push(part as Record<string, unknown>);
    },
    log: (line) => {
      harness.logs.push(line);
    },
  });
}

describe("isRateLimitError", () => {
  test("matches the NVIDIA gateway ResourceExhausted concurrency-limit message", () => {
    expect(isRateLimitError(new Error(RATE_LIMIT_MESSAGE))).toBe(true);
  });

  test("matches HTTP 429 status in AI SDK and fetch-style error shapes", () => {
    expect(isRateLimitError({ statusCode: 429, message: "API call failed" })).toBe(true);
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(isRateLimitError(new Error("429"))).toBe(true);
  });

  test("matches rate-limit phrases case-insensitively", () => {
    expect(isRateLimitError(new Error("Rate limit exceeded for model"))).toBe(true);
    expect(isRateLimitError(new Error("error code: rate_limit_exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("user request limit reached"))).toBe(true);
    expect(isRateLimitError("RESOURCE_EXHAUSTED: quota")).toBe(true);
  });

  test("matches provider error payloads carried in responseBody", () => {
    expect(
      isRateLimitError({
        message: "API call failed",
        responseBody: '{"error":{"message":"ResourceExhausted: request limit reached"}}',
      }),
    ).toBe(true);
  });

  test("walks cause and AI SDK RetryError lastError chains", () => {
    expect(isRateLimitError(new Error("retry failed", { cause: { statusCode: 429 } }))).toBe(true);
    expect(
      isRateLimitError({ name: "AI_RetryError", lastError: new Error(RATE_LIMIT_MESSAGE) }),
    ).toBe(true);
    expect(isRateLimitError(new Error("retry failed", { cause: new Error("boom") }))).toBe(false);
  });

  test("rejects non-rate-limit and abort-shaped errors", () => {
    expect(isRateLimitError(new Error("provider exploded"))).toBe(false);
    expect(isRateLimitError(new Error("Model turn aborted."))).toBe(false);
    expect(isRateLimitError(new DOMException("The operation was aborted.", "AbortError"))).toBe(
      false,
    );
    expect(isRateLimitError({ statusCode: 500, message: "internal" })).toBe(false);
    expect(isRateLimitError({ statusCode: 429001 })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError(42)).toBe(false);
  });
});

describe("rateLimitBackoffDelayMs", () => {
  test("doubles the base delay per retry within jitter bounds", () => {
    expect(rateLimitBackoffDelayMs(1, () => 0)).toBe(1000);
    expect(rateLimitBackoffDelayMs(1, () => 0.999)).toBeLessThan(2000);
    expect(rateLimitBackoffDelayMs(2, () => 0)).toBe(2000);
    expect(rateLimitBackoffDelayMs(2, () => 0.999)).toBeLessThan(4000);
    expect(rateLimitBackoffDelayMs(3, () => 0)).toBe(4000);
    expect(rateLimitBackoffDelayMs(3, () => 0.999)).toBeLessThan(8000);
  });

  test("caps the delay at the max", () => {
    const delay = rateLimitBackoffDelayMs(12, () => 0.999);
    expect(delay).toBeLessThanOrEqual(RATE_LIMIT_RETRY_MAX_DELAY_MS);
    expect(delay).toBeGreaterThanOrEqual(RATE_LIMIT_RETRY_MAX_DELAY_MS / 2);
  });
});

describe("resolveRateLimitMaxAttempts", () => {
  test("defaults to the bounded budget", () => {
    expect(resolveRateLimitMaxAttempts(makeConfig("/tmp/x"))).toBe(
      RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS,
    );
  });

  test("honors modelSettings.maxRetries as the retry budget", () => {
    expect(
      resolveRateLimitMaxAttempts(makeConfig("/tmp/x", { modelSettings: { maxRetries: 0 } })),
    ).toBe(1);
    expect(
      resolveRateLimitMaxAttempts(makeConfig("/tmp/x", { modelSettings: { maxRetries: 2 } })),
    ).toBe(3);
  });

  test("clamps excessive retry budgets to the bounded maximum", () => {
    expect(
      resolveRateLimitMaxAttempts(makeConfig("/tmp/x", { modelSettings: { maxRetries: 25 } })),
    ).toBe(RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS);
  });
});

describe("sleepWithAbort", () => {
  test("resolves after the delay", async () => {
    await sleepWithAbort(5);
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(60_000, controller.signal)).rejects.toThrow("Model turn aborted.");
  });

  test("rejects as soon as the signal fires mid-sleep", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 10);
    await expect(sleepWithAbort(60_000, controller.signal)).rejects.toThrow("Model turn aborted.");
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

describe("isVisibleAssistantStreamPart", () => {
  test("flags assistant content and tool-call parts", () => {
    for (const type of [
      "text-start",
      "text-delta",
      "text-end",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
    ]) {
      expect(isVisibleAssistantStreamPart({ type })).toBe(true);
    }
  });

  test("ignores lifecycle, error, and malformed parts", () => {
    for (const part of [
      { type: "start" },
      { type: "finish" },
      { type: "error", error: "x" },
      { type: "unknown" },
      "text-delta",
      null,
      {},
    ]) {
      expect(isVisibleAssistantStreamPart(part)).toBe(false);
    }
  });
});

describe("pi runtime rate-limit retry", () => {
  test("retries rate-limited model calls and completes the turn without phantom error chunks", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rate-limit-retry-"));
    const harness = createRetryHarness((attempt) =>
      attempt < 3
        ? { events: [rateLimitErrorEvent()], result: rateLimitAssistantRecord }
        : { events: [], result: () => okAssistantRecord() },
    );

    const result = await harness.runtime.runTurn(harnessParams(makeConfig(homeDir), harness));

    expect(result.text).toBe("done");
    expect(harness.streamCount()).toBe(3);
    expect(harness.sleeps).toHaveLength(2);
    expect(harness.sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(harness.sleeps[0]).toBeLessThan(2000);
    expect(harness.sleeps[1]).toBeGreaterThanOrEqual(2000);
    expect(harness.sleeps[1]).toBeLessThan(4000);
    expect(harness.emitted.filter((part) => part.type === "error")).toHaveLength(0);
    expect(harness.logs.filter((line) => line.includes("rate-limited"))).toHaveLength(2);
  });

  test("retries thrown rate-limit errors from the stream", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rate-limit-thrown-"));
    const harness = createRetryHarness((attempt) =>
      attempt === 1
        ? {
            events: [],
            result: () => {
              throw Object.assign(new Error("Too Many Requests"), { statusCode: 429 });
            },
          }
        : { events: [], result: () => okAssistantRecord() },
    );

    const result = await harness.runtime.runTurn(harnessParams(makeConfig(homeDir), harness));

    expect(result.text).toBe("done");
    expect(harness.streamCount()).toBe(2);
    expect(harness.sleeps).toHaveLength(1);
  });

  test("does not retry non-rate-limit errors and emits the buffered error chunk", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-non-rate-limit-"));
    const harness = createRetryHarness(() => ({
      events: [{ type: "error", reason: "error", error: { errorMessage: "provider exploded" } }],
      result: () => ({
        role: "assistant",
        content: [],
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage: "provider exploded",
      }),
    }));

    await expect(
      harness.runtime.runTurn(harnessParams(makeConfig(homeDir), harness)),
    ).rejects.toThrow("provider exploded");

    expect(harness.streamCount()).toBe(1);
    expect(harness.sleeps).toHaveLength(0);
    expect(harness.emitted.filter((part) => part.type === "error")).toEqual([
      { type: "error", error: "provider exploded" },
    ]);
  });

  test("does not retry once assistant content has been emitted for the step", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rate-limit-content-"));
    const harness = createRetryHarness(() => ({
      events: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "partial answer" },
        rateLimitErrorEvent(),
      ],
      result: rateLimitAssistantRecord,
    }));

    await expect(
      harness.runtime.runTurn(harnessParams(makeConfig(homeDir), harness)),
    ).rejects.toThrow(RATE_LIMIT_MESSAGE);

    // No retry: the partial text was already visible, so restarting would
    // duplicate it. The buffered error chunk is emitted once the failure is
    // final.
    expect(harness.streamCount()).toBe(1);
    expect(harness.sleeps).toHaveLength(0);
    expect(
      harness.emitted.some((part) => part.type === "text-delta" && part.text === "partial answer"),
    ).toBe(true);
    expect(harness.emitted.filter((part) => part.type === "error")).toHaveLength(1);
  });

  test("gives up after the bounded attempts and surfaces the last error", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rate-limit-exhausted-"));
    const harness = createRetryHarness(() => ({
      events: [rateLimitErrorEvent()],
      result: rateLimitAssistantRecord,
    }));

    await expect(
      harness.runtime.runTurn(harnessParams(makeConfig(homeDir), harness)),
    ).rejects.toThrow(RATE_LIMIT_MESSAGE);

    expect(harness.streamCount()).toBe(RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS);
    expect(harness.sleeps).toHaveLength(RATE_LIMIT_RETRY_DEFAULT_MAX_ATTEMPTS - 1);
    // Only the final attempt's error chunk is emitted; retried attempts are dropped.
    expect(harness.emitted.filter((part) => part.type === "error")).toHaveLength(1);
  });

  test("modelSettings.maxRetries=0 disables the rate-limit retry", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rate-limit-disabled-"));
    const harness = createRetryHarness(() => ({
      events: [rateLimitErrorEvent()],
      result: rateLimitAssistantRecord,
    }));

    await expect(
      harness.runtime.runTurn(
        harnessParams(makeConfig(homeDir, { modelSettings: { maxRetries: 0 } }), harness),
      ),
    ).rejects.toThrow(RATE_LIMIT_MESSAGE);

    expect(harness.streamCount()).toBe(1);
    expect(harness.sleeps).toHaveLength(0);
  });

  test("a sleeping retry aborts cleanly when the turn is cancelled", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rate-limit-abort-"));
    const controller = new AbortController();
    const onModelAbort = mock(async () => {});
    const onModelError = mock(async () => {});
    const runtime = createPiRuntime({
      piStreamImpl: (() =>
        fakeStream({ events: [rateLimitErrorEvent()], result: rateLimitAssistantRecord })) as never,
      retrySleep: async () => {
        controller.abort();
        throw new Error("Model turn aborted.");
      },
    });

    await expect(
      runtime.runTurn(
        makeParams(makeConfig(homeDir), {
          abortSignal: controller.signal,
          onModelAbort,
          onModelError,
        }),
      ),
    ).rejects.toThrow("Model turn aborted.");

    expect(onModelAbort).toHaveBeenCalledTimes(1);
    expect(onModelError).not.toHaveBeenCalled();
  });

  test("createRunTurn forwards modelSettings.maxRetries to the pi runtime retry budget", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rate-limit-run-turn-"));
    const harness = createRetryHarness(() => ({
      events: [rateLimitErrorEvent()],
      result: rateLimitAssistantRecord,
    }));
    const runTurn = createRunTurn({
      createRuntime: () => harness.runtime,
      createTools: mock(() => ({})) as never,
      loadMCPServers: mock(async () => []) as never,
      loadMCPTools: mock(async () => ({ tools: {}, errors: [] })) as never,
    });

    const params: RunTurnParams = {
      config: makeConfig(homeDir, { modelSettings: { maxRetries: 1 } }),
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }] as ModelMessage[],
      toolEnv: { COWORK_DISABLE_RUNTIME: "1" },
      log: harness.logs.push.bind(harness.logs),
      askUser: async () => "yes",
      approveCommand: async () => true,
    };

    await expect(runTurn(params)).rejects.toThrow(RATE_LIMIT_MESSAGE);

    // 1 initial attempt + 1 configured retry.
    expect(harness.streamCount()).toBe(2);
    expect(harness.sleeps).toHaveLength(1);
  });
});
