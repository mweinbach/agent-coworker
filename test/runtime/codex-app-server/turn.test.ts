import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { scratchRoots } from "../../../src/platform/sandbox";
import {
  type CodexAppServerClient,
  type CodexAppServerJsonRpcNotification,
  type CodexAppServerJsonRpcRawMessage,
  __internal as codexAppServerClientInternal,
} from "../../../src/providers/codexAppServerClient";
import { createRuntime } from "../../../src/runtime";
import { buildCodexTurnInput } from "../../../src/runtime/codexAppServer/turnInput";
import type { ModelMessage } from "../../../src/types";
import { mockInterrupts, writeMockAppServer } from "../../fixtures/codexAppServerMock";
import {
  installCodexAppServerTestHooks,
  makeConfig,
  readCapturedRequests,
  testNodeCommand,
} from "./helpers";

installCodexAppServerTestHooks();

type TestSteerHandler = (input: {
  text: string;
  expectedTurnId: string;
  content?: ModelMessage["content"];
}) => Promise<void>;

function createControlledCodexTurnClient(): {
  client: CodexAppServerClient;
  turnStartEntered: Promise<{ threadId: string; params: Record<string, unknown> }>;
  resolveTurnStart: (value?: unknown) => void;
  rejectTurnStart: (error: Error) => void;
  emitNotification: (notification: CodexAppServerJsonRpcNotification) => void;
  interruptCalls: Array<{ threadId: string; turnId?: string }>;
} {
  const notificationListeners = new Set<
    (notification: CodexAppServerJsonRpcNotification) => void
  >();
  const rawListeners = new Set<(message: CodexAppServerJsonRpcRawMessage) => void>();
  const closeListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  const turnStartEntered = Promise.withResolvers<{
    threadId: string;
    params: Record<string, unknown>;
  }>();
  const turnStartResponse = Promise.withResolvers<unknown>();
  const interruptCalls: Array<{ threadId: string; turnId?: string }> = [];
  let nextRequestId = 1;

  const emitRaw = (message: CodexAppServerJsonRpcRawMessage) => {
    for (const listener of rawListeners) listener(message);
  };
  const emitNotification = (notification: CodexAppServerJsonRpcNotification) => {
    emitRaw({
      direction: "server_notification",
      message: notification as Record<string, unknown>,
    });
    for (const listener of notificationListeners) listener(notification);
  };
  const emitResponse = (id: number, result: unknown) => {
    emitRaw({ direction: "server_response", message: { id, result } });
  };

  const client: CodexAppServerClient = {
    command: { command: "mock-codex-app-server", args: [], source: "override" },
    isClosed: () => false,
    getLastCloseInfo: () => null,
    request: async (method: string, params?: unknown) => {
      const id = nextRequestId++;
      emitRaw({
        direction: "client_request",
        message: { id, method, ...(params !== undefined ? { params } : {}) },
      });
      let result: unknown;
      if (method === "initialize") {
        result = { userAgent: "mock" };
      } else if (method === "model/list") {
        result = {
          data: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }],
          nextCursor: null,
        };
      } else if (method === "thread/start") {
        const record = params as { model?: string; approvalPolicy?: string; sandbox?: string };
        result = {
          thread: { id: "thread_1", modelProvider: "openai", turns: [] },
          model: record.model ?? "gpt-5.4",
          modelProvider: "openai",
          cwd: process.cwd(),
          approvalPolicy: record.approvalPolicy,
          sandbox: record.sandbox,
          reasoningEffort: "high",
        };
      } else if (method === "turn/start") {
        const record = (params as Record<string, unknown> | undefined) ?? {};
        const threadId = typeof record.threadId === "string" ? record.threadId : "thread_1";
        turnStartEntered.resolve({ threadId, params: record });
        return await turnStartResponse.promise;
      } else if (method === "turn/steer") {
        const record = (params as Record<string, unknown> | undefined) ?? {};
        result = { turnId: record.expectedTurnId };
      } else {
        result = {};
      }
      emitResponse(id, result);
      return result;
    },
    notify: (method, params) => {
      emitRaw({
        direction: "client_notification",
        message: { method, ...(params !== undefined ? { params } : {}) },
      });
    },
    interruptTurn: async (params) => {
      interruptCalls.push(params);
    },
    onNotification: (listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onServerRequest: () => () => {},
    onJsonRpcMessage: (listener) => {
      rawListeners.add(listener);
      return () => rawListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: async () => {
      for (const listener of closeListeners) listener(null, "SIGTERM");
    },
  };

  return {
    client,
    turnStartEntered: turnStartEntered.promise,
    resolveTurnStart: (value = { turn: { id: "turn_ack", status: "inProgress", items: [] } }) =>
      turnStartResponse.resolve(value),
    rejectTurnStart: (error: Error) => turnStartResponse.reject(error),
    emitNotification,
    interruptCalls,
  };
}

describe("codex app-server turn lifecycle", () => {
  test.serial(
    "preserves diagnostics and continuation state when app-server disconnects mid-turn",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-disconnect-"));
      process.env.COWORK_CODEX_APP_SERVER_ARGS = "disconnect-mid-turn";

      const runtime = createRuntime(makeConfig(dir));
      let capturedError: unknown;
      try {
        await runtime.runTurn({
          config: makeConfig(dir),
          system: "You are Codex.",
          messages: [{ role: "user", content: "Say hi" }],
          tools: {},
          maxSteps: 1,
        });
      } catch (error) {
        capturedError = error;
      }

      expect(capturedError).toBeInstanceOf(Error);
      const error = capturedError as Error & {
        usage?: unknown;
        responseMessages?: unknown;
        providerState?: unknown;
      };
      expect(error.message).toContain("Codex client disconnected during execution");
      expect(error.message).toContain("code=42");
      expect(error.message).toContain("stderrBytes=321");
      expect(error.message).toContain("Codex app-server source=override");
      expect(error.usage).toEqual({
        promptTokens: 80,
        completionTokens: 19,
        totalTokens: 99,
        cachedPromptTokens: 10,
        reasoningOutputTokens: 3,
      });
      expect(error.responseMessages).toEqual([
        { role: "assistant", content: "partial before crash" },
      ]);
      expect(error.providerState).toEqual(
        expect.objectContaining({
          provider: "codex-cli",
          model: "gpt-5.4",
          threadId: "thread_1",
        }),
      );
    },
  );

  test.serial(
    "drops unknown-turn token usage when app-server disconnects before start ack",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-unknown-usage-close-"));
      const controlled = createControlledCodexTurnClient();
      let turnPromise: Promise<unknown> | undefined;

      codexAppServerClientInternal.setClientFactoryForTests(async () => controlled.client);

      try {
        const runtime = createRuntime(makeConfig(dir));
        turnPromise = runtime.runTurn({
          config: makeConfig(dir),
          system: "You are Codex.",
          messages: [{ role: "user", content: "Wait" }],
          tools: {},
          maxSteps: 1,
        });

        await controlled.turnStartEntered;
        controlled.emitNotification({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread_1",
            turnId: "old_turn",
            tokenUsage: {
              total: {
                inputTokens: 7,
                outputTokens: 11,
                totalTokens: 18,
              },
            },
          },
        });
        await controlled.client.close();

        let capturedError: unknown;
        try {
          await turnPromise;
        } catch (error) {
          capturedError = error;
        }
        expect(capturedError).toBeInstanceOf(Error);
        expect((capturedError as Error & { usage?: unknown }).message).toContain(
          "Codex client disconnected during execution",
        );
        expect((capturedError as Error & { usage?: unknown }).usage).toBeUndefined();
      } finally {
        controlled.rejectTurnStart(new Error("late start rejection after disconnect"));
        await turnPromise?.catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.serial(
    "drops same-thread stale token usage after a stale item before start ack",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-stale-item-usage-"));
      const controlled = createControlledCodexTurnClient();
      let turnPromise: Promise<unknown> | undefined;

      codexAppServerClientInternal.setClientFactoryForTests(async () => controlled.client);

      try {
        const runtime = createRuntime(makeConfig(dir));
        turnPromise = runtime.runTurn({
          config: makeConfig(dir),
          system: "You are Codex.",
          messages: [{ role: "user", content: "Wait" }],
          tools: {},
          maxSteps: 1,
        });

        await controlled.turnStartEntered;
        controlled.emitNotification({
          method: "item/started",
          params: {
            threadId: "thread_1",
            turnId: "old_turn",
            item: { type: "agentMessage", id: "old_item", text: "stale" },
          },
        });
        controlled.emitNotification({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread_1",
            turnId: "old_turn",
            tokenUsage: {
              total: {
                inputTokens: 7,
                outputTokens: 11,
                totalTokens: 18,
              },
            },
          },
        });
        await controlled.client.close();

        let capturedError: unknown;
        try {
          await turnPromise;
        } catch (error) {
          capturedError = error;
        }
        expect(capturedError).toBeInstanceOf(Error);
        expect((capturedError as Error & { usage?: unknown }).message).toContain(
          "Codex client disconnected during execution",
        );
        expect((capturedError as Error & { usage?: unknown }).usage).toBeUndefined();
      } finally {
        controlled.rejectTurnStart(new Error("late start rejection after disconnect"));
        await turnPromise?.catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.serial("registers an active steer handler that sends turn/steer to app-server", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-steer-"));
    const script = await writeMockAppServer(dir);
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;
    process.env.CODEX_APP_SERVER_DELAY_COMPLETION = "1";

    let steerHandler: TestSteerHandler | undefined;
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
          void handler({ text: "also mention steering", expectedTurnId: "cowork-turn-1" });
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

  test.serial("sends image steer content as Codex app-server image inputs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-image-steer-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;
    process.env.CODEX_APP_SERVER_DELAY_COMPLETION = "1";

    let steerHandler: TestSteerHandler | undefined;
    const runtime = createRuntime(makeConfig(dir));
    const result = await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      allMessages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Start with text" },
      ],
      messages: [{ role: "user", content: "Start with text" }],
      tools: {},
      maxSteps: 1,
      registerSteerHandler: (handler) => {
        steerHandler = handler;
        queueMicrotask(() => {
          void handler({
            text: "inspect this steer image",
            expectedTurnId: "cowork-turn-1",
            content: [
              { type: "text", text: "inspect this steer image" },
              {
                type: "image",
                mimeType: "image/png",
                data: "abc",
                detail: "high",
                filename: "steer.png",
              },
            ],
          });
        });
        return () => {
          if (steerHandler === handler) steerHandler = undefined;
        };
      },
    });

    expect(result.text).toBe("hello from app-server");
    const requests = await readCapturedRequests(capturePath);
    const steerParams = requests.find((entry) => entry.method === "turn/steer")?.params;
    expect(steerParams).toMatchObject({
      threadId: "thread_1",
      expectedTurnId: "turn_1",
    });
    expect(steerParams?.input).toEqual([
      { type: "text", text: "inspect this steer image", text_elements: [] },
      { type: "image", detail: "high", url: "data:image/png;base64,abc" },
    ]);
    expect(steerHandler).toBeUndefined();
  });

  test.serial("refreshes dynamic tools and only sends latest user input on resume", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-resume-"));
    const capturePath = path.join(dir, "requests.jsonl");
    process.env.CODEX_APP_SERVER_CAPTURE_PATH = capturePath;
    const latestContent = [
      { type: "text", text: "Newest question" },
      {
        type: "file",
        mimeType: "image/png",
        path: "/tmp/resumed-upload.png",
        detail: "original",
        filename: "resumed-upload.png",
      },
    ];

    const runtime = createRuntime(makeConfig(dir));
    await runtime.runTurn({
      config: makeConfig(dir),
      system: "You are Codex.",
      allMessages: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: latestContent },
      ],
      messages: [{ role: "user", content: latestContent }],
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
    expect(resumeParams?.developerInstructions).toContain(
      "Never call the native `request_user_input` tool",
    );
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
      (resumeParams?.dynamicTools as Array<{ name?: string }> | undefined)?.map(
        (tool) => tool.name,
      ),
    ).not.toContain("bash");
    expect(requests.find((entry) => entry.method === "turn/start")?.params?.input).toEqual([
      { type: "text", text: "Newest question", text_elements: [] },
      { type: "localImage", path: "/tmp/resumed-upload.png", detail: "original" },
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
    const freshThreadParams = requests.find((entry) => entry.method === "thread/start")?.params;
    expect(freshThreadParams).not.toHaveProperty("baseInstructions");
    expect(freshThreadParams?.developerInstructions).toContain(
      "Never call the native `request_user_input` tool",
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

  test("normalizes provider-style image aliases into app-server input parts", () => {
    expect(
      buildCodexTurnInput(
        [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "https://example.test/chart.png",
                detail: "low",
              },
              {
                type: "inputImage",
                imageUrl: "https://example.test/photo.jpg",
                detail: "high",
              },
              {
                type: "local_image",
                path: "/tmp/local-screenshot.png",
                detail: "original",
              },
              {
                type: "file",
                mime_type: "image/webp",
                data: "webp-data",
              },
            ],
          },
        ],
        { resumedThread: false },
      ),
    ).toEqual([
      { type: "text", text: "User: [attachment]", text_elements: [] },
      { type: "image", url: "https://example.test/chart.png", detail: "low" },
      { type: "image", url: "https://example.test/photo.jpg", detail: "high" },
      { type: "localImage", path: "/tmp/local-screenshot.png", detail: "original" },
      { type: "image", url: "data:image/webp;base64,webp-data" },
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

  test.serial("does not settle a pending turn/start from abort alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-abort-alone-"));
    const controller = new AbortController();
    const controlled = createControlledCodexTurnClient();
    let turnPromise: Promise<unknown> | undefined;

    codexAppServerClientInternal.setClientFactoryForTests(async () => controlled.client);

    try {
      const runtime = createRuntime(makeConfig(dir));
      turnPromise = runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Wait" }],
        tools: {},
        maxSteps: 1,
        abortSignal: controller.signal,
      });

      await controlled.turnStartEntered;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controlled.interruptCalls).toEqual([{ threadId: "thread_1" }]);

      const abortOnlyOutcome = await Promise.race([
        turnPromise.then(
          () => "resolved",
          (error) => (error instanceof Error ? error.message : String(error)),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      expect(abortOnlyOutcome).toBe("pending");

      controlled.emitNotification({
        method: "turn/completed",
        params: {
          threadId: "thread_1",
          turn: {
            id: "turn_cancelled",
            threadId: "thread_1",
            status: "cancelled",
            items: [],
            error: null,
          },
        },
      });

      await expect(turnPromise).rejects.toThrow("Cancelled by user");
    } finally {
      controlled.rejectTurnStart(new Error("late start rejection after abort"));
      await turnPromise?.catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  for (const mode of [
    { label: "ordinary", params: {} },
    { label: "yolo danger-full-access", params: { yolo: true, shellPolicy: "full" as const } },
  ]) {
    test.serial(
      `settles ${mode.label} cancellation from a matching provider terminal while turn/start is pending`,
      async () => {
        const dir = await fs.mkdtemp(
          path.join(os.tmpdir(), `cowork-codex-start-pending-${mode.label.replaceAll(" ", "-")}-`),
        );
        const controller = new AbortController();
        const controlled = createControlledCodexTurnClient();
        let turnPromise: Promise<unknown> | undefined;

        codexAppServerClientInternal.setClientFactoryForTests(async () => controlled.client);

        try {
          const runtime = createRuntime(makeConfig(dir));
          turnPromise = runtime.runTurn({
            config: makeConfig(dir),
            system: "You are Codex.",
            messages: [{ role: "user", content: "Wait" }],
            tools: {},
            maxSteps: 1,
            abortSignal: controller.signal,
            ...mode.params,
          });

          await controlled.turnStartEntered;
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(controlled.interruptCalls).toEqual([{ threadId: "thread_1" }]);

          controlled.emitNotification({
            method: "turn/completed",
            params: {
              threadId: "thread_1",
              turn: {
                id: "turn_cancelled",
                threadId: "thread_1",
                status: "cancelled",
                items: [],
                error: null,
              },
            },
          });

          const outcome = await Promise.race([
            turnPromise.then(
              () => "resolved",
              (error) => (error instanceof Error ? error.message : String(error)),
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
          ]);

          expect(outcome).toContain("Cancelled by user");
        } finally {
          controlled.rejectTurnStart(new Error("late start rejection after terminal settlement"));
          await turnPromise?.catch(() => {});
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    );
  }

  test.serial("ignores wrong-thread terminal notifications before turn/start ack", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-preack-thread-match-"));
    const controlled = createControlledCodexTurnClient();
    let turnPromise: Promise<unknown> | undefined;

    codexAppServerClientInternal.setClientFactoryForTests(async () => controlled.client);

    try {
      const runtime = createRuntime(makeConfig(dir));
      turnPromise = runtime.runTurn({
        config: makeConfig(dir),
        system: "You are Codex.",
        messages: [{ role: "user", content: "Wait" }],
        tools: {},
        maxSteps: 1,
      });

      await controlled.turnStartEntered;
      controlled.emitNotification({
        method: "turn/completed",
        params: {
          threadId: "thread_other",
          turn: {
            id: "turn_wrong",
            threadId: "thread_other",
            status: "completed",
            items: [{ type: "agentMessage", id: "wrong", text: "wrong thread" }],
            error: null,
          },
        },
      });

      const ignoredOutcome = await Promise.race([
        turnPromise.then(
          () => "resolved",
          (error) => (error instanceof Error ? error.message : String(error)),
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      expect(ignoredOutcome).toBe("pending");

      controlled.emitNotification({
        method: "turn/completed",
        params: {
          threadId: "thread_1",
          turn: {
            id: "turn_matched",
            threadId: "thread_1",
            status: "completed",
            items: [{ type: "agentMessage", id: "matched", text: "matched before ack" }],
            error: null,
          },
        },
      });

      await expect(turnPromise).resolves.toMatchObject({ text: "matched before ack" });
    } finally {
      controlled.rejectTurnStart(new Error("late ignored start rejection"));
      await turnPromise?.catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test.serial(
    "settles a threadId-less turn/completed routed before the turn/start ack",
    async () => {
      const dir = await fs.mkdtemp(
        path.join(scratchRoots()[0] ?? "/tmp", "cowork-codex-preack-threadless-"),
      );
      const controlled = createControlledCodexTurnClient();
      let turnPromise: Promise<unknown> | undefined;

      codexAppServerClientInternal.setClientFactoryForTests(async () => controlled.client);

      try {
        const runtime = createRuntime(makeConfig(dir));
        turnPromise = runtime.runTurn({
          config: makeConfig(dir),
          system: "You are Codex.",
          messages: [{ role: "user", content: "Wait" }],
          tools: {},
          maxSteps: 1,
        });

        // The turn/start response and turn/completed notification can coalesce
        // into one stdout chunk, so the completion routes while the turn id is
        // still unknown. A payload that omits threadId must settle the turn
        // rather than being dropped and stranding it until the completion
        // timeout.
        await controlled.turnStartEntered;
        controlled.emitNotification({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn_threadless",
              status: "completed",
              items: [{ type: "agentMessage", id: "threadless", text: "threadless before ack" }],
              error: null,
            },
          },
        });

        await expect(turnPromise).resolves.toMatchObject({ text: "threadless before ack" });
      } finally {
        controlled.resolveTurnStart();
        await turnPromise?.catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.serial(
    "accepts a matching provider completion before start ack and observes a late start rejection",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-preack-complete-"));
      const controlled = createControlledCodexTurnClient();
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (error: unknown) => {
        unhandledRejections.push(error);
      };
      let turnPromise: Promise<unknown> | undefined;

      process.on("unhandledRejection", onUnhandledRejection);
      codexAppServerClientInternal.setClientFactoryForTests(async () => controlled.client);

      try {
        const runtime = createRuntime(makeConfig(dir));
        turnPromise = runtime.runTurn({
          config: makeConfig(dir),
          system: "You are Codex.",
          messages: [{ role: "user", content: "Wait" }],
          tools: {},
          maxSteps: 1,
        });

        await controlled.turnStartEntered;
        controlled.emitNotification({
          method: "turn/completed",
          params: {
            threadId: "thread_1",
            turn: {
              id: "turn_pre_ack",
              threadId: "thread_1",
              status: "completed",
              items: [{ type: "agentMessage", id: "pre_ack", text: "pre ack complete" }],
              error: null,
            },
          },
        });

        await expect(turnPromise).resolves.toMatchObject({ text: "pre ack complete" });
        controlled.rejectTurnStart(new Error("late turn/start failure"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        controlled.resolveTurnStart();
        await turnPromise?.catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.serial(
    "drops stateful todo notifications after abort while waiting for completion",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-app-server-late-todo-"));
      process.env.CODEX_APP_SERVER_DELAY_COMPLETION = "1";
      process.env.COWORK_CODEX_APP_SERVER_ARGS = "late-todo-after-abort";
      const controller = new AbortController();
      const todos: unknown[] = [];
      const runtime = createRuntime(makeConfig(dir));

      await expect(
        runtime.runTurn({
          config: makeConfig(dir),
          system: "You are Codex.",
          messages: [{ role: "user", content: "Wait" }],
          tools: {},
          maxSteps: 1,
          abortSignal: controller.signal,
          updateTodos: (nextTodos) => todos.push(nextTodos),
          onModelRawEvent: (event) => {
            const message = event.event.message as { method?: string } | undefined;
            if (message?.method === "turn/start") setTimeout(() => controller.abort(), 0);
          },
        }),
      ).rejects.toThrow("Cancelled by user");

      expect(mockInterrupts).toEqual([{ threadId: "thread_1", turnId: "turn_1" }]);
      expect(todos).toEqual([]);
    },
  );

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
        type: "tool-error",
        toolName: "spawnAgent",
        error: 'Dynamic tool "spawnAgent" failed: briefing is required when contextMode is "brief"',
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
