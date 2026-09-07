import { describe, expect, mock, test } from "bun:test";
import { scratchRoots } from "../src/platform/sandbox";
import { createPiRuntime } from "../src/runtime/pi/runTurn";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import type { AgentConfig } from "../src/types";

function params(): RuntimeRunTurnParams {
  const root = scratchRoots()[0]!;
  return {
    config: {
      provider: "opencode-go",
      model: "glm-5",
      preferredChildModel: "glm-5",
      workingDirectory: root,
      outputDirectory: root,
      uploadsDirectory: root,
      projectCoworkDir: `${root}/.cowork`,
      userCoworkDir: `${root}/.cowork`,
      builtInDir: root,
      builtInConfigDir: root,
      skillsDirs: [],
      memoryDirs: [],
      configDirs: [],
      userName: "",
      knowledgeCutoff: "unknown",
    } as AgentConfig,
    system: "test",
    messages: [{ role: "user", content: "test" }],
    tools: {},
    maxSteps: 1,
    prepareStep: async () => ({
      streamOptions: { stepTimeoutMs: 30, timeoutMs: 100, maxRetries: 0 },
    }),
  };
}

describe("PI request budget integration", () => {
  test.each(["stream", "result"] as const)(
    "bounds a stalled %s and suppresses late provider output",
    async (stalledPhase) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let sentOptions: Record<string, unknown> | undefined;
      const events: unknown[] = [];
      const execute = mock(() => "must not execute");
      const runtime = createPiRuntime({
        piStreamImpl: ((_model: unknown, _context: unknown, options: Record<string, unknown>) => {
          sentOptions = options;
          return {
            async *[Symbol.asyncIterator]() {
              if (stalledPhase === "stream") await gate;
              yield { type: "start" };
              yield { type: "text_delta", contentIndex: 0, delta: "late text" };
            },
            async result() {
              await gate;
              return {
                role: "assistant",
                content: [{ type: "toolCall", id: "late", name: "write", arguments: {} }],
                stopReason: "toolUse",
              };
            },
          };
        }) as never,
      });
      try {
        await expect(
          runtime.runTurn({
            ...params(),
            tools: { write: { execute } },
            onModelStreamPart: (event) => {
              events.push(event);
            },
          }),
        ).rejects.toThrow("PI model step exceeded");
        expect(sentOptions).not.toHaveProperty("stepTimeoutMs");
        expect(sentOptions?.timeoutMs).toBe(30);
        expect((sentOptions?.signal as AbortSignal | undefined)?.aborted).toBe(true);
        const eventCount = events.length;
        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events).toHaveLength(eventCount);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );

  test("bounds an injected retry wait that ignores cancellation", async () => {
    const piStreamImpl = mock(() => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Service unavailable (503)",
        };
      },
    }));
    const retrySleep = mock(() => new Promise<void>(() => {}));
    await expect(
      createPiRuntime({ piStreamImpl: piStreamImpl as never, retrySleep }).runTurn(params()),
    ).rejects.toThrow("PI model step exceeded");
    expect(piStreamImpl).toHaveBeenCalledTimes(1);
    expect(retrySleep).toHaveBeenCalledTimes(1);
  });
});
