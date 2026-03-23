import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startAgentServer } from "../src/server/startServer";

async function makeTmpProject(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-toolstream-test-"));
  await fs.mkdir(path.join(tmp, ".agent"), { recursive: true });
  return tmp;
}

type JsonRpcConnection = {
  sendRequest: (method: string, params?: unknown) => Promise<any>;
  waitFor: (predicate: (message: any) => boolean, timeoutMs?: number) => Promise<any>;
  takeQueued: (predicate: (message: any) => boolean) => any[];
  close: () => void;
};

async function connectJsonRpc(url: string): Promise<JsonRpcConnection> {
  const ws = new WebSocket(`${url}?protocol=jsonrpc`);
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

  const takeQueued = (predicate: (message: any) => boolean): any[] => {
    const matched: any[] = [];
    for (let index = queue.length - 1; index >= 0; index--) {
      if (!predicate(queue[index])) continue;
      matched.unshift(queue[index]);
      queue.splice(index, 1);
    }
    return matched;
  };

  let nextId = 0;
  const sendRequest = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((message) => message.id === id);
  };

  const initializeResponse = await sendRequest("initialize", {
    clientInfo: {
      name: "toolstream-test-client",
      version: "1.0.0",
    },
  });
  expect(initializeResponse.result.protocolVersion).toBe("0.1");
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    sendRequest,
    waitFor,
    takeQueued,
    close: () => ws.close(),
  };
}

async function runTurnAndCollectNotifications(
  url: string,
  cwd: string,
  text: string,
  timeoutMs = 10_000,
): Promise<{ threadId: string; turnId: string; notifications: any[] }> {
  const rpc = await connectJsonRpc(url);

  try {
    const started = await rpc.sendRequest("thread/start", { cwd });
    const threadId = started.result.thread.id as string;
    await rpc.waitFor((message) => message.method === "thread/started" && message.params.thread.id === threadId);

    const turnStarted = await rpc.sendRequest("turn/start", {
      threadId,
      clientMessageId: "msg-1",
      input: [{ type: "text", text }],
    });
    const turnId = turnStarted.result.turn.id as string;
    const notifications: any[] = [];

    while (true) {
      const message = await rpc.waitFor((candidate) => typeof candidate.method === "string", timeoutMs);
      notifications.push(message);
      if (message.method === "turn/completed" && message.params.turn.id === turnId) {
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    notifications.push(...rpc.takeQueued((candidate) => typeof candidate.method === "string"));

    return { threadId, turnId, notifications };
  } finally {
    rpc.close();
  }
}

describe("JSON-RPC tool loop notifications", () => {
  test("multi-step tool loop projects tool and assistant notifications in order", async () => {
    const tmpDir = await makeTmpProject();

    const runTurnImpl = async (params: any) => {
      const emit = params.onModelStreamPart;
      await emit?.({ type: "start" });
      await emit?.({ type: "start-step", stepNumber: 0 });
      await emit?.({ type: "tool-call", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } });
      await emit?.({ type: "tool-result", toolCallId: "tc1", toolName: "bash", output: "file.txt\nREADME.md" });
      await emit?.({ type: "finish-step", stepNumber: 0, finishReason: "tool-calls" });
      await emit?.({ type: "start-step", stepNumber: 1 });
      await emit?.({ type: "text-delta", id: "t1", text: "Found 2 files." });
      await emit?.({ type: "finish-step", stepNumber: 1, finishReason: "stop" });
      await emit?.({ type: "finish", finishReason: "stop" });
      return {
        text: "Found 2 files.",
        reasoningText: undefined,
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer({
      cwd: tmpDir,
      hostname: "127.0.0.1",
      port: 0,
      homedir: tmpDir,
      env: {
        AGENT_WORKING_DIR: tmpDir,
        AGENT_PROVIDER: "google",
        COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
      },
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const { threadId, turnId, notifications } = await runTurnAndCollectNotifications(url, tmpDir, "list files please");

      const toolStarted = notifications.find((message) =>
        message.method === "item/started" && message.params.item.type === "toolCall");
      const toolCompleted = notifications.find((message) =>
        message.method === "item/completed" && message.params.item.type === "toolCall");
      const agentStarted = notifications.find((message) =>
        message.method === "item/started" && message.params.item.type === "agentMessage");
      const agentDelta = notifications.find((message) => message.method === "item/agentMessage/delta");
      const agentCompleted = notifications.find((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage");
      const turnCompleted = notifications.find((message) => message.method === "turn/completed");

      expect(toolStarted).toBeDefined();
      expect(toolCompleted).toBeDefined();
      expect(agentStarted).toBeDefined();
      expect(agentDelta).toBeDefined();
      expect(agentCompleted).toBeDefined();
      expect(turnCompleted).toBeDefined();

      expect(toolStarted.params.threadId).toBe(threadId);
      expect(toolStarted.params.turnId).toBe(turnId);
      expect(toolStarted.params.item).toMatchObject({
        type: "toolCall",
        toolName: "bash",
        state: "input-available",
        args: { command: "ls" },
      });

      expect(toolCompleted.params.threadId).toBe(threadId);
      expect(toolCompleted.params.turnId).toBe(turnId);
      expect(toolCompleted.params.item).toMatchObject({
        id: toolStarted.params.item.id,
        type: "toolCall",
        toolName: "bash",
        state: "output-available",
        result: "file.txt\nREADME.md",
      });

      expect(agentDelta.params).toMatchObject({
        threadId,
        turnId,
        itemId: agentStarted.params.item.id,
        delta: "Found 2 files.",
      });
      expect(agentCompleted.params.item).toMatchObject({
        id: agentStarted.params.item.id,
        type: "agentMessage",
        text: "Found 2 files.",
      });
      expect(turnCompleted.params).toMatchObject({
        threadId,
        turn: {
          id: turnId,
          status: "completed",
        },
      });

      const toolStartedIndex = notifications.findIndex((message) => message === toolStarted);
      const toolCompletedIndex = notifications.findIndex((message) => message === toolCompleted);
      const agentStartedIndex = notifications.findIndex((message) => message === agentStarted);
      const agentDeltaIndex = notifications.findIndex((message) => message === agentDelta);
      const agentCompletedIndex = notifications.findIndex((message) => message === agentCompleted);
      const turnCompletedIndex = notifications.findIndex((message) => message === turnCompleted);

      expect(toolStartedIndex).toBeGreaterThanOrEqual(0);
      expect(toolCompletedIndex).toBeGreaterThan(toolStartedIndex);
      expect(agentStartedIndex).toBeGreaterThan(toolCompletedIndex);
      expect(agentDeltaIndex).toBeGreaterThan(agentStartedIndex);
      expect(agentCompletedIndex).toBeGreaterThan(agentDeltaIndex);
      expect(turnCompletedIndex).toBeGreaterThan(agentCompletedIndex);
    } finally {
      await server.stop();
    }
  }, 30_000);
});

describe("JSON-RPC turn usage notifications", () => {
  test("turn usage notification reports the final token counts", async () => {
    const tmpDir = await makeTmpProject();

    const runTurnImpl = async (params: any) => {
      const emit = params.onModelStreamPart;
      await emit?.({ type: "start" });
      await emit?.({ type: "text-delta", id: "t1", text: "Hello" });
      await emit?.({ type: "finish", finishReason: "stop" });
      return {
        text: "Hello",
        reasoningText: undefined,
        responseMessages: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    };

    const { server, url } = await startAgentServer({
      cwd: tmpDir,
      hostname: "127.0.0.1",
      port: 0,
      homedir: tmpDir,
      env: {
        AGENT_WORKING_DIR: tmpDir,
        AGENT_PROVIDER: "google",
        COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
      },
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const { turnId, notifications } = await runTurnAndCollectNotifications(url, tmpDir, "say hello");
      const usageNotification = notifications.find((message) => message.method === "cowork/session/turnUsage");
      const agentCompletedIndex = notifications.findIndex((message) =>
        message.method === "item/completed" && message.params.item.type === "agentMessage");
      const usageIndex = notifications.findIndex((message) => message.method === "cowork/session/turnUsage");
      const turnCompletedIndex = notifications.findIndex((message) => message.method === "turn/completed");

      expect(usageNotification).toBeDefined();
      expect(usageNotification.params).toMatchObject({
        type: "turn_usage",
        turnId,
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      });
      expect(agentCompletedIndex).toBeGreaterThanOrEqual(0);
      expect(usageIndex).toBeGreaterThan(agentCompletedIndex);
      expect(turnCompletedIndex).toBeGreaterThan(usageIndex);
    } finally {
      await server.stop();
    }
  }, 30_000);
});
