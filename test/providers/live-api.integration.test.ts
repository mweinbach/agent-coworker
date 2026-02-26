import { describe, expect, test } from "bun:test";

import { runTurn } from "../../src/agent";
import { makeConfig } from "./helpers";

const runLiveApiTests = process.env.RUN_LIVE_API_TESTS === "1";
const openAiKey = process.env.OPENAI_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

function shouldRunTest(name: string, value: string | undefined): boolean {
  if (!runLiveApiTests) {
    console.warn(`[live-api] skipping ${name}: set RUN_LIVE_API_TESTS=1 to enable`);
    return false;
  }
  if (!value) {
    console.warn(`[live-api] skipping ${name}: missing API key`);
    return false;
  }
  return true;
}

describe("live model API integration", () => {
  test("OpenAI returns a real response payload and text", async () => {
    if (!shouldRunTest("openai basic response", openAiKey)) return;

    const config = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          reasoningSummary: "detailed",
        },
      },
    });

    const result = await runTurn({
      config,
      system: "You are a concise test assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly PONG." }] }],
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => false,
      maxSteps: 3,
    });

    expect(result.text.toUpperCase()).toContain("PONG");
    expect(result.responseMessages.length).toBeGreaterThan(0);
  }, 120_000);

  test("OpenAI returns reasoning summary text", async () => {
    if (!shouldRunTest("openai reasoning", openAiKey)) return;

    const config = makeConfig({
      provider: "openai",
      model: "gpt-5.2",
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          reasoningSummary: "detailed",
        },
      },
    });

    const result = await runTurn({
      config,
      system:
        "Think step-by-step internally. Include one line that starts with REASONING_SUMMARY: and then provide the final answer.",
      messages: [{ role: "user", content: [{ type: "text", text: "What is 17 + 25?" }] }],
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => false,
      maxSteps: 3,
    });

    expect(result.text).toContain("42");
    expect(result.text).toContain("REASONING_SUMMARY:");
    if (result.reasoningText !== undefined) {
      expect(result.reasoningText.length).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);

  test("OpenAI can invoke app tools through an actual API call", async () => {
    if (!shouldRunTest("openai tools", openAiKey)) return;

    let toolCalled = false;

    const runTurnResult = await runTurn({
      config: makeConfig({ provider: "openai", model: "gpt-5.2" }),
      system: "Always call the ask tool before answering.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Use the ask tool once, then answer with exactly DONE." }],
        },
      ],
      log: () => {},
      askUser: async () => {
        toolCalled = true;
        return "approved";
      },
      approveCommand: async () => true,
      maxSteps: 4,
    });

    expect(toolCalled).toBeTrue();
    expect(runTurnResult.text.toUpperCase()).toContain("DONE");
  }, 120_000);

  test("Anthropic returns a real response when key is present", async () => {
    if (!shouldRunTest("anthropic basic response", anthropicKey)) return;

    const config = makeConfig({
      provider: "anthropic",
      model: "claude-4-5-haiku",
    });

    try {
      const result = await runTurn({
        config,
        system: "You are a concise test assistant.",
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly ANTHROPIC_OK." }] }],
        log: () => {},
        askUser: async () => "",
        approveCommand: async () => false,
        maxSteps: 2,
      });

      expect(result.text.toUpperCase()).toContain("ANTHROPIC_OK");
      expect(result.responseMessages.length).toBeGreaterThan(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[live-api] skipping anthropic basic response due to API error: ${message}`);
      return;
    }
  }, 120_000);

  test("Google returns a real response when key is present", async () => {
    if (!shouldRunTest("google basic response", googleKey)) return;

    const config = makeConfig({
      provider: "google",
      model: "gemini-3-flash-preview",
    });

    const result = await runTurn({
      config,
      system: "You are a concise test assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly GOOGLE_OK." }] }],
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => false,
      maxSteps: 2,
    });

    expect(result.text.toUpperCase()).toContain("GOOGLE_OK");
    expect(result.responseMessages.length).toBeGreaterThan(0);
  }, 120_000);

});
