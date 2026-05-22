import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { jsonRpcThreadTurnRequestSchemas } from "../../src/server/jsonrpc/schema.threadTurn";
import { startAgentServer } from "../../src/server/startServer";
import {
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
} from "../../src/shared/attachments";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import {
  connectJsonRpc,
  JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  JSONRPC_REPLAY_WAIT_TIMEOUT_MS,
} from "./flow.harness";

describe("server JSON-RPC flows", () => {
  test("turn/start streams turn and item notifications", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => ({
          text: "streamed reply",
          responseMessages: [],
        })) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnResponse = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        clientMessageId: "msg-1",
        input: [{ type: "text", text: "hello there" }],
      });
      expect(turnResponse.result.turn.threadId).toBe(started.result.thread.id);
      expect(turnResponse.result.turn.id).toBeTruthy();
      expect(turnResponse.result.turn.status).toBe("inProgress");

      const turnStarted = await rpc.waitFor((message) => message.method === "turn/started");
      const userItemStarted = await rpc.waitFor(
        (message) =>
          message.method === "item/started" && message.params.item.type === "userMessage",
      );
      const agentDelta = await rpc.waitFor(
        (message) => message.method === "item/agentMessage/delta",
      );
      const agentCompleted = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      const turnCompleted = await rpc.waitFor((message) => message.method === "turn/completed");

      expect(turnStarted.params.threadId).toBe(started.result.thread.id);
      expect(turnStarted.params.turn.id).toBe(turnResponse.result.turn.id);
      expect(userItemStarted.params.item.content[0].text).toBe("hello there");
      expect(userItemStarted.params.item.clientMessageId).toBe("msg-1");
      expect(agentDelta.params.delta).toBe("streamed reply");
      expect(agentCompleted.params.item.text).toBe("streamed reply");
      expect(turnCompleted.params.turn.status).toBe("completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/start still loads a real system prompt when preloadSystemPrompt is disabled", async () => {
    const tmpDir = await makeTmpProject();
    let capturedSystem = "";
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        preloadSystemPrompt: false,
        runTurnImpl: (async (params: any) => {
          capturedSystem = params.system;
          return {
            text: "lazy prompt reply",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "hello lazy system" }],
      });
      await rpc.waitFor((message) => message.method === "turn/completed");

      expect(capturedSystem.length).toBeGreaterThan(10);
      expect(capturedSystem).toContain("## Available Skills");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/start accepts legacy string input payloads", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => ({
          text: "streamed reply",
          responseMessages: [],
        })) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnResponse = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        clientMessageId: "msg-legacy-1",
        input: "hello there",
      });
      expect(turnResponse.result.turn.threadId).toBe(started.result.thread.id);

      await rpc.waitFor((message) => message.method === "turn/started");
      const userItemStarted = await rpc.waitFor(
        (message) =>
          message.method === "item/started" && message.params.item.type === "userMessage",
      );
      expect(userItemStarted.params.item.content[0].text).toBe("hello there");
      expect(userItemStarted.params.item.clientMessageId).toBe("msg-legacy-1");

      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/start request schema rejects oversized inline attachment payloads", () => {
    const parsed = jsonRpcThreadTurnRequestSchemas["turn/start"].safeParse({
      threadId: "thread-1",
      input: [
        {
          type: "file",
          filename: "large.bin",
          contentBase64: "a".repeat(MAX_ATTACHMENT_BASE64_SIZE + 1),
          mimeType: "application/octet-stream",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  test("turn/start request schema rejects aggregate inline attachment payloads", () => {
    const chunk = Math.floor(MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE / 3);
    const totalOverflow = MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE - chunk * 2 + 1;
    const parsed = jsonRpcThreadTurnRequestSchemas["turn/start"].safeParse({
      threadId: "thread-1",
      input: [
        {
          type: "file",
          filename: "first.bin",
          contentBase64: "a".repeat(chunk),
          mimeType: "application/octet-stream",
        },
        {
          type: "file",
          filename: "second.bin",
          contentBase64: "b".repeat(chunk),
          mimeType: "application/octet-stream",
        },
        {
          type: "file",
          filename: "overflow.bin",
          contentBase64: "c".repeat(totalOverflow),
          mimeType: "application/octet-stream",
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("Inline attachments too large in total");
    }
  });

  test("turn/start accepts uploaded file path parts after workspace upload", async () => {
    const tmpDir = await makeTmpProject();
    let lastMessages: any[] = [];
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          lastMessages = params.messages;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const uploadResponse = await rpc.sendRequest("cowork/session/file/upload", {
        cwd: tmpDir,
        filename: "large.bin",
        contentBase64: Buffer.from("uploaded over control route").toString("base64"),
      });
      const uploadedPath = uploadResponse.result.event.path as string;

      await expect(fs.readFile(uploadedPath, "utf8")).resolves.toBe("uploaded over control route");

      const turnResponse = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [
          {
            type: "uploadedFile",
            filename: "large.bin",
            path: uploadedPath,
            mimeType: "application/octet-stream",
          },
        ],
      });

      expect(turnResponse.result.turn.threadId).toBe(started.result.thread.id);
      await rpc.waitFor((message) => message.method === "turn/started");
      await rpc.waitFor((message) => message.method === "turn/completed");
      expect(lastMessages.at(-1)?.content).toContainEqual({
        type: "text",
        text: `[System: The user uploaded a file which has been saved to ${uploadedPath}]`,
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/start rejects uploaded file paths outside the uploads directory before starting the turn", async () => {
    const tmpDir = await makeTmpProject();
    let runTurnCalled = false;
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          runTurnCalled = true;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnResponse = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [
          {
            type: "uploadedFile",
            filename: "outside.txt",
            path: `${tmpDir}/outside.txt`,
            mimeType: "text/plain",
          },
        ],
      });

      expect(turnResponse.error?.message).toBe(
        "Uploaded file path is outside the uploads directory.",
      );
      expect(turnResponse.result).toBeUndefined();
      expect(runTurnCalled).toBe(false);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/start rejects uploaded file paths that escape the uploads directory via symlinks", async () => {
    const tmpDir = await makeTmpProject();
    let runTurnCalled = false;
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          runTurnCalled = true;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const uploadsDir = path.join(tmpDir, "User Uploads");
      const outsideDir = path.join(tmpDir, "outside");
      const outsideFile = path.join(outsideDir, "secret.pdf");
      const linkedDir = path.join(uploadsDir, "linked");
      const escapedPath = path.join(linkedDir, "secret.pdf");

      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "top secret");
      await fs.symlink(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");

      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnResponse = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [
          {
            type: "uploadedFile",
            filename: "secret.pdf",
            path: escapedPath,
            mimeType: "application/pdf",
          },
        ],
      });

      expect(turnResponse.error?.message).toBe(
        "Uploaded file path is outside the uploads directory.",
      );
      expect(turnResponse.result).toBeUndefined();
      expect(runTurnCalled).toBe(false);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/start streams reasoning notifications before assistant output", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          await params.onModelStreamPart?.({ type: "start" });
          await params.onModelStreamPart?.({
            type: "reasoning-start",
            id: "rs_live",
            mode: "summary",
          });
          await params.onModelStreamPart?.({
            type: "reasoning-delta",
            id: "rs_live",
            text: "Inspecting the reports.",
          });
          await params.onModelStreamPart?.({
            type: "reasoning-end",
            id: "rs_live",
            mode: "summary",
          });
          await params.onModelStreamPart?.({
            type: "text-delta",
            id: "txt_live",
            text: "Final answer",
          });
          await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
          return {
            text: "Final answer",
            reasoningText: "Inspecting the reports.",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnResponse = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        clientMessageId: "msg-reasoning-1",
        input: [{ type: "text", text: "hello there" }],
      });
      expect(turnResponse.result.turn.threadId).toBe(started.result.thread.id);

      await rpc.waitFor((message) => message.method === "turn/started");
      await rpc.waitFor(
        (message) =>
          message.method === "item/started" && message.params.item.type === "userMessage",
      );
      const reasoningStarted = await rpc.waitFor(
        (message) => message.method === "item/started" && message.params.item.type === "reasoning",
      );
      const reasoningDelta = await rpc.waitFor(
        (message) => message.method === "item/reasoning/delta",
      );
      const reasoningCompleted = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "reasoning",
      );
      const agentDelta = await rpc.waitFor(
        (message) => message.method === "item/agentMessage/delta",
      );
      const agentCompleted = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      const turnCompleted = await rpc.waitFor((message) => message.method === "turn/completed");

      expect(reasoningStarted.params.item).toMatchObject({
        type: "reasoning",
        mode: "reasoning",
        text: "",
      });
      expect(reasoningDelta.params).toMatchObject({
        threadId: started.result.thread.id,
        turnId: turnResponse.result.turn.id,
        mode: "reasoning",
        delta: "Inspecting the reports.",
      });
      expect(reasoningDelta.params.itemId).toBe(reasoningStarted.params.item.id);
      expect(reasoningCompleted.params.item).toMatchObject({
        id: reasoningStarted.params.item.id,
        type: "reasoning",
        mode: "reasoning",
        text: "Inspecting the reports.",
      });
      expect(agentDelta.params.delta).toBe("Final answer");
      expect(agentCompleted.params.item.text).toBe("Final answer");
      expect(turnCompleted.params.turn.status).toBe("completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
