import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoogleInteractionsRuntime } from "../../../src/runtime/googleInteractionsRuntime";
import { makeConfig, makeParams } from "./fixtures";

describe("google interactions runtime — errors", () => {
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

  test("records and attaches usage to thrown error when turn fails mid-way", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "google-interactions-failure-usage-"));
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
        throw new Error("Gemini interactions failed on step 2");
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
      promptTokens: 40,
      completionTokens: 8,
      totalTokens: 48,
    });
  });
});
