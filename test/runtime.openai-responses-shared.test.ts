import { describe, expect, test } from "bun:test";

import { convertResponsesMessages } from "../src/runtime/openaiResponsesShared";
import type { PiModel } from "../src/runtime/piRuntimeOptions";

const openaiModel: PiModel = {
  id: "gpt-5.2",
  name: "gpt-5.2",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text", "image"],
  contextWindow: 128_000,
  maxTokens: 16_384,
};

const allowedToolCallProviders = new Set(["openai"]);

describe("convertResponsesMessages", () => {
  test("inserts synthetic tool results for pending tool calls before the next user turn", () => {
    const converted = convertResponsesMessages(
      openaiModel,
      {
        messages: [
          { role: "user", content: "run tools" },
          {
            role: "assistant",
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.2",
            content: [
              {
                type: "toolCall",
                id: "call_1|fc_item_1",
                name: "bash",
                arguments: { command: "pwd" },
              },
            ],
          },
          { role: "user", content: "continue anyway" },
        ],
      },
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "run tools" }],
      },
      {
        type: "function_call",
        id: "fc_item_1",
        call_id: "call_1",
        name: "bash",
        arguments: JSON.stringify({ command: "pwd" }),
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "No result provided",
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "continue anyway" }],
      },
    ]);
  });

  test("normalizes pipe-delimited tool-call ids across models and remaps matching tool results", () => {
    const converted = convertResponsesMessages(
      { ...openaiModel, id: "gpt-5.4" },
      {
        messages: [
          { role: "user", content: "normalize ids" },
          {
            role: "assistant",
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.2",
            content: [
              {
                type: "toolCall",
                id: "call/with|item/with spaces!",
                name: "search",
                arguments: { q: "docs" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call/with|item/with spaces!",
            toolName: "search",
            content: [{ type: "text", text: "ok" }],
          },
        ],
      },
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "normalize ids" }],
      },
      {
        type: "function_call",
        // Cross-model conversion also drops fc_ item ids for sibling models.
        id: undefined,
        call_id: "call_with",
        name: "search",
        arguments: JSON.stringify({ q: "docs" }),
      },
      {
        type: "function_call_output",
        call_id: "call_with",
        output: "ok",
      },
    ]);
  });

  test("strips cross-model thought signatures and drops fc_ item ids for sibling models", () => {
    const converted = convertResponsesMessages(
      { ...openaiModel, id: "gpt-5.4" },
      {
        messages: [
          { role: "user", content: "switch models" },
          {
            role: "assistant",
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.2",
            content: [
              {
                type: "thinking",
                thinking: "private chain",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_keep",
                }),
              },
              {
                type: "toolCall",
                id: "call_x|fc_old",
                name: "bash",
                arguments: { command: "ls" },
                thoughtSignature: "sig-should-drop",
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_x|fc_old",
            toolName: "bash",
            content: [{ type: "text", text: "listed" }],
          },
        ],
      },
      allowedToolCallProviders,
      { includeSystemPrompt: false },
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "switch models" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "private chain",
            annotations: [],
          },
        ],
        status: "completed",
        id: "msg_1",
      },
      {
        type: "function_call",
        id: undefined,
        call_id: "call_x",
        name: "bash",
        arguments: JSON.stringify({ command: "ls" }),
      },
      {
        type: "function_call_output",
        call_id: "call_x",
        output: "listed",
      },
    ]);
  });
});
