import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { RunTurnParams } from "../../src/agent";
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
  test("thread/start applies explicit provider and model to the live session config", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const capturedConfigs: Array<{
      provider: RunTurnParams["config"]["provider"];
      model: string;
      runtime: RunTurnParams["config"]["runtime"];
    }> = [];
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_MODEL: "gemini-3-flash-preview",
        },
        runTurnImpl: async (params: RunTurnParams) => {
          capturedConfigs.push({
            provider: params.config.provider,
            model: params.config.model,
            runtime: params.config.runtime,
          });
          return {
            text: "provider-specific reply",
            responseMessages: [],
          };
        },
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", {
        cwd: tmpDir,
        provider: "openai",
        model: "gpt-5.4-mini",
      });
      await rpc.waitFor((message) => message.method === "thread/started");

      expect(started.result.thread.modelProvider).toBe("openai");
      expect(started.result.thread.model).toBe("gpt-5.4-mini");

      const turnResponse = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        clientMessageId: "msg-explicit-model",
        input: [{ type: "text", text: "use the selected model" }],
      });
      expect(turnResponse.result.turn.threadId).toBe(started.result.thread.id);
      await rpc.waitFor((message) => message.method === "turn/completed");

      expect(capturedConfigs).toEqual([
        {
          provider: "openai",
          model: "gpt-5.4-mini",
          runtime: "openai-responses",
        },
      ]);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("one connection can start, list, and read multiple threads", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const thread1 = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      const thread1Started = await rpc.waitFor((message) => message.method === "thread/started");
      const thread2 = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      const thread2Started = await rpc.waitFor((message) => message.method === "thread/started");
      const listed = await rpc.sendRequest("thread/list", { cwd: tmpDir });
      const read = await rpc.sendRequest("thread/read", {
        threadId: thread1.result.thread.id,
        includeTurns: true,
      });

      expect(thread1.result.thread.id).toBe(thread1Started.params.thread.id);
      expect(thread2.result.thread.id).toBe(thread2Started.params.thread.id);
      expect(listed.result.threads.map((thread: any) => thread.id)).toEqual(
        expect.arrayContaining([thread1.result.thread.id, thread2.result.thread.id]),
      );
      expect(read.result.thread.id).toBe(thread1.result.thread.id);
      expect(read.result.coworkSnapshot.sessionId).toBe(thread1.result.thread.id);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/list defaults omitted cwd to the server working directory", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const realTmpDir = await fs.realpath(tmpDir);
    const otherTmpDir = await makeTmpProject("agent-harness-other-");
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const localThread = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const otherThread = await rpc.sendRequest("thread/start", { cwd: otherTmpDir });
      expect(otherThread.error?.message).toContain(
        "thread/start cwd must match the server workspace",
      );
      expect(otherThread.result).toBeUndefined();

      const listed = await rpc.sendRequest("thread/list", {});

      expect(listed.result.threads.map((thread: any) => thread.id)).toContain(
        localThread.result.thread.id,
      );
      expect(listed.result.threads.every((thread: any) => thread.cwd === realTmpDir)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
      await Bun.$`rm -rf ${otherTmpDir}`.quiet();
    }
  });

  test("workspace spreadsheet workbook returns snapshot data and rejects path escapes", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const csvPath = path.join(tmpDir, "large.csv");
    const lines = ["name,value"];
    for (let i = 0; i < 240; i++) {
      lines.push(`row ${i},${i}`);
    }
    await fs.writeFile(csvPath, `${lines.join("\n")}\n`, "utf8");
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const preview = await rpc.sendRequest("cowork/workspace/spreadsheet/workbook", {
        cwd: tmpDir,
        path: csvPath,
      });

      expect(preview.result.ok).toBe(true);
      expect(preview.result.workbook.kind).toBe("csv");
      expect(preview.result.workbook.sheets[0].cells[2].value).toBe("row 0");

      const outsideDir = await makeTmpProject("agent-harness-spreadsheet-outside-");
      const outsidePath = path.join(outsideDir, "outside.csv");
      await fs.writeFile(outsidePath, "a,b\n1,2\n", "utf8");
      const escaped = await rpc.sendRequest("cowork/workspace/spreadsheet/workbook", {
        cwd: tmpDir,
        path: outsidePath,
      });
      expect(escaped.result.error.kind).toBe("outside_workspace");

      const linkPath = path.join(tmpDir, "linked.csv");
      try {
        await fs.symlink(outsidePath, linkPath);
        const linked = await rpc.sendRequest("cowork/workspace/spreadsheet/workbook", {
          cwd: tmpDir,
          path: linkPath,
        });
        expect(linked.result.error.kind).toBe("outside_workspace");
      } catch {
        // Symlink creation may be unavailable in some environments.
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/list includes wire counts for live and persisted threads", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    let threadId = "";
    const liveServer = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => ({
          text: "streamed reply",
          responseMessages: [],
        })) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(liveServer.url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      threadId = started.result.thread.id as string;

      await rpc.sendRequest("turn/start", {
        threadId,
        clientMessageId: "msg-1",
        input: [{ type: "text", text: "hello there" }],
      });
      await rpc.waitFor((message) => message.method === "turn/completed");

      const liveListed = await rpc.sendRequest("thread/list", { cwd: tmpDir });
      const liveThread = liveListed.result.threads.find((thread: any) => thread.id === threadId);
      expect(liveThread).toBeDefined();
      expect(liveThread.messageCount).toBeGreaterThan(0);
      expect(liveThread.lastEventSeq).toBeGreaterThan(0);

      rpc.close();
    } finally {
      await stopTestServer(liveServer.server);
    }

    const persistedServer = await startAgentServer(serverOpts(tmpDir));
    try {
      const rpc = await connectJsonRpc(persistedServer.url);
      const persistedListed = await rpc.sendRequest("thread/list", { cwd: tmpDir });
      const persistedThread = persistedListed.result.threads.find(
        (thread: any) => thread.id === threadId,
      );
      expect(persistedThread).toBeDefined();
      expect(persistedThread.status.type).toBe("notLoaded");
      expect(persistedThread.messageCount).toBeGreaterThan(0);
      expect(persistedThread.lastEventSeq).toBeGreaterThan(0);
      rpc.close();
    } finally {
      await stopTestServer(persistedServer.server);
    }
  });
});
