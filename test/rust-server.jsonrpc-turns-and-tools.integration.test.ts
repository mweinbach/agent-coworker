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
  }, 30_000);

  // `cowork/provider/status/refresh` probes the local LM Studio endpoint for real. On Windows a
  // refused loopback connect takes ~2s (TCP SYN retries), which with server startup can exceed
  // bun's 5s default on slow runners, so give this route sweep an explicit budget.
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
  }, 30_000);

  test('disables tools for a single turn with tools: "none", refuses hallucinated tool calls, and restores tools on the next turn', async () => {
    const recordedBodies: Array<Record<string, unknown>> = [];
    const writeFunctionCallEvents = (
      respId: string,
      callId: string,
      targetPath: string,
      content: string,
    ) => {
      const callArgs = JSON.stringify({ path: targetPath, content });
      return [
        { type: "response.created", response: { id: respId } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: `fc_${callId}`,
            type: "function_call",
            call_id: callId,
            name: "write",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: `fc_${callId}`,
          delta: callArgs,
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: `fc_${callId}`,
            type: "function_call",
            call_id: callId,
            name: "write",
            arguments: callArgs,
          },
        },
        {
          type: "response.completed",
          response: {
            id: respId,
            status: "completed",
            usage: { input_tokens: 15, output_tokens: 10, total_tokens: 25 },
          },
        },
      ];
    };
    const writeTextEvents = (respId: string, text: string) => [
      { type: "response.created", response: { id: respId } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: `msg_${respId}`, type: "message", role: "assistant", content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: `msg_${respId}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: respId,
          status: "completed",
          usage: { input_tokens: 18, output_tokens: 8, total_tokens: 26 },
        },
      },
    ];

    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        if (body.model !== "gpt-5.4") {
          for (const evt of writeTextEvents("resp_bg_title", "Tools None Thread")) {
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
          }
          res.end();
          return;
        }
        const stepIdx = recordedBodies.push(body);

        // Turn 1 (normal tools): step 1 writes turn1.txt, step 2 completes.
        // Turn 2 (tools: "none"): step 3 hallucinates a write to forbidden.txt, step 4 completes.
        // Turn 3 (normal tools restored): step 5 writes turn3.txt, step 6 completes.
        const events =
          stepIdx === 1
            ? writeFunctionCallEvents("resp_t1_1", "call_t1", "turn1.txt", "turn 1 ok\n")
            : stepIdx === 2
              ? writeTextEvents("resp_t1_2", "Turn 1 complete.")
              : stepIdx === 3
                ? writeFunctionCallEvents(
                    "resp_t2_1",
                    "call_t2_forbidden",
                    "forbidden.txt",
                    "should not run\n",
                  )
                : stepIdx === 4
                  ? writeTextEvents("resp_t2_2", "Turn 2 repaired without tools.")
                  : stepIdx === 5
                    ? writeFunctionCallEvents("resp_t3_1", "call_t3", "turn3.txt", "turn 3 ok\n")
                    : writeTextEvents("resp_t3_2", "Turn 3 complete.");
        for (const evt of events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        res.end();
      });
    });

    await new Promise<void>((r) => mockServer.listen(0, "127.0.0.1", () => r()));
    const port = (mockServer.address() as { port: number }).port;
    const srv = await startRustTestServer({
      yolo: true,
      env: {
        OPENAI_API_KEY: "sk-test-tools-none",
        OPENAI_BASE_URL: `http://127.0.0.1:${String(port)}/v1`,
        AGENT_PROVIDER: "openai",
        AGENT_MODEL: "gpt-5.4",
      },
    });

    try {
      const rpc = await connectRustJsonRpc(srv.wsUrl, { toolRetryLineage: true });
      const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
        cwd: srv.workspaceDir,
        provider: "openai",
        model: "gpt-5.4",
      });
      const threadId = started.thread.id;

      // Reject invalid tools value and retry + tools: "none" combination with -32602.
      const invalidMode = await rpc.requestRaw("turn/start", {
        threadId,
        input: "bad mode",
        tools: "all",
      });
      expect(invalidMode.error?.code).toBe(-32602);

      const retryCombo = await rpc.requestRaw("turn/start", {
        threadId,
        input: "retry with tools disabled",
        tools: "none",
        retry: { toolItemIds: ["item-1"] },
      });
      expect(retryCombo.error?.code).toBe(-32602);

      // Turn 1: tools enabled by default.
      const t1 = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        clientMessageId: "msg-turn-1",
        input: [{ type: "text", text: "Write turn1.txt" }],
      });
      await rpc.waitForNotification(
        (m) => m.method === "turn/completed" && m.params?.turn?.id === t1.turn.id,
      );
      expect(await fs.readFile(path.join(srv.workspaceDir, "turn1.txt"), "utf8")).toBe(
        "turn 1 ok\n",
      );
      const turn1Tools = recordedBodies[0]?.tools;
      expect(Array.isArray(turn1Tools)).toBe(true);
      expect(Array.isArray(turn1Tools) ? turn1Tools.length : 0).toBeGreaterThan(0);

      // Turn 2: tools: "none" on the same thread.
      const t2 = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        clientMessageId: "msg-turn-2",
        input: [{ type: "text", text: "Answer without tools" }],
        tools: "none",
      });
      const t2Done = await rpc.waitForNotification(
        (m) => m.method === "turn/completed" && m.params?.turn?.id === t2.turn.id,
      );
      expect(t2Done.params.turn.status).toBe("completed");

      const forbiddenExists = await fs
        .stat(path.join(srv.workspaceDir, "forbidden.txt"))
        .then(() => true)
        .catch(() => false);
      expect(forbiddenExists).toBe(false);

      const turn2Step1 = recordedBodies[2] ?? {};
      const turn2Step2 = recordedBodies[3] ?? {};
      expect(turn2Step1.tools ?? []).toEqual([]);
      expect(turn2Step1.previous_response_id).toBeUndefined();
      expect(JSON.stringify(turn2Step2.input)).toContain("disabled for this turn");

      // Idempotency: exact replay of msg-turn-2 with tools: "none" replays; omitting tools conflicts.
      const replayed = await rpc.request<{ replayed?: boolean; turn: { id: string } }>(
        "turn/start",
        {
          threadId,
          clientMessageId: "msg-turn-2",
          input: [{ type: "text", text: "Answer without tools" }],
          tools: "none",
        },
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.turn.id).toBe(t2.turn.id);

      const conflict = await rpc.requestRaw("turn/start", {
        threadId,
        clientMessageId: "msg-turn-2",
        input: [{ type: "text", text: "Answer without tools" }],
      });
      expect(conflict.error?.code).toBe(-32600);

      // Turn 3: omitting tools restores full tool availability on the same thread.
      const t3 = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        clientMessageId: "msg-turn-3",
        input: [{ type: "text", text: "Write turn3.txt" }],
      });
      await rpc.waitForNotification(
        (m) => m.method === "turn/completed" && m.params?.turn?.id === t3.turn.id,
      );
      expect(await fs.readFile(path.join(srv.workspaceDir, "turn3.txt"), "utf8")).toBe(
        "turn 3 ok\n",
      );
      const turn3Tools = recordedBodies[4]?.tools;
      expect(Array.isArray(turn3Tools)).toBe(true);
      expect(Array.isArray(turn3Tools) ? turn3Tools.length : 0).toBeGreaterThan(0);

      rpc.close();
    } finally {
      await srv.stop();
      await new Promise<void>((r) => mockServer.close(() => r()));
    }
  }, 30_000);
});
