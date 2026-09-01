import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import type { PartialTurnError } from "../../../src/runtime/types";
import type { ModelMessage } from "../../../src/types";
import { makeConfig, makeParams } from "./fixtures";

describe("google interactions runtime — errors", () => {
  test("replays completed tools and partial output after a failed continuation step", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async (opts) => {
        requests.push({
          previousInteractionId: opts.previousInteractionId,
          messages: opts.messages,
        });
        if (requests.length === 1) {
          return {
            assistant: {
              role: "assistant",
              content: [{ type: "toolCall", id: "lookup_1", name: "lookup", arguments: {} }],
              stopReason: "tool_calls",
            },
            interactionId: "interaction_tool",
          };
        }
        if (requests.length === 2) {
          const failure = new Error("Incomplete model response") as PartialTurnError;
          failure.responseMessages = [
            { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
          ];
          throw failure;
        }
        return {
          assistant: {
            role: "assistant",
            content: [{ type: "text", text: "Recovered" }],
            stopReason: "stop",
          },
          interactionId: "interaction_recovered",
        };
      },
    });
    const config = makeConfig(path.join(import.meta.dir, "fixtures", "failed-continuation"));
    const history: ModelMessage[] = [{ role: "user", content: "Find the answer" }];
    const tools = { lookup: { execute: () => "The completed lookup result" } };
    let failure: PartialTurnError | undefined;
    try {
      await runtime.runTurn(
        makeParams(config, { messages: history, allMessages: history, tools, maxSteps: 2 }),
      );
    } catch (error) {
      failure = error as PartialTurnError;
    }
    expect(failure).toBeDefined();
    const resumedHistory: ModelMessage[] = [
      ...history,
      ...(failure?.responseMessages ?? []),
      { role: "user", content: "Continue" },
    ];
    await runtime.runTurn(
      makeParams(config, {
        messages: resumedHistory,
        allMessages: resumedHistory,
        tools,
        providerState: failure?.providerState,
      }),
    );
    expect(requests[2]?.previousInteractionId).toBeUndefined();
    expect(JSON.stringify(requests[2]?.messages)).toContain("The completed lookup result");
    expect(JSON.stringify(requests[2]?.messages)).toContain("Partial answer");
  });

  test("error in model step propagates and calls onModelError", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-err-"));
    const runtime = createGoogleInteractionsRuntime({
      runStepImpl: async () => {
        throw new Error("API rate limit exceeded");
      },
    });

    let errorCaught: unknown;
    try {
      await runtime.runTurn(
        makeParams(makeConfig(homeDir), {
          onModelError: async (error) => {
            errorCaught = error;
          },
        }),
      );
    } catch (error) {
      expect((error as Error).message).toBe("API rate limit exceeded");
    }

    expect(errorCaught).toBeDefined();
    expect((errorCaught as Error).message).toBe("API rate limit exceeded");
  });

  test.each(["none", "detailed", "opaque"] as const)(
    "records earlier progress and current partial step: %s",
    async (partialKind) => {
      const homeDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "google-interactions-failure-usage-"),
      );
      let stepCount = 0;
      const runtime = createGoogleInteractionsRuntime({
        runStepImpl: async () => {
          stepCount += 1;
          if (stepCount === 1) {
            return {
              assistant: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "call_1",
                    name: "some_tool",
                    arguments: {},
                  },
                ],
                usage: {
                  input: 40,
                  output: 8,
                  totalTokens: 48,
                },
                stopReason: "tool_calls",
                timestamp: Date.now(),
              },
              interactionId: "interaction_step_1",
            };
          }
          const failure = new Error("Gemini interactions failed on step 2") as PartialTurnError;
          if (partialKind !== "none") {
            failure.usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
            failure.responseMessages = [
              { role: "assistant", content: [{ type: "text", text: "Partial second answer" }] },
            ];
            if (partialKind === "detailed") failure.requestUsages = [failure.usage];
          }
          throw failure;
        },
      });

      let thrownError: any = null;
      try {
        await runtime.runTurn(
          makeParams(makeConfig(homeDir), {
            maxSteps: 2,
            tools: {
              some_tool: {
                execute: async () => "success",
              },
            },
          }),
        );
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError.message).toContain("Gemini interactions failed on step 2");
      expect(thrownError.usage).toEqual({
        promptTokens: partialKind === "none" ? 40 : 43,
        completionTokens: partialKind === "none" ? 8 : 10,
        totalTokens: partialKind === "none" ? 48 : 53,
      });
      expect(thrownError.providerState).toBeNull();
      expect(thrownError.responseMessages).toHaveLength(partialKind === "none" ? 2 : 3);
      if (partialKind !== "none") {
        expect(thrownError.responseMessages.at(-1)).toEqual({
          role: "assistant",
          content: [{ type: "text", text: "Partial second answer" }],
        });
      }
      expect(thrownError.requestUsages).toEqual(
        partialKind === "opaque"
          ? undefined
          : [
              { promptTokens: 40, completionTokens: 8, totalTokens: 48 },
              ...(partialKind === "detailed"
                ? [{ promptTokens: 3, completionTokens: 2, totalTokens: 5 }]
                : []),
            ],
      );
    },
  );

  test.each([true, false])(
    "preserves known retry attempt usage and its available detail: %j",
    async (detailed) => {
      let requests = 0;
      const failedUsage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
      const runtime = createGoogleInteractionsRuntime({
        runStepImpl: async () => {
          requests += 1;
          if (requests === 1) {
            const failure = new Error("503 service unavailable") as PartialTurnError;
            failure.usage = failedUsage;
            if (detailed) failure.requestUsages = [failedUsage];
            throw failure;
          }
          return {
            assistant: {
              role: "assistant",
              content: [{ type: "text", text: "Recovered" }],
              usage: { input: 7, output: 1, totalTokens: 8 },
              stopReason: "stop",
            },
            interactionId: "interaction_recovered",
          };
        },
      });

      const result = await runtime.runTurn(
        makeParams(makeConfig(path.join(import.meta.dir, "fixtures", "retry-usage"))),
      );
      expect(requests).toBe(2);
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3, totalTokens: 13 });
      expect(result.requestUsages).toEqual(
        detailed
          ? [failedUsage, { promptTokens: 7, completionTokens: 1, totalTokens: 8 }]
          : undefined,
      );
    },
  );
});
