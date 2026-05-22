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
  test("one connection can start, list, and read multiple threads", async () => {
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

  test("thread/list defaults omitted cwd to the server working directory", async () => {
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

  test("workspace spreadsheet preview returns viewport data and rejects path escapes", async () => {
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
      const preview = await rpc.sendRequest("cowork/workspace/spreadsheet/preview", {
        cwd: tmpDir,
        path: csvPath,
        viewport: { rowCount: 5, colCount: 2 },
      });

      expect(preview.result.ok).toBe(true);
      expect(preview.result.preview.kind).toBe("csv");
      expect(preview.result.preview.viewport.rowCount).toBe(5);
      expect(preview.result.preview.viewport.truncatedRows).toBe(true);
      expect(preview.result.preview.cells[1][0].value).toBe("row 0");

      const outsideDir = await makeTmpProject("agent-harness-spreadsheet-outside-");
      const outsidePath = path.join(outsideDir, "outside.csv");
      await fs.writeFile(outsidePath, "a,b\n1,2\n", "utf8");
      const escaped = await rpc.sendRequest("cowork/workspace/spreadsheet/preview", {
        cwd: tmpDir,
        path: outsidePath,
      });
      expect(escaped.error.message).toContain("outside the workspace root");

      const linkPath = path.join(tmpDir, "linked.csv");
      try {
        await fs.symlink(outsidePath, linkPath);
        const linked = await rpc.sendRequest("cowork/workspace/spreadsheet/preview", {
          cwd: tmpDir,
          path: linkPath,
        });
        expect(linked.error.message).toContain("outside the workspace root");
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

  test("thread/list includes wire counts for live and persisted threads", async () => {
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
