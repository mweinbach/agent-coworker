import { describe, expect, test } from "bun:test";

import { startAgentServer } from "../src/server/startServer";
import { makeTmpProject, serverOpts } from "./helpers/wsHarness";

async function connectJsonRpc(url: string) {
  const ws = new WebSocket(`${url}?protocol=jsonrpc`);
  const queue: any[] = [];
  const waiters = new Set<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
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

  const waitFor = async (predicate: (message: any) => boolean, timeoutMs = 5_000) => {
    const existingIndex = queue.findIndex(predicate);
    if (existingIndex >= 0) {
      return queue.splice(existingIndex, 1)[0];
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Timed out waiting for JSON-RPC message"));
      }, timeoutMs);
      const waiter = { predicate, resolve, reject, timer };
      waiters.add(waiter);
    });
  };

  let nextId = 0;
  const request = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((message) => message.id === id);
  };

  await request("initialize", {
    clientInfo: {
      name: "jsonrpc-control-test",
    },
  });
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    ws,
    request,
    close: () => ws.close(),
  };
}

describe("server JSON-RPC control methods", () => {
  test("provider catalog read returns a legacy-compatible provider_catalog event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/catalog/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("provider_catalog");
      expect(Array.isArray(response.result.event.all)).toBe(true);
      expect(response.result.event.default.google).toBeDefined();
      rpc.close();
    } finally {
      server.stop();
    }
  });

  test("memory list returns a legacy-compatible memory_list event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/memory/list", {
        cwd: tmpDir,
      });

      expect(response.result.event).toEqual({
        type: "memory_list",
        sessionId: expect.any(String),
        memories: [],
      });
      rpc.close();
    } finally {
      server.stop();
    }
  });

  test("workspace backups read returns a legacy-compatible workspace_backups event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/backups/workspace/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("workspace_backups");
      expect(response.result.event.workspacePath).toBe(tmpDir);
      expect(Array.isArray(response.result.event.backups)).toBe(true);
      rpc.close();
    } finally {
      server.stop();
    }
  });
});
