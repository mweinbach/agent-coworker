import { describe, expect, test } from "bun:test";

import { startAgentServer } from "../src/server/startServer";
import { makeTmpProject, serverOpts } from "./helpers/wsHarness";

type JsonRpcConnection = {
  ws: WebSocket;
  sendRequest: (method: string, params?: unknown) => Promise<any>;
  sendResponse: (id: string | number, result: unknown) => void;
  waitFor: (predicate: (message: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => void;
};

async function connectJsonRpc(url: string, opts?: { protocol?: "query" | "subprotocol" }): Promise<JsonRpcConnection> {
  const endpoint = opts?.protocol === "subprotocol" ? url : `${url}?protocol=jsonrpc`;
  const ws = opts?.protocol === "subprotocol"
    ? new WebSocket(endpoint, "cowork.jsonrpc.v1")
    : new WebSocket(endpoint);

  const queue: any[] = [];
  const waiters = new Set<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    reject: (error: Error) => void;
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

  const waitFor = async (predicate: (message: any) => boolean, timeoutMs = 5_000): Promise<any> => {
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
  const sendRequest = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((message) => message.id === id);
  };

  const sendResponse = (id: string | number, result: unknown) => {
    ws.send(JSON.stringify({ id, result }));
  };

  const initializeResponse = await sendRequest("initialize", {
    clientInfo: {
      name: "test-jsonrpc-client",
      version: "1.0.0",
    },
  });
  expect(initializeResponse.result.protocolVersion).toBe("0.1");
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    ws,
    sendRequest,
    sendResponse,
    waitFor,
    close: () => ws.close(),
  };
}

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
      server.stop();
    }
  });

  test("turn/start streams turn and item notifications", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async () => ({
        text: "streamed reply",
        responseMessages: [],
      })) as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnResponse = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "hello there" }],
      });
      expect(turnResponse.result.turn.threadId).toBe(started.result.thread.id);

      const turnStarted = await rpc.waitFor((message) => message.method === "turn/started");
      const userItemStarted = await rpc.waitFor((message) =>
        message.method === "item/started" && message.params.item.type === "userMessage",
      );
      const agentDelta = await rpc.waitFor((message) => message.method === "item/agentMessage/delta");
      const agentCompleted = await rpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      const turnCompleted = await rpc.waitFor((message) => message.method === "turn/completed");

      expect(turnStarted.params.threadId).toBe(started.result.thread.id);
      expect(userItemStarted.params.item.content[0].text).toBe("hello there");
      expect(agentDelta.params.delta).toBe("streamed reply");
      expect(agentCompleted.params.item.text).toBe("streamed reply");
      expect(turnCompleted.params.turn.status).toBe("completed");
      rpc.close();
    } finally {
      server.stop();
    }
  });

  test("thread-scoped defaults apply emits live session state notifications", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const applied = await rpc.sendRequest("cowork/session/defaults/apply", {
        cwd: tmpDir,
        threadId: started.result.thread.id,
        provider: "google",
        model: "gemini-3-flash-preview",
        enableMcp: false,
        config: {
          backupsEnabled: false,
        },
      });

      expect(applied.result.event.type).toBe("session_config");
      expect(applied.result.event.sessionId).toBe(started.result.thread.id);

      const configUpdated = await rpc.waitFor((message) => message.method === "cowork/session/configUpdated");
      const sessionSettings = await rpc.waitFor((message) => message.method === "cowork/session/settings");
      const sessionConfig = await rpc.waitFor((message) => message.method === "cowork/session/config");

      expect(configUpdated.params.sessionId).toBe(started.result.thread.id);
      expect(configUpdated.params.config.model).toBe("gemini-3-flash-preview");
      expect(sessionSettings.params.sessionId).toBe(started.result.thread.id);
      expect(sessionSettings.params.enableMcp).toBe(false);
      expect(sessionConfig.params.sessionId).toBe(started.result.thread.id);
      expect(sessionConfig.params.config.backupsEnabled).toBe(false);

      rpc.close();
    } finally {
      server.stop();
    }
  });

  test("server-initiated user input requests resolve over JSON-RPC responses", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async (params: any) => {
        const answer = await params.askUser("Pick one", ["a", "b"]);
        return {
          text: `answer:${answer}`,
          responseMessages: [],
        };
      }) as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start ask flow" }],
      });

      const request = await rpc.waitFor((message) => message.method === "item/tool/requestUserInput");
      expect(request.params.question).toBe("Pick one");
      rpc.sendResponse(request.id, { answer: "b" });

      const resolved = await rpc.waitFor((message) => message.method === "serverRequest/resolved");
      const agentCompleted = await rpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(agentCompleted.params.item.text).toBe("answer:b");
      rpc.close();
    } finally {
      server.stop();
    }
  });

  test("server-initiated approval requests resolve over JSON-RPC responses", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async (params: any) => {
        const approved = await params.approveCommand("rm -rf /tmp/example");
        return {
          text: approved ? "approved" : "denied",
          responseMessages: [],
        };
      }) as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start approval flow" }],
      });

      const request = await rpc.waitFor((message) => message.method === "item/commandExecution/requestApproval");
      expect(request.params.command).toBe("rm -rf /tmp/example");
      rpc.sendResponse(request.id, { decision: "accept" });

      const resolved = await rpc.waitFor((message) => message.method === "serverRequest/resolved");
      const agentCompleted = await rpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(agentCompleted.params.item.text).toBe("approved");
      rpc.close();
    } finally {
      server.stop();
    }
  });

  test("thread/read can include journal-projected turns and thread/resume can replay from a journal cursor", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async () => ({
        text: "journal reply",
        responseMessages: [],
      })) as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "build the journal" }],
      });
      await rpc.waitFor((message) => message.method === "turn/completed");

      const read = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      expect(read.result.thread.turns).toHaveLength(1);
      expect(read.result.thread.turns[0].items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "userMessage" }),
          expect.objectContaining({ type: "agentMessage", text: "journal reply" }),
        ]),
      );
      expect(read.result.journalTailSeq).toBeGreaterThan(0);

      const replayRpc = await connectJsonRpc(url);
      await replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: 1,
      });
      const replayedTurnStarted = await replayRpc.waitFor((message) => message.method === "turn/started");
      const replayedAgentCompleted = await replayRpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(replayedTurnStarted.params.threadId).toBe(started.result.thread.id);
      expect(replayedAgentCompleted.params.item.text).toBe("journal reply");

      replayRpc.close();
      rpc.close();
    } finally {
      server.stop();
    }
  });
});
