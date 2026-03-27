import { describe, expect, test } from "bun:test";

import { createControlSocketHelpers } from "../apps/desktop/src/app/store.helpers/controlSocket";
import { defaultThreadRuntime, defaultWorkspaceRuntime } from "../apps/desktop/src/app/store.helpers/runtimeState";
import { startAgentServer } from "../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer } from "./helpers/wsHarness";

async function connectJsonRpc(url: string): Promise<{
  close: () => void;
  request: (method: string, params?: unknown) => Promise<any>;
  waitFor: (predicate: (message: any) => boolean) => Promise<any>;
}> {
  const ws = new WebSocket(`${url}?protocol=jsonrpc`);
  const queue: any[] = [];
  const waiters = new Set<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const resolveWaiters = (message: any) => {
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return true;
    }
    return false;
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    if (!resolveWaiters(message)) {
      queue.push(message);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket open")), 5_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });

  const waitFor = async (predicate: (message: any) => boolean) => {
    const existingIndex = queue.findIndex(predicate);
    if (existingIndex >= 0) {
      return queue.splice(existingIndex, 1)[0];
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Timed out waiting for JSON-RPC message"));
      }, 5_000);
      const waiter = { predicate, resolve, timer };
      waiters.add(waiter);
    });
  };

  let nextId = 0;
  const request = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((message) => message.id === id);
  };

  const initializeResponse = await request("initialize", {
    clientInfo: {
      name: "desktop-control-socket-test",
      version: "1.0.0",
    },
  });
  expect(initializeResponse.result.protocolVersion).toBe("0.1");
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    close: () => ws.close(),
    request,
    waitFor,
  };
}

describe("desktop control socket thread list mapping", () => {
  test("uses thread/list wire counts instead of cached thread state", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async () => ({
        text: "streamed reply",
        responseMessages: [],
      })) as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.request("thread/start", { cwd: tmpDir });
      const threadId = started.result.thread.id as string;

      await rpc.request("turn/start", {
        threadId,
        clientMessageId: "msg-1",
        input: [{ type: "text", text: "hello there" }],
      });
      await rpc.waitFor((message) => message.method === "turn/completed" && message.params.threadId === threadId);
      rpc.close();

      const workspaceId = "workspace-1";
      const staleMessageCount = 999;
      const staleLastEventSeq = 777;
      let state: any = {
        workspaces: [{
          id: workspaceId,
          path: tmpDir,
        }],
        threads: [{
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
        }],
        selectedWorkspaceId: workspaceId,
        selectedThreadId: threadId,
        workspaceRuntimeById: {
          [workspaceId]: {
            ...defaultWorkspaceRuntime(),
            serverUrl: url,
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

      const helpers = createControlSocketHelpers({
        nowIso: () => new Date().toISOString(),
        makeId: () => crypto.randomUUID(),
        persist: () => {},
        pushNotification: (notifications) => notifications,
        isProviderName: (value: unknown): value is string => typeof value === "string",
      });

      const sessions = await helpers.requestWorkspaceSessions(get as any, set as any, workspaceId);
      expect(sessions).not.toBeNull();
      expect(sessions?.[0]?.messageCount).toBeGreaterThan(0);
      expect(sessions?.[0]?.lastEventSeq).toBeGreaterThan(0);
      expect(sessions?.[0]?.messageCount).not.toBe(staleMessageCount);
      expect(sessions?.[0]?.lastEventSeq).not.toBe(staleLastEventSeq);
      expect(state.threads[0].messageCount).toBe(sessions?.[0]?.messageCount);
      expect(state.threads[0].lastEventSeq).toBe(sessions?.[0]?.lastEventSeq);
    } finally {
      await stopTestServer(server);
    }
  });
});
