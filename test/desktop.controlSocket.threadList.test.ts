import { describe, expect, test } from "bun:test";
import http from "node:http";

import { createControlSocketHelpers } from "../apps/desktop/src/app/store.helpers/controlSocket";
import {
  defaultThreadRuntime,
  defaultWorkspaceRuntime,
} from "../apps/desktop/src/app/store.helpers/runtimeState";
import { connectRustJsonRpc, startRustTestServer } from "./helpers/rustServerHarness";

async function startMockOpenAiResponsesServer(replyText: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const events = [
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: replyText,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: replyText }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
        },
      },
    ];
    for (const evt of events) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("desktop control socket thread list mapping", () => {
  test("uses thread/list wire counts instead of cached thread state", async () => {
    const mockOpenAi = await startMockOpenAiResponsesServer("streamed reply");
    const srv = await startRustTestServer({
      env: {
        OPENAI_API_KEY: "sk-test-control-socket",
        OPENAI_BASE_URL: mockOpenAi.baseUrl,
        AGENT_PROVIDER: "openai",
        AGENT_MODEL: "gpt-5.4",
      },
    });

    const workspaceId = "workspace-1";
    const helpers = createControlSocketHelpers({
      nowIso: () => new Date().toISOString(),
      makeId: () => crypto.randomUUID(),
      persist: () => {},
      pushNotification: (notifications) => notifications,
      isProviderName: (value: unknown): value is string => typeof value === "string",
    });

    try {
      const rpc = await connectRustJsonRpc(srv.wsUrl);
      const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
        cwd: srv.workspaceDir,
        provider: "openai",
        model: "gpt-5.4",
      });
      const threadId = started.thread.id;

      await rpc.request("turn/start", {
        threadId,
        clientMessageId: "msg-1",
        input: [{ type: "text", text: "hello there" }],
      });
      await rpc.waitForNotification(
        (msg) =>
          msg.method === "turn/completed" &&
          (msg.params as { threadId?: string } | undefined)?.threadId === threadId,
      );
      rpc.close();

      const staleMessageCount = 999;
      const staleLastEventSeq = 777;
      let state: any = {
        workspaces: [
          {
            id: workspaceId,
            path: srv.workspaceDir,
          },
        ],
        threads: [
          {
            id: threadId,
            workspaceId,
            title: "Stale title",
            titleSource: "manual",
            createdAt: new Date().toISOString(),
            lastMessageAt: new Date().toISOString(),
            status: "active",
            sessionId: threadId,
            messageCount: staleMessageCount,
            lastEventSeq: staleLastEventSeq,
            draft: false,
          },
        ],
        selectedWorkspaceId: workspaceId,
        selectedThreadId: threadId,
        workspaceRuntimeById: {
          [workspaceId]: {
            ...defaultWorkspaceRuntime(),
            serverUrl: srv.wsUrl,
          },
        },
        threadRuntimeById: {
          [threadId]: defaultThreadRuntime(),
        },
      };

      const get = () => state;
      const set = (updater: (current: any) => any) => {
        state = {
          ...state,
          ...updater(state),
        };
      };

      const sessions = await helpers.requestWorkspaceSessions(get as any, set as any, workspaceId);
      expect(sessions).not.toBeNull();
      expect(sessions?.[0]?.messageCount).toBeGreaterThan(0);
      expect(sessions?.[0]?.lastEventSeq).toBeGreaterThan(0);
      expect(sessions?.[0]?.messageCount).not.toBe(staleMessageCount);
      expect(sessions?.[0]?.lastEventSeq).not.toBe(staleLastEventSeq);
      expect(state.threads[0].messageCount).toBe(sessions?.[0]?.messageCount);
      expect(state.threads[0].lastEventSeq).toBe(sessions?.[0]?.lastEventSeq);
    } finally {
      helpers.disposeAllControlState();
      await srv.stop();
      await mockOpenAi.close();
    }
  });
});
