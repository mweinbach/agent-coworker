import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { createRuntime } from "../../../src/runtime";
import { buildCodexTurnInput } from "../../../src/runtime/codexAppServer/turnInput";
import { mockInterrupts, writeMockAppServer } from "../../fixtures/codexAppServerMock";
import {
  installCodexAppServerTestHooks,
  makeConfig,
  readCapturedRequests,
  testNodeCommand,
} from "./helpers";

installCodexAppServerTestHooks();

describe("codex app-server turn lifecycle", () => {
  test.serial("registers an active steer handler that sends turn/steer to app-server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-steer-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;
    process.env.CODEX_APP_SERVER_DELAY_COMPLETION = "1";

    let steerHandler:
      | ((input: { text: string; expectedTurnId: string }) => Promise<void>)
      | undefined;
    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
      registerSteerHandler: (handler) => {
        steerHandler = handler;
        queueMicrotask(() => {
          void handler({ text: "also mention steering", expectedTurnId: "turn_1" });
        });
        return () => {
          if (steerHandler === handler) steerHandler = undefined;
        };
      },
    });

    expect(result.text).toBe("hello from app-server");
    const requests = await readCapturedRequests(capturePath);
    expect(requests.find((entry) => entry.method === "turn/steer")?.params).toMatchObject({
      threadId: "thread_1",
      expectedTurnId: "turn_1",
      input: [{ type: "text", text: "also mention steering", text_elements: [] }],
    });
    expect(steerHandler).toBeUndefined();
  });

  test.serial("refreshes dynamic tools and only sends latest user input on resume", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-resume-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      allMessages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Newest question" },
      ],
      messages: [{ role: "user", content: "Newest question" }],
      tools: {
        spawnAgent: {
          description: "Spawn a Cowork subagent.",
          inputSchema: z.object({ task: z.string() }),
          execute: () => "spawned",
        },
        mcp__srv__custom: {
          description: "A Cowork-managed MCP tool.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          execute: () => "mcp ok",
        },
        bash: {
          description: "Cowork bash should stay native to app-server.",
          execute: () => "should not be called",
        },
      },
      maxSteps: 1,
      providerState: {
        provider: "codex-cli",
        model: "gpt-5.4",
        threadId: "thread_1",
        updatedAt: new Date().toISOString(),
      },
    });

    const requests = await readCapturedRequests(capturePath);
    const resumeParams = requests.find((entry) => entry.method === "thread/resume")?.params;
    expect(resumeParams).not.toHaveProperty("baseInstructions");
    expect(resumeParams?.dynamicTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "spawnAgent",
          description: "Spawn a Cowork subagent.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
        expect.objectContaining({
          name: "cowork_mcp__srv__custom",
          description: "A Cowork-managed MCP tool.",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
      ]),
    );
    expect(
      (resumeParams?.dynamicTools as Array<{ name?: string }>).map((tool) => tool.name),
    ).not.toContain("bash");
    expect(requests.find((entry) => entry.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "Newest question", text_elements: [] },
    ]);
  });

  test.serial("starts a fresh thread when stored app-server thread is stale", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-stale-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "stale-resume";

    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      allMessages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Newest question" },
      ],
      messages: [{ role: "user", content: "Newest question" }],
      tools: {},
      maxSteps: 1,
      providerState: {
        provider: "codex-cli",
        model: "gpt-5.4",
        threadId: "stale_thread",
        updatedAt: new Date().toISOString(),
      },
    });

    const requests = await readCapturedRequests(capturePath);
    expect(requests.map((entry) => entry.method)).toEqual(
      expect.arrayContaining(["thread/resume", "thread/start", "turn/start"]),
    );
    expect(requests.find((entry) => entry.method === "thread/start")?.params).toHaveProperty(
      "baseInstructions",
    );
    expect(requests.find((entry) => entry.method === "turn/start")?.params.input).toEqual([
      { type: "text", text: "User: Earlier question", text_elements: [] },
      { type: "text", text: "Assistant: Earlier answer", text_elements: [] },
      { type: "text", text: "User: Newest question", text_elements: [] },
    ]);
    expect(result.providerState).toEqual(
      expect.objectContaining({ provider: "codex-cli", model: "gpt-5.4", threadId: "thread_1" }),
    );
  });

  test.serial(
    "preserves fresh conversation history and sends image attachments as app-server inputs",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-attachments-"));
      const capturePath = path.join(dir, "requests.jsonl");
      process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;

      const runtime = createRuntime(makeConfig(dir));
      await runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        allMessages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          {
            role: "user",
            content: [
              { type: "text", text: "Look at these" },
              {
                type: "image",
                mimeType: "image/png",
                data: "abc",
                detail: "low",
                filename: "chart.png",
              },
              { type: "file", mimeType: "text/plain", data: "inline", filename: "note.txt" },
              {
                type: "file",
                mimeType: "image/jpeg",
                path: "/tmp/uploaded.jpg",
                detail: "high",
                filename: "uploaded.jpg",
              },
              { type: "file", path: "/tmp/uploaded.pdf", filename: "uploaded.pdf" },
            ],
          },
        ],
        messages: [{ role: "user", content: "Look at these" }],
        tools: {},
        maxSteps: 1,
      });

      const requests = await readCapturedRequests(capturePath);
      expect(requests.find((entry) => entry.method === "turn/start")?.params.input).toEqual([
        { type: "text", text: "User: Earlier question", text_elements: [] },
        { type: "text", text: "Assistant: Earlier answer", text_elements: [] },
        {
          type: "text",
          text: "User: Look at these",
          text_elements: [],
        },
        {
          type: "image",
          detail: "low",
          url: "data:image/png;base64,abc",
        },
        {
          type: "localImage",
          detail: "high",
          path: "/tmp/uploaded.jpg",
        },
      ]);
    },
  );

  test("omits non-image files and preserves attachment-only text element context", () => {
    expect(
      buildCodexTurnInput(
        [
          {
            role: "user",
            content: [
              { type: "file", mimeType: "text/plain", data: "inline", filename: "note.txt" },
              { type: "file", path: "/tmp/uploaded.pdf", filename: "uploaded.pdf" },
              { byteRange: { start: 4, end: 12 }, placeholder: "[selection]" },
            ],
          },
        ],
        { resumedThread: false },
      ),
    ).toEqual([
      {
        type: "text",
        text: "User: [attachment]",
        text_elements: [{ byteRange: { start: 4, end: 12 }, placeholder: "[selection]" }],
      },
    ]);
  });

  test("sends image-only resumed user messages without replaying prior context", () => {
    expect(
      buildCodexTurnInput(
        [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          {
            role: "user",
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: "abc",
                detail: "original",
                filename: "chart.png",
              },
            ],
          },
        ],
        { resumedThread: true },
      ),
    ).toEqual([
      { type: "text", text: "[attachment]", text_elements: [] },
      { type: "image", detail: "original", url: "data:image/png;base64,abc" },
    ]);
  });

  test.serial("aborts active app-server turns through interruptTurn", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-abort-"));
    process.env.CODEX_APP_SERVER_DELAY_COMPLETION = "1";
    const controller = new AbortController();
    const runtime = createRuntime(makeConfig(dir));

    await expect(
      runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Wait" }],
        tools: {},
        maxSteps: 1,
        abortSignal: controller.signal,
        onModelRawEvent: (event) => {
          const message = event.event.message as { method?: string } | undefined;
          if (message?.method === "turn/start") setTimeout(() => controller.abort(), 0);
        },
      }),
    ).rejects.toThrow("Cancelled by user");
    expect(mockInterrupts).toEqual([{ threadId: "thread_1", turnId: "turn_1" }]);
  });

  test.serial("projects requestUserInput, todoList, and fileChange events", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-events-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "eventful";
    const todos: unknown[] = [];
    const streamParts: unknown[] = [];
    const prompts: unknown[] = [];
    const runtime = createRuntime(makeConfig(dir));

    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Do work" }],
      tools: {},
      maxSteps: 1,
      askUser: async (question, options) => {
        prompts.push({ question, options });
        return "yes";
      },
      updateTodos: (nextTodos) => todos.push(nextTodos),
      onModelStreamPart: (part) => streamParts.push(part),
    });

    expect(todos).toContainEqual([
      {
        content: "Wire app-server todos",
        status: "completed",
        activeForm: "Wire app-server todos",
      },
    ]);
    expect(streamParts).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        toolName: "fileChange",
      }),
    );
    expect(streamParts).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        toolName: "fileChange",
        output: expect.stringContaining("--- a/src/example.ts"),
      }),
    );
    expect(streamParts).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        toolName: "fileChange",
        output: expect.stringContaining("@@ -1 +1 @@"),
      }),
    );
    expect(streamParts).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        toolName: "fileChange",
        output: [{ path: "src/example.ts", kind: "modified" }],
      }),
    );
    expect(prompts).toEqual([{ question: "Need detail?", options: ["yes"] }]);
  });

  test.serial("ignores early token usage for a different turn id", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-wrong-usage-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "early-token-usage-wrong";
    const runtime = createRuntime(makeConfig(dir));

    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    expect(result.text).toBe("hello from app-server");
    expect(result.usage).toBeUndefined();
  });

  test.serial("keeps early token usage when its turn id later matches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-matching-usage-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "early-token-usage-matching";
    const runtime = createRuntime(makeConfig(dir));

    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    expect(result.usage).toEqual({
      promptTokens: 11,
      completionTokens: 13,
      totalTokens: 24,
      cachedPromptTokens: 1,
      cacheWritePromptTokens: 2,
      reasoningOutputTokens: 5,
    });
  });

  test.serial("uses cumulative Codex token usage instead of the last request", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-cumulative-usage-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "cumulative-token-usage";
    const runtime = createRuntime(makeConfig(dir));

    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    expect(result.usage).toEqual({
      promptTokens: 3455915,
      completionTokens: 20472,
      totalTokens: 3476387,
      cachedPromptTokens: 2987776,
      reasoningOutputTokens: 5929,
    });
  });

  test.serial("normalizes OpenAI-style cached and reasoning usage details", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-openai-usage-"));
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "openai-usage-details";
    const runtime = createRuntime(makeConfig(dir));

    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      messages: [{ role: "user", content: "Say hi" }],
      tools: {},
      maxSteps: 1,
    });

    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 13,
      totalTokens: 33,
      cachedPromptTokens: 6,
      cacheWritePromptTokens: 4,
      reasoningOutputTokens: 5,
    });
  });
});
