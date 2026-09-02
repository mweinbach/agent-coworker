import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  modelMessagesToPiMessages,
  normalizePiUsage,
  piTurnMessagesToModelMessages,
} from "../src/runtime/piMessageBridge";
import type { ModelMessage } from "../src/types";

const signedMessageModel: Model<"bedrock-converse-stream"> = {
  id: "anthropic.claude-sonnet-4-6",
  name: "Test Claude",
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};

const signedAssistantContent = [
  { type: "thinking", thinking: "Signed reasoning", thinkingSignature: "reasoning-signature" },
  { type: "thinking", thinking: "", thinkingSignature: "AQIDBA==", redacted: true },
  { type: "text", text: "Checking the result", textSignature: "text-signature" },
  {
    type: "toolCall",
    id: "call-signed",
    name: "lookup",
    arguments: {},
    thoughtSignature: "tool-signature",
  },
];

function persistedSignedMessages(): ModelMessage[] {
  return JSON.parse(
    JSON.stringify(
      piTurnMessagesToModelMessages([
        {
          role: "assistant",
          api: signedMessageModel.api,
          provider: signedMessageModel.provider,
          model: signedMessageModel.id,
          content: signedAssistantContent,
          stopReason: "toolUse",
        },
      ]),
    ),
  ) as ModelMessage[];
}

describe("pi message bridge", () => {
  test("preserves source identity and opaque signatures through serialized same-model replay", () => {
    const replay = modelMessagesToPiMessages(persistedSignedMessages(), "bedrock");

    expect(replay[0]).toMatchObject({
      api: signedMessageModel.api,
      provider: signedMessageModel.provider,
      model: signedMessageModel.id,
      content: signedAssistantContent,
    });
    expect(transformMessages(replay, signedMessageModel)[0]?.content).toEqual(
      signedAssistantContent,
    );
  });

  test.each(["provider", "model"] as const)(
    "does not replay opaque signatures after switching %s",
    (changedField) => {
      const destination = {
        ...signedMessageModel,
        ...(changedField === "provider" ? { provider: "other-provider" } : { id: "other-model" }),
      };
      const replay = modelMessagesToPiMessages(persistedSignedMessages(), destination.provider);

      expect(transformMessages(replay, destination)[0]?.content).toEqual([
        { type: "text", text: "Signed reasoning" },
        { type: "text", text: "Checking the result" },
        { type: "toolCall", id: "call-signed", name: "lookup", arguments: {} },
      ]);
    },
  );

  test.each(["error", "aborted"] as const)(
    "retains visible partial output without replaying incomplete opaque state (%s)",
    (stopReason) => {
      const messages = piTurnMessagesToModelMessages([
        {
          role: "assistant",
          api: signedMessageModel.api,
          provider: signedMessageModel.provider,
          model: signedMessageModel.id,
          content: signedAssistantContent.slice(0, 3),
          stopReason,
        },
      ]);
      const replay = modelMessagesToPiMessages(messages, "bedrock");
      expect(transformMessages(replay, signedMessageModel)[0]?.content).toEqual([
        { type: "text", text: "Signed reasoning" },
        { type: "text", text: "Checking the result" },
      ]);
    },
  );

  test("converts model messages into pi messages for user/assistant/tool results", () => {
    const modelMessages = [
      { role: "user", content: [{ type: "text", text: "summarize this file" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Working on it." },
          { type: "reasoning", text: "Need to inspect file first." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "/tmp/a.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ] as ModelMessage[];

    const piMessages = modelMessagesToPiMessages(modelMessages);
    expect(piMessages.map((m: any) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect((piMessages[0] as any).content).toContain("summarize this file");
    expect((piMessages[1] as any).content.some((part: any) => part.type === "toolCall")).toBe(true);
    expect((piMessages[2] as any).toolCallId).toBe("call-1");
  });

  test("preserves multimodal tool results when converting model messages into pi messages", () => {
    const imageOutput = {
      type: "content",
      content: [
        { type: "text", text: "Image file: chart.png" },
        { type: "image", data: "abc123", mimeType: "image/png" },
      ],
    };
    const modelMessages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-image",
            toolName: "read",
            output: imageOutput,
          },
        ],
      },
    ] as ModelMessage[];

    const piMessages = modelMessagesToPiMessages(modelMessages);
    expect(piMessages).toHaveLength(1);
    expect((piMessages[0] as any).role).toBe("toolResult");
    expect((piMessages[0] as any).content).toEqual(imageOutput.content);
  });

  test("preserves non-text user content with a placeholder", () => {
    const modelMessages = [
      {
        role: "user",
        content: [{ type: "image", image: "data:image/png;base64,abc" }],
      },
    ] as ModelMessage[];

    const piMessages = modelMessagesToPiMessages(modelMessages, "google");
    expect(piMessages).toHaveLength(1);
    expect((piMessages[0] as any).role).toBe("user");
    expect((piMessages[0] as any).content).toContain("[image]");
  });

  test("converts pi turn messages back to model messages", () => {
    const piTurnMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Done." },
          { type: "thinking", thinking: "I verified all requirements." },
          {
            type: "toolCall",
            id: "call-2",
            name: "write",
            arguments: { path: "/tmp/a.ts", content: "ok" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "write",
        content: [{ type: "text", text: '{"written":true}' }],
        isError: false,
      },
    ] as any[];

    const modelMessages = piTurnMessagesToModelMessages(piTurnMessages as any);
    expect(modelMessages).toHaveLength(2);
    expect(modelMessages[0].role).toBe("assistant");
    expect((modelMessages[0] as any).content.some((part: any) => part.type === "reasoning")).toBe(
      true,
    );
    expect(modelMessages[1].role).toBe("tool");
    expect((modelMessages[1] as any).content[0].type).toBe("tool-result");
  });

  test("drops commentary-phase assistant text when converting pi turn messages back to model messages", () => {
    const piTurnMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "progress note", phase: "commentary" },
          { type: "text", text: "final answer", phase: "final_answer" },
          {
            type: "toolCall",
            id: "call-2",
            name: "write",
            arguments: { path: "/tmp/a.ts", content: "ok" },
          },
        ],
      },
    ] as any[];

    const modelMessages = piTurnMessagesToModelMessages(piTurnMessages as any);
    expect(modelMessages).toHaveLength(1);
    expect(modelMessages[0].role).toBe("assistant");
    expect((modelMessages[0] as any).content).toEqual([
      { type: "text", text: "final answer", phase: "final_answer" },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "write",
        input: { path: "/tmp/a.ts", content: "ok" },
      },
    ]);
  });

  test.each([
    ["image", "image/png"],
    ["audio", "audio/wav"],
    ["video", "video/mp4"],
    ["document", "application/pdf"],
  ] as const)(
    "preserves %s tool results across serialized model-message replay",
    (type, mimeType) => {
      const content = [
        { type: "text", text: "Media result" },
        { type, data: "AQIDBA==", mimeType },
      ];
      const piTurnMessages = [
        {
          role: "toolResult",
          toolCallId: "call-image",
          toolName: "read",
          content,
          isError: false,
        },
      ] as any[];

      const modelMessages = piTurnMessagesToModelMessages(piTurnMessages as any);
      expect(modelMessages).toHaveLength(1);
      expect((modelMessages[0] as any).content[0]).toEqual({
        type: "tool-result",
        toolCallId: "call-image",
        toolName: "read",
        output: {
          type: "content",
          content,
        },
        isError: false,
      });
      const replay = modelMessagesToPiMessages(JSON.parse(JSON.stringify(modelMessages)));
      expect(replay[0]?.content).toEqual(content);
    },
  );

  test("extracts assistant text and reasoning from pi messages", () => {
    const piMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "thinking", thinking: "thinking-1" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "second" },
          { type: "thinking", thinking: "thinking-2" },
        ],
      },
    ] as any[];

    expect(extractPiAssistantText(piMessages as any)).toBe("first\n\nsecond");
    expect(extractPiReasoningText(piMessages as any)).toBe("thinking-1\n\nthinking-2");
  });

  test("ignores commentary-phase assistant text when extracting assistant text", () => {
    const piMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "working", phase: "commentary" },
          { type: "text", text: "done", phase: "final_answer" },
        ],
      },
    ] as any[];

    expect(extractPiAssistantText(piMessages as any)).toBe("done");
  });

  test("merges pi usage records into runtime usage totals", () => {
    const usage1 = mergePiUsage(undefined, { input: 10, output: 2, totalTokens: 12 });
    const usage2 = mergePiUsage(usage1, { input: 3, output: 7, totalTokens: 10 });

    expect(usage2).toEqual({
      promptTokens: 13,
      completionTokens: 9,
      totalTokens: 22,
    });
  });

  test("normalizes cached raw usage and nested cost totals into runtime counters", () => {
    expect(
      normalizePiUsage({
        input: 80,
        output: 20,
        totalTokens: 140,
        cacheRead: 30,
        cacheWrite: 10,
        cost: {
          total: 0.00123,
        },
      }),
    ).toEqual({
      promptTokens: 120,
      completionTokens: 20,
      totalTokens: 140,
      cachedPromptTokens: 30,
      cacheWritePromptTokens: 10,
      estimatedCostUsd: 0.00123,
    });
  });

  test("keeps cached usage counters without synthesizing cost when pricing is absent", () => {
    expect(
      normalizePiUsage({
        input: 80,
        output: 20,
        totalTokens: 140,
        cacheRead: 30,
        cacheWrite: 10,
      }),
    ).toEqual({
      promptTokens: 120,
      completionTokens: 20,
      totalTokens: 140,
      cachedPromptTokens: 30,
      cacheWritePromptTokens: 10,
    });
  });

  test("merges cached prompt, cache write, and estimated cost when present", () => {
    const usage1 = mergePiUsage(undefined, {
      input: 80,
      output: 20,
      totalTokens: 140,
      cacheRead: 30,
      cacheWrite: 10,
      reasoningOutputTokens: 4,
      estimatedCostUsd: 0.001,
    });
    const usage2 = mergePiUsage(usage1, {
      promptTokens: 50,
      completionTokens: 10,
      totalTokens: 60,
      cachedPromptTokens: 5,
      cacheWritePromptTokens: 3,
      reasoningTokens: 2,
      estimatedCostUsd: 0.002,
    });

    expect(usage2).toEqual({
      promptTokens: 170,
      completionTokens: 30,
      totalTokens: 200,
      cachedPromptTokens: 35,
      cacheWritePromptTokens: 13,
      reasoningOutputTokens: 6,
      estimatedCostUsd: 0.003,
    });
  });
});
