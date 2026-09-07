import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { scratchRoots } from "../src/platform/sandbox";
import { createPiRuntime } from "../src/runtime/pi/runTurn";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig } from "../src/types";

let homeDir: string;

beforeEach(async () => {
  const [tempRoot] = scratchRoots();
  if (!tempRoot) throw new Error("No platform scratch root is available");
  homeDir = await fs.mkdtemp(path.join(tempRoot, "pi-loop-"));
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
});

function makeParams(overrides: Partial<RuntimeRunTurnParams> = {}): RuntimeRunTurnParams {
  const config: AgentConfig = {
    provider: "opencode-go",
    model: "glm-5",
    preferredChildModel: "glm-5",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(homeDir, ".cowork"),
    userCoworkDir: path.join(homeDir, ".cowork"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  };
  return {
    config,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }],
    tools: {},
    maxSteps: 1,
    ...overrides,
  };
}

function fakeStream(result: Record<string, unknown>, events: unknown[] = []) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    async result() {
      return result;
    },
  };
}

const success = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  stopReason: "stop",
  usage: { input: 1, output: 1, totalTokens: 2 },
};

describe("PI model loop cancellation boundaries", () => {
  test("does not resolve a model for an already-cancelled turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const params = makeParams({ abortSignal: controller.signal });
    // This provider is deliberately rejected by PI resolution. Cancellation
    // must win before any resolution (which can load a local model) begins.
    params.config.provider = "codex-cli";
    const onModelAbort = mock(() => {});
    await expect(createPiRuntime().runTurn({ ...params, onModelAbort })).rejects.toThrow(
      "Model turn aborted.",
    );
    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });

  test("does not start inference after prepareStep cancels the turn", async () => {
    const controller = new AbortController();
    const piStreamImpl = mock(() => fakeStream(success));
    const onModelAbort = mock(() => {});
    const runtime = createPiRuntime({ piStreamImpl: piStreamImpl as never });

    await expect(
      runtime.runTurn(
        makeParams({
          abortSignal: controller.signal,
          onModelAbort,
          prepareStep: async () => {
            controller.abort();
          },
        }),
      ),
    ).rejects.toThrow("Model turn aborted.");
    expect(piStreamImpl).not.toHaveBeenCalled();
    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });

  test("rechecks cancellation between a completed backoff and the next request", async () => {
    const controller = new AbortController();
    const piStreamImpl = mock(() =>
      fakeStream({
        ...success,
        content: [],
        stopReason: "error",
        errorMessage: "Service unavailable (503)",
      }),
    );
    const retrySleep = mock(async () => {
      // The wait can resolve just before another task cancels the turn.
      controller.abort();
    });
    const onModelAbort = mock(() => {});
    const runtime = createPiRuntime({ piStreamImpl: piStreamImpl as never, retrySleep });

    await expect(
      runtime.runTurn(makeParams({ abortSignal: controller.signal, onModelAbort })),
    ).rejects.toThrow("Model turn aborted.");
    expect(piStreamImpl).toHaveBeenCalledTimes(1);
    expect(retrySleep).toHaveBeenCalledTimes(1);
    expect(onModelAbort).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, "Service unavailable (503)"])(
    "treats an SDK aborted stop reason as cancellation regardless of its message (%s)",
    async (errorMessage) => {
      const piStreamImpl = mock(() =>
        fakeStream({
          ...success,
          content: [{ type: "text", text: "partial answer" }],
          stopReason: "aborted",
          errorMessage,
        }),
      );
      const retrySleep = mock(async () => {});
      const onModelAbort = mock(() => {});
      const onModelError = mock(() => {});
      const runtime = createPiRuntime({ piStreamImpl: piStreamImpl as never, retrySleep });

      await expect(
        runtime.runTurn(makeParams({ onModelAbort, onModelError })),
      ).rejects.toMatchObject({
        name: "AbortError",
        responseMessages: [
          { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        requestUsages: [{ promptTokens: 1, completionTokens: 1, totalTokens: 2 }],
      });
      expect(piStreamImpl).toHaveBeenCalledTimes(1);
      expect(retrySleep).not.toHaveBeenCalled();
      expect(onModelAbort).toHaveBeenCalledTimes(1);
      expect(onModelError).not.toHaveBeenCalled();
    },
  );

  test("recognizes ordinary Error instances named AbortError", async () => {
    const failure = Object.assign(new Error("Request limit reached"), { name: "AbortError" });
    const piStreamImpl = mock(() => {
      throw failure;
    });
    const retrySleep = mock(async () => {});
    const onModelAbort = mock(() => {});
    const onModelError = mock(() => {});
    const runtime = createPiRuntime({ piStreamImpl: piStreamImpl as never, retrySleep });

    await expect(runtime.runTurn(makeParams({ onModelAbort, onModelError }))).rejects.toBe(failure);
    expect(piStreamImpl).toHaveBeenCalledTimes(1);
    expect(retrySleep).not.toHaveBeenCalled();
    expect(onModelAbort).toHaveBeenCalledTimes(1);
    expect(onModelError).not.toHaveBeenCalled();
  });
});

test("PI does not retry stream-consumer failures as provider outages", async () => {
  const failure = new Error("Service unavailable (503)");
  const piStreamImpl = mock(() => fakeStream(success, [{ type: "start" }]));
  const retrySleep = mock(async () => {});
  const onModelError = mock(() => {});
  const runtime = createPiRuntime({ piStreamImpl: piStreamImpl as never, retrySleep });

  await expect(
    runtime.runTurn(
      makeParams({
        onModelError,
        onModelStreamPart: (part) => {
          if ((part as Record<string, unknown>).type === "start") throw failure;
        },
      }),
    ),
  ).rejects.toBe(failure);
  expect(piStreamImpl).toHaveBeenCalledTimes(1);
  expect(retrySleep).not.toHaveBeenCalled();
  expect(onModelError).toHaveBeenCalledTimes(1);
  expect(onModelError).toHaveBeenCalledWith(failure);
});
