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

async function connectJsonRpc(
  url: string,
  opts?: {
    protocol?: "query" | "subprotocol";
    optOutNotificationMethods?: string[];
  },
): Promise<JsonRpcConnection> {
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
    ...(opts?.optOutNotificationMethods?.length
      ? {
          capabilities: {
            optOutNotificationMethods: opts.optOutNotificationMethods,
          },
        }
      : {}),
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
      await server.stop();
    }
  });

  test("thread/list includes wire counts for live and persisted threads", async () => {
    const tmpDir = await makeTmpProject();
    let threadId = "";
    const liveServer = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async () => ({
        text: "streamed reply",
        responseMessages: [],
      })) as any,
    }));

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
      await liveServer.server.stop();
    }

    const persistedServer = await startAgentServer(serverOpts(tmpDir));
    try {
      const rpc = await connectJsonRpc(persistedServer.url);
      const persistedListed = await rpc.sendRequest("thread/list", { cwd: tmpDir });
      const persistedThread = persistedListed.result.threads.find((thread: any) => thread.id === threadId);
      expect(persistedThread).toBeDefined();
      expect(persistedThread.status.type).toBe("notLoaded");
      expect(persistedThread.messageCount).toBeGreaterThan(0);
      expect(persistedThread.lastEventSeq).toBeGreaterThan(0);
      rpc.close();
    } finally {
      await persistedServer.server.stop();
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
        clientMessageId: "msg-1",
        input: [{ type: "text", text: "hello there" }],
      });
      expect(turnResponse.result.turn.threadId).toBe(started.result.thread.id);
      expect(turnResponse.result.turn.id).toBeTruthy();
      expect(turnResponse.result.turn.status).toBe("inProgress");

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
      expect(turnStarted.params.turn.id).toBe(turnResponse.result.turn.id);
      expect(userItemStarted.params.item.content[0].text).toBe("hello there");
      expect(userItemStarted.params.item.clientMessageId).toBe("msg-1");
      expect(agentDelta.params.delta).toBe("streamed reply");
      expect(agentCompleted.params.item.text).toBe("streamed reply");
      expect(turnCompleted.params.turn.status).toBe("completed");
      rpc.close();
    } finally {
      await server.stop();
    }
  });

  test("turn/start streams reasoning notifications before assistant output", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async (params: any) => {
        await params.onModelStreamPart?.({ type: "start" });
        await params.onModelStreamPart?.({ type: "reasoning-start", id: "rs_live", mode: "summary" });
        await params.onModelStreamPart?.({ type: "reasoning-delta", id: "rs_live", text: "Inspecting the reports." });
        await params.onModelStreamPart?.({ type: "reasoning-end", id: "rs_live", mode: "summary" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_live", text: "Final answer" });
        await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
        return {
          text: "Final answer",
          reasoningText: "Inspecting the reports.",
          responseMessages: [],
        };
      }) as any,
    }));

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
      await rpc.waitFor((message) =>
        message.method === "item/started" && message.params.item.type === "userMessage",
      );
      const reasoningStarted = await rpc.waitFor((message) =>
        message.method === "item/started" && message.params.item.type === "reasoning",
      );
      const reasoningDelta = await rpc.waitFor((message) => message.method === "item/reasoning/delta");
      const reasoningCompleted = await rpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "reasoning",
      );
      const agentDelta = await rpc.waitFor((message) => message.method === "item/agentMessage/delta");
      const agentCompleted = await rpc.waitFor((message) =>
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
      await server.stop();
    }
  });

  test("turn/start rejects at the request layer when the thread is already running", async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async () => {
        await releaseTurn.promise;
        return {
          text: "done",
          responseMessages: [],
        };
      }) as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const firstTurn = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "first turn" }],
      });
      expect(firstTurn.result.turn.status).toBe("inProgress");

      const secondTurn = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "second turn" }],
      });
      expect(secondTurn.error?.message).toBe("Agent is busy");
      expect(secondTurn.result).toBeUndefined();

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await server.stop();
    }
  });

  test("turn/steer returns the accepted turn id once steering is actually accepted", async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async () => {
        await releaseTurn.promise;
        return {
          text: "done",
          responseMessages: [],
        };
      }) as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;

      const steerResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: [{ type: "text", text: "keep going" }],
        clientMessageId: "steer-1",
      });
      expect(steerResponse.result.turnId).toBe(turnId);

      const steerAccepted = await rpc.waitFor((message) => message.method === "cowork/session/steerAccepted");
      expect(steerAccepted.params.turnId).toBe(turnId);
      expect(steerAccepted.params.clientMessageId).toBe("steer-1");

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await server.stop();
    }
  });

  test("turn/steer rejects at the request layer when the requested turn is no longer active", async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async () => {
        await releaseTurn.promise;
        return {
          text: "done",
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
        input: [{ type: "text", text: "start turn" }],
      });

      const steerResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId: "turn-stale",
        input: [{ type: "text", text: "wrong turn" }],
      });
      expect(steerResponse.error?.message).toBe("Active turn mismatch.");
      expect(steerResponse.result).toBeUndefined();

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await server.stop();
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
      await server.stop();
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

      const systemEntry = await rpc.waitFor((message) =>
        message.method === "item/completed"
        && message.params.turnId === null
        && message.params.item.type === "system",
      );
      const request = await rpc.waitFor((message) => message.method === "item/tool/requestUserInput");
      expect(systemEntry.params.item.line).toBe("question: Pick one");
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
      await server.stop();
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

      const systemEntry = await rpc.waitFor((message) =>
        message.method === "item/completed"
        && message.params.turnId === null
        && message.params.item.type === "system",
      );
      const request = await rpc.waitFor((message) => message.method === "item/commandExecution/requestApproval");
      expect(systemEntry.params.item.line).toBe("approval requested: rm -rf /tmp/example");
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
      await server.stop();
    }
  });

  test("thread/resume replays a pending user input request after reconnect", async () => {
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
        input: [{ type: "text", text: "start ask reconnect flow" }],
      });

      const request = await rpc.waitFor((message) => message.method === "item/tool/requestUserInput");
      expect(request.params.question).toBe("Pick one");
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
      });
      const replayedRequest = await replayRpc.waitFor((message) => message.method === "item/tool/requestUserInput");
      const replayedThreadStarted = await replayRpc.waitFor((message) => message.method === "thread/started");
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(replayedThreadStarted.params.thread.id).toBe(started.result.thread.id);
      expect(replayedRequest.id).toBe(request.id);
      expect(replayedRequest.params.requestId).toBe(request.params.requestId);
      await expect(
        replayRpc.waitFor(
          (message) =>
            message.method === "item/tool/requestUserInput"
            && message.params.requestId === request.params.requestId,
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      replayRpc.sendResponse(replayedRequest.id, { answer: "b" });
      const resolved = await replayRpc.waitFor((message) => message.method === "serverRequest/resolved");
      const agentCompleted = await replayRpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(resolved.params.requestId).toBe(request.params.requestId);
      expect(agentCompleted.params.item.text).toBe("answer:b");
      replayRpc.close();
    } finally {
      await server.stop();
    }
  });

  test("thread/resume replays a pending approval request after reconnect", async () => {
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
        input: [{ type: "text", text: "start approval reconnect flow" }],
      });

      const request = await rpc.waitFor((message) => message.method === "item/commandExecution/requestApproval");
      expect(request.params.command).toBe("rm -rf /tmp/example");
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
      });
      const replayedRequest = await replayRpc.waitFor((message) => message.method === "item/commandExecution/requestApproval");
      const replayedThreadStarted = await replayRpc.waitFor((message) => message.method === "thread/started");
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(replayedThreadStarted.params.thread.id).toBe(started.result.thread.id);
      expect(replayedRequest.id).toBe(request.id);
      expect(replayedRequest.params.requestId).toBe(request.params.requestId);
      await expect(
        replayRpc.waitFor(
          (message) =>
            message.method === "item/commandExecution/requestApproval"
            && message.params.requestId === request.params.requestId,
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      replayRpc.sendResponse(replayedRequest.id, { decision: "accept" });
      const resolved = await replayRpc.waitFor((message) => message.method === "serverRequest/resolved");
      const agentCompleted = await replayRpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(resolved.params.requestId).toBe(request.params.requestId);
      expect(agentCompleted.params.item.text).toBe("approved");
      replayRpc.close();
    } finally {
      await server.stop();
    }
  });

  test("thread/resume does not duplicate a pending user input request when afterSeq also replays it", async () => {
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
      const beforeTurnRead = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start ask replay dedupe flow" }],
      });

      const request = await rpc.waitFor((message) => message.method === "item/tool/requestUserInput");
      expect(beforeTurnRead.result.journalTailSeq).toBeGreaterThan(0);
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: beforeTurnRead.result.journalTailSeq,
      });
      const replayedRequest = await replayRpc.waitFor((message) => message.method === "item/tool/requestUserInput");
      const replayedThreadStarted = await replayRpc.waitFor((message) => message.method === "thread/started");
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(replayedThreadStarted.params.thread.id).toBe(started.result.thread.id);
      expect(replayedRequest.id).toBe(request.id);
      expect(replayedRequest.params.requestId).toBe(request.params.requestId);
      await expect(
        replayRpc.waitFor(
          (message) =>
            message.method === "item/tool/requestUserInput"
            && message.params.requestId === request.params.requestId,
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      replayRpc.sendResponse(replayedRequest.id, { answer: "a" });
      const resolved = await replayRpc.waitFor((message) => message.method === "serverRequest/resolved");
      const agentCompleted = await replayRpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.requestId).toBe(request.params.requestId);
      expect(agentCompleted.params.item.text).toBe("answer:a");
      replayRpc.close();
    } finally {
      await server.stop();
    }
  });

  test("thread/read can include journal-projected turns and thread/resume can replay from a journal cursor", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async (params: any) => {
        await params.onModelStreamPart?.({ type: "start" });
        await params.onModelStreamPart?.({ type: "reasoning-start", id: "rs_journal", mode: "summary" });
        await params.onModelStreamPart?.({ type: "reasoning-delta", id: "rs_journal", text: "Inspecting the reports." });
        await params.onModelStreamPart?.({ type: "reasoning-end", id: "rs_journal", mode: "summary" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_journal", text: "journal reply" });
        await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
        return {
          text: "journal reply",
          reasoningText: "Inspecting the reports.",
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
        clientMessageId: "journal-msg-1",
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
          expect.objectContaining({ type: "userMessage", clientMessageId: "journal-msg-1" }),
          expect.objectContaining({ type: "reasoning", mode: "reasoning", text: "Inspecting the reports." }),
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
      const replayedReasoningStarted = await replayRpc.waitFor((message) =>
        message.method === "item/started" && message.params.item.type === "reasoning",
      );
      const replayedReasoningDelta = await replayRpc.waitFor((message) => message.method === "item/reasoning/delta");
      const replayedAgentCompleted = await replayRpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(replayedTurnStarted.params.threadId).toBe(started.result.thread.id);
      expect(replayedReasoningStarted.params.item.text).toBe("");
      expect(replayedReasoningDelta.params.delta).toBe("Inspecting the reports.");
      expect(replayedReasoningDelta.params.itemId).toBe(replayedReasoningStarted.params.item.id);
      expect(replayedAgentCompleted.params.item.text).toBe("journal reply");

      replayRpc.close();
      rpc.close();
    } finally {
      await server.stop();
    }
  }, 15_000);

  test("thread/resume honors notification opt-outs while replaying journal events", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: (async (params: any) => {
        await params.onModelStreamPart?.({ type: "start" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_optout", text: "journal delta" });
        await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
        return {
          text: "journal delta",
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
        input: [{ type: "text", text: "build the journal" }],
      });
      await rpc.waitFor((message) => message.method === "turn/completed");

      const replayRpc = await connectJsonRpc(url, {
        optOutNotificationMethods: ["item/agentMessage/delta"],
      });
      await replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: 1,
      });
      const replayedTurnStarted = await replayRpc.waitFor((message) => message.method === "turn/started");
      const replayedAgentCompleted = await replayRpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );

      expect(replayedTurnStarted.params.threadId).toBe(started.result.thread.id);
      expect(replayedAgentCompleted.params.item.text).toBe("journal delta");
      await expect(
        replayRpc.waitFor((message) => message.method === "item/agentMessage/delta", 250),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      replayRpc.close();
      rpc.close();
    } finally {
      await server.stop();
    }
  });

  test("thread/resume replays a journal cursor once before reattaching the live thread sink", async () => {
    const tmpDir = await makeTmpProject();
    let releaseSecondChunk: (() => void) | undefined;
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({ type: "text-delta", id: "txt_resume", text: "before disconnect" });
      await new Promise<void>((resolve) => {
        releaseSecondChunk = resolve;
      });
      await params.onModelStreamPart?.({ type: "text-delta", id: "txt_resume", text: "after disconnect" });
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: "after disconnect",
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const beforeTurnRead = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "build the journal" }],
      });
      await rpc.waitFor((message) =>
        message.method === "item/agentMessage/delta" && message.params.delta === "before disconnect",
      );

      expect(beforeTurnRead.result.journalTailSeq).toBeGreaterThan(0);
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: beforeTurnRead.result.journalTailSeq,
      });
      await replayRpc.waitFor((message) => message.method === "thread/started");
      releaseSecondChunk?.();

      const replayedDelta = await replayRpc.waitFor((message) =>
        message.method === "item/agentMessage/delta" && message.params.delta === "after disconnect",
      );
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(replayedDelta.params.delta).toBe("after disconnect");
      await expect(
        replayRpc.waitFor(
          (message) => message.method === "item/agentMessage/delta" && message.params.delta === "after disconnect",
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);
      replayRpc.close();
    } finally {
      releaseSecondChunk?.();
      await server.stop();
    }
  });

  test("thread/resume seeds the live projector so finish-only completions survive reconnect", async () => {
    const tmpDir = await makeTmpProject();
    let releaseFinish: (() => void) | undefined;
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({ type: "text-delta", id: "txt_resume_seed", text: "before disconnect" });
      await new Promise<void>((resolve) => {
        releaseFinish = resolve;
      });
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: "before disconnect",
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const beforeTurnRead = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "resume me" }],
      });
      await rpc.waitFor((message) =>
        message.method === "item/agentMessage/delta" && message.params.delta === "before disconnect",
      );
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: beforeTurnRead.result.journalTailSeq,
      });
      await replayRpc.waitFor((message) => message.method === "thread/started");
      releaseFinish?.();

      const completed = await replayRpc.waitFor((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(completed.params.item.text).toBe("before disconnect");
      replayRpc.close();
    } finally {
      releaseFinish?.();
      await server.stop();
    }
  });

  test("thread/read and thread/resume replay journals beyond 1000 events", async () => {
    const tmpDir = await makeTmpProject();
    const deltaCount = 1_005;
    const finalText = Array.from({ length: deltaCount }, (_, index) => `chunk-${index}`).join("");
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      for (let index = 0; index < deltaCount; index += 1) {
        await params.onModelStreamPart?.({ type: "text-delta", id: `txt_${index}`, text: `chunk-${index}` });
      }
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: finalText,
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer(serverOpts(tmpDir, {
      runTurnImpl: runTurnImpl as any,
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "flood the journal" }],
      });
      await rpc.waitFor((message) => message.method === "turn/completed", 15_000);

      const read = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      expect(read.result.journalTailSeq).toBeGreaterThan(1_000);
      expect(read.result.coworkSnapshot.feed.at(-1)?.text).toContain("chunk-1004");
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: 1,
      });
      await replayRpc.waitFor((message) => message.method === "thread/started");
      const replayedLastDelta = await replayRpc.waitFor(
        (message) => message.method === "item/agentMessage/delta" && message.params.delta === "chunk-1004",
        15_000,
      );
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(replayedLastDelta.params.delta).toBe("chunk-1004");
      replayRpc.close();
    } finally {
      await server.stop();
    }
  });
});
