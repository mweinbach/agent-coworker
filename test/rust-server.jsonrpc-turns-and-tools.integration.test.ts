import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { connectRustJsonRpc, startRustTestServer } from "./helpers/rustServerHarness";

describe("Rust cowork-server JSON-RPC thread lifecycle, streaming turns, tools, and persistence", () => {
  test("streams turn/start, executes write tool, and cold-rehydrates thread across server restart", async () => {
    let callIndex = 0;
    const mockServer = http.createServer((_req, res) => {
      callIndex += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (callIndex === 1) {
        const callArgs = JSON.stringify({
          path: "created-by-tool.txt",
          content: "written via rust tool loop\n",
        });
        const events = [
          { type: "response.created", response: { id: "resp_tool_1" } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_write_1",
              name: "write",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_1",
            delta: callArgs,
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_write_1",
              name: "write",
              arguments: callArgs,
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_tool_1",
              status: "completed",
              usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35 },
            },
          },
        ];
        for (const evt of events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        res.end();
        return;
      }

      const events = [
        { type: "response.created", response: { id: "resp_final_2" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "msg_final", type: "message", role: "assistant", content: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "File written successfully.",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "msg_final",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "File written successfully." }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_final_2",
            status: "completed",
            usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
          },
        },
      ];
      for (const evt of events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
      res.end();
    });

    await new Promise<void>((r) => mockServer.listen(0, "127.0.0.1", () => r()));
    const port = (mockServer.address() as { port: number }).port;
    const baseEnv = {
      OPENAI_API_KEY: "sk-test-rust-wire",
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      AGENT_PROVIDER: "openai",
      AGENT_MODEL: "gpt-5.4",
    };

    const srv1 = await startRustTestServer({ yolo: true, env: baseEnv });
    const sharedHome = srv1.homeDir;
    const sharedWorkspace = srv1.workspaceDir;
    let threadId = "";

    try {
      const rpc = await connectRustJsonRpc(srv1.wsUrl);
      const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
        cwd: sharedWorkspace,
        provider: "openai",
        model: "gpt-5.4",
      });
      threadId = started.thread.id;

      await rpc.request("turn/start", {
        threadId,
        clientMessageId: "turn-msg-1",
        input: [{ type: "text", text: "Create created-by-tool.txt" }],
      });

      const completed = await rpc.waitForNotification(
        (m) => m.method === "turn/completed" && m.params?.threadId === threadId,
      );
      expect(completed.params.turn.status).toBe("completed");

      const written = await fs.readFile(path.join(sharedWorkspace, "created-by-tool.txt"), "utf8");
      expect(written).toBe("written via rust tool loop\n");

      // Rename & pin thread before stopping server 1
      await rpc.request("cowork/session/title/set", {
        threadId,
        title: "Persisted Wire Thread",
      });
      await rpc.request("thread/pinned/set", { threadId, pinned: true });
      rpc.close();
    } finally {
      srv1.proc.stdin?.end();
      await srv1.proc.exited;
    }

    // Cold-rehydrate on a brand-new cowork-server process sharing HOME & workspaceDir!
    const srv2 = await startRustTestServer({
      homeDir: sharedHome,
      workspaceDir: sharedWorkspace,
      yolo: true,
      env: baseEnv,
    });
    try {
      const rpc2 = await connectRustJsonRpc(srv2.wsUrl);
      const list = await rpc2.request<{
        threads: Array<{ id: string; title: string; pinned: boolean; messageCount: number }>;
      }>("thread/list", { cwd: sharedWorkspace });
      const found = list.threads.find((t) => t.id === threadId);
      expect(found).toBeDefined();
      expect(found?.title).toBe("Persisted Wire Thread");
      expect(found?.pinned).toBe(true);
      expect(found!.messageCount).toBeGreaterThanOrEqual(2);

      const read = await rpc2.request<{ thread: { id: string; turns?: unknown[] } }>(
        "thread/read",
        { threadId, includeTurns: true },
      );
      expect(read.thread.id).toBe(threadId);
      expect((read.thread.turns ?? []).length).toBeGreaterThanOrEqual(1);

      await rpc2.request("thread/archived/set", { threadId, archived: true });
      const afterArchive = await rpc2.request<{
        threads: Array<{ id: string; archived?: boolean }>;
      }>("thread/list", {
        cwd: sharedWorkspace,
      });
      const archivedEntry = afterArchive.threads.find((t) => t.id === threadId);
      expect(archivedEntry === undefined || archivedEntry.archived === true).toBe(true);

      await rpc2.request("thread/archived/set", { threadId, archived: false });
      const afterUnarchive = await rpc2.request<{
        threads: Array<{ id: string; archived?: boolean }>;
      }>("thread/list", {
        cwd: sharedWorkspace,
      });
      const unarchivedEntry = afterUnarchive.threads.find((t) => t.id === threadId);
      expect(unarchivedEntry).toBeDefined();
      expect(unarchivedEntry?.archived).toBe(false);
      rpc2.close();
    } finally {
      await srv2.stop();
      await fs.rm(path.dirname(sharedHome), { recursive: true, force: true });
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  });

  test("serves cowork/session/*, cowork/provider/*, and durable task/* routes", async () => {
    const srv = await startRustTestServer({
      env: {
        COWORK_ENABLE_TASKS: "1",
        OPENAI_API_KEY: "sk-test-provider-status",
      },
    });
    try {
      const rpc = await connectRustJsonRpc(srv.wsUrl);
      const state = await rpc.request("cowork/session/state/read", { cwd: srv.workspaceDir });
      expect(state).toBeDefined();

      const providers = await rpc.request<{
        event?: { providers?: Array<{ provider: string }> };
        providers?: Array<{ provider: string }>;
      }>("cowork/provider/status/refresh", { cwd: srv.workspaceDir });
      const providerList = providers.event?.providers ?? providers.providers ?? [];
      expect(providerList.some((p) => p.provider === "openai")).toBe(true);

      const catalog = await rpc.request("cowork/provider/catalog/read", {
        cwd: srv.workspaceDir,
        refresh: false,
      });
      expect(catalog).toBeDefined();

      const authMethods = await rpc.request("cowork/provider/authMethods/read", {
        cwd: srv.workspaceDir,
      });
      expect(authMethods).toBeDefined();

      const tasksList = await rpc.request<{ tasks: unknown[] }>("task/list", {
        cwd: srv.workspaceDir,
      });
      expect(Array.isArray(tasksList.tasks)).toBe(true);

      rpc.close();
    } finally {
      await srv.stop();
    }
  });
});
