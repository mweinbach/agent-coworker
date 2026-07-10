import { describe, expect, test } from "bun:test";

import { CoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/jsonRpcClient";

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("mobile cowork jsonrpc client", () => {
  test("performs initialize handshake and sends initialized", async () => {
    const sent: string[] = [];
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
      onNotification(message) {
        notifications.push(message);
      },
      onServerRequest() {
        // ignore
      },
    });

    const handshakePromise = client.initialize();
    const initializePayload = JSON.parse(sent[0]!);
    expect(initializePayload.method).toBe("initialize");
    expect(initializePayload.params.clientInfo.name).toBe("cowork-mobile");
    expect(initializePayload.params.capabilities.toolRetryLineage).toBe(true);

    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await handshakePromise;

    const initializedPayload = JSON.parse(sent[1]!);
    expect(initializedPayload.method).toBe("initialized");
    const listPromise = client.requestThreadList();
    const listPayload = JSON.parse(sent.at(-1)!);
    await client.handleIncoming(
      JSON.stringify({
        id: listPayload.id,
        result: {
          threads: [],
          total: 0,
        },
      }),
    );
    await expect(listPromise).resolves.toEqual({ threads: [], total: 0 });

    await flushMicrotasks();

    await client.handleIncoming(
      JSON.stringify({
        method: "thread/started",
        params: {
          thread: {
            id: "thread-1",
            title: "Remote thread",
            preview: "",
            modelProvider: "opencode",
            model: "gpt-5",
            cwd: "/workspace",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 0,
            lastEventSeq: 0,
            status: { type: "idle" },
          },
        },
      }),
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.method).toBe("thread/started");

    await client.handleIncoming(
      JSON.stringify({
        method: "workspace/listChanged",
        params: {
          revision: 1,
        },
      }),
    );

    expect(notifications.at(-1)).toEqual({
      method: "workspace/listChanged",
      params: {
        revision: 1,
      },
    });
  });

  test("falls back once when an old strict server rejects toolRetryLineage", async () => {
    const sent: string[] = [];
    let client: CoworkJsonRpcClient | null = null;
    client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
        const message = JSON.parse(text) as Record<string, unknown>;
        if (message.method !== "initialize" || typeof message.id !== "number") return;
        const params =
          typeof message.params === "object" && message.params !== null
            ? (message.params as Record<string, unknown>)
            : {};
        const capabilities =
          typeof params.capabilities === "object" && params.capabilities !== null
            ? (params.capabilities as Record<string, unknown>)
            : {};
        const response =
          "toolRetryLineage" in capabilities
            ? {
                id: message.id,
                error: {
                  code: -32602,
                  message: "Unknown capability: toolRetryLineage",
                },
              }
            : {
                id: message.id,
                result: {
                  protocolVersion: "0.1",
                  capabilities: {
                    experimentalApi: true,
                  },
                },
              };
        queueMicrotask(() => {
          void client?.handleIncoming(JSON.stringify(response));
        });
      },
    });

    const initializePromise = client.initialize();
    const first = JSON.parse(sent[0]!) as {
      id: number;
      params: { capabilities: Record<string, unknown> };
    };
    expect(first.params.capabilities.toolRetryLineage).toBe(true);
    await initializePromise;

    const fallback = JSON.parse(sent[1]!) as {
      id: number;
      params: { capabilities: Record<string, unknown> };
    };
    expect(fallback.params.capabilities).toEqual({
      experimentalApi: true,
    });

    expect(sent.map((entry) => JSON.parse(entry).method)).toEqual([
      "initialize",
      "initialize",
      "initialized",
    ]);
    expect(client.supportsToolRetryLineage).toBe(false);
    await expect(
      client.startTurn("thread", "Continue.", "message", ["failed-tool"]),
    ).rejects.toThrow("does not support exact tool retries");
  });

  test("routes server requests and responses", async () => {
    const sent: string[] = [];
    const requests: Array<{ id: string | number; method: string }> = [];

    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
      onNotification() {
        // ignore
      },
      onServerRequest(message) {
        requests.push({ id: message.id, method: message.method });
      },
    });

    const handshakePromise = client.initialize();
    const initializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await handshakePromise;

    const listPromise = client.requestThreadList();
    const listPayload = JSON.parse(sent.at(-1)!);
    await client.handleIncoming(
      JSON.stringify({
        id: listPayload.id,
        result: {
          threads: [],
          total: 0,
        },
      }),
    );
    await expect(listPromise).resolves.toEqual({ threads: [], total: 0 });

    await client.handleIncoming(
      JSON.stringify({
        id: 7,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          requestId: "req-1",
          itemId: "item-1",
          question: "Continue?",
        },
      }),
    );
    await flushMicrotasks();
    expect(requests).toEqual([{ id: 7, method: "item/tool/requestUserInput" }]);

    await client.respondServerRequest(7, { answer: "yes" });
    const responsePayload = JSON.parse(sent.at(-1)!);
    expect(responsePayload).toEqual({
      id: 7,
      result: { answer: "yes" },
    });
  });

  test("readThread initializes before sending thread/read", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const readPromise = client.readThread("thread-1");
    const initializePayload = JSON.parse(sent[0]!);
    expect(initializePayload.method).toBe("initialize");
    expect(sent).toHaveLength(1);

    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );

    await waitForCondition(() => sent.length >= 3);
    const initializedPayload = JSON.parse(sent[1]!);
    const readPayload = JSON.parse(sent[2]!);
    expect(initializedPayload.method).toBe("initialized");
    expect(readPayload).toMatchObject({
      method: "thread/read",
      params: {
        threadId: "thread-1",
      },
    });

    await client.handleIncoming(
      JSON.stringify({
        id: readPayload.id,
        result: {
          thread: {
            id: "thread-1",
            title: "Remote thread",
            preview: "",
            modelProvider: "opencode",
            model: "gpt-5",
            cwd: "/workspace",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            messageCount: 1,
            lastEventSeq: 1,
            status: { type: "loaded" },
          },
          coworkSnapshot: null,
          replayHealth: {
            trusted: true,
            snapshotRequired: false,
            reason: "ok",
            tailSeq: 1,
            failedWriteCount: 0,
            droppedEventCount: 0,
          },
        },
      }),
    );

    await expect(readPromise).resolves.toMatchObject({
      thread: {
        id: "thread-1",
      },
      coworkSnapshot: null,
      replayHealth: {
        trusted: true,
      },
    });
  });

  test("requestThreadList initializes before sending thread/list", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const listPromise = client.requestThreadList("/workspace", 5);
    const initializePayload = JSON.parse(sent[0]!);
    expect(initializePayload.method).toBe("initialize");
    expect(sent).toHaveLength(1);

    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );

    await waitForCondition(() => sent.length >= 3);
    const initializedPayload = JSON.parse(sent[1]!);
    const listPayload = JSON.parse(sent[2]!);
    expect(initializedPayload.method).toBe("initialized");
    expect(listPayload).toMatchObject({
      method: "thread/list",
      params: {
        cwd: "/workspace",
        limit: 5,
      },
    });

    await client.handleIncoming(
      JSON.stringify({
        id: listPayload.id,
        result: {
          threads: [],
          total: 0,
        },
      }),
    );

    await expect(listPromise).resolves.toEqual({ threads: [], total: 0 });
  });

  test("requestThreadList fails fast when initialize throws", async () => {
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send() {
        throw new Error("transport offline");
      },
      requestTimeoutMs: 60_000,
    });

    await expect(client.requestThreadList("/workspace")).rejects.toThrow("transport offline");
  });

  test("resumeThread initializes before sending thread/resume", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const resumePromise = client.resumeThread("thread-1");
    const initializePayload = JSON.parse(sent[0]!);
    expect(initializePayload.method).toBe("initialize");

    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );

    await waitForCondition(() => sent.length >= 3);
    const initializedPayload = JSON.parse(sent[1]!);
    const resumePayload = JSON.parse(sent[2]!);
    expect(initializedPayload.method).toBe("initialized");
    expect(resumePayload).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "thread-1",
      },
    });

    await client.handleIncoming(
      JSON.stringify({
        id: resumePayload.id,
        result: {
          thread: {
            id: "thread-1",
            title: "Remote thread",
            preview: "",
            modelProvider: "opencode",
            model: "gpt-5",
            cwd: "/workspace",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            messageCount: 1,
            lastEventSeq: 1,
            status: { type: "loaded" },
          },
          replayHealth: {
            trusted: false,
            snapshotRequired: true,
            reason: "journal_write_failed",
            tailSeq: 4,
            failedWriteCount: 1,
            droppedEventCount: 2,
          },
        },
      }),
    );

    await expect(resumePromise).resolves.toMatchObject({
      thread: {
        id: "thread-1",
      },
      replayHealth: {
        trusted: false,
        snapshotRequired: true,
      },
    });
  });

  test("readThread retries after server-side initialization state is lost", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const firstHandshake = client.initialize();
    const firstInitializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: firstInitializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await firstHandshake;

    const readPromise = client.readThread("thread-1");
    await waitForCondition(() => sent.length >= 3);
    const firstReadPayload = JSON.parse(sent[2]!);
    expect(firstReadPayload.method).toBe("thread/read");

    await client.handleIncoming(
      JSON.stringify({
        id: firstReadPayload.id,
        error: {
          code: -32000,
          message: "Not initialized",
        },
      }),
    );

    await waitForCondition(() => sent.length >= 4);
    const secondInitializePayload = JSON.parse(sent[3]!);
    expect(secondInitializePayload.method).toBe("initialize");
    await client.handleIncoming(
      JSON.stringify({
        id: secondInitializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );

    await waitForCondition(() => sent.length >= 6);
    const retryReadPayload = JSON.parse(sent[5]!);
    expect(JSON.parse(sent[4]!).method).toBe("initialized");
    expect(retryReadPayload).toMatchObject({
      method: "thread/read",
      params: {
        threadId: "thread-1",
      },
    });

    await client.handleIncoming(
      JSON.stringify({
        id: retryReadPayload.id,
        result: {
          thread: {
            id: "thread-1",
            title: "Remote thread",
            preview: "",
            modelProvider: "opencode",
            model: "gpt-5",
            cwd: "/workspace",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            messageCount: 1,
            lastEventSeq: 1,
            status: { type: "loaded" },
          },
          coworkSnapshot: null,
        },
      }),
    );

    await expect(readPromise).resolves.toMatchObject({
      thread: {
        id: "thread-1",
      },
      coworkSnapshot: null,
    });
  });

  test("readThread accepts additive snapshot and feed item fields", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const readPromise = client.readThread("thread-1");
    const initializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );

    await waitForCondition(() => sent.length >= 3);
    const readPayload = JSON.parse(sent[2]!);
    await client.handleIncoming(
      JSON.stringify({
        id: readPayload.id,
        result: {
          thread: {
            id: "thread-1",
            title: "Remote thread",
            preview: "",
            modelProvider: "opencode",
            model: "gpt-5",
            cwd: "/workspace",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            messageCount: 1,
            lastEventSeq: 1,
            status: { type: "loaded" },
          },
          coworkSnapshot: {
            sessionId: "thread-1",
            title: "Remote thread",
            lastEventSeq: 1,
            feed: [
              {
                id: "msg-1",
                kind: "message",
                role: "assistant",
                ts: new Date(0).toISOString(),
                text: "Hello",
                completedAt: new Date(1).toISOString(),
              },
            ],
            agents: [],
            todos: [],
            hasPendingAsk: false,
            hasPendingApproval: false,
            taskType: "plan",
            targetPaths: ["src/auth"],
          },
        },
      }),
    );

    await expect(readPromise).resolves.toMatchObject({
      coworkSnapshot: {
        sessionId: "thread-1",
        taskType: "plan",
        targetPaths: ["src/auth"],
        feed: [
          expect.objectContaining({
            id: "msg-1",
            completedAt: new Date(1).toISOString(),
          }),
        ],
      },
    });
  });

  test("uploads files through the session control route", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const uploadPromise = client.uploadFile({
      cwd: "/workspace",
      filename: "notes.txt",
      contentBase64: Buffer.from("hello").toString("base64"),
    });
    const payload = JSON.parse(sent[0]!);
    expect(payload).toMatchObject({
      method: "cowork/session/file/upload",
      params: {
        cwd: "/workspace",
        filename: "notes.txt",
        contentBase64: "aGVsbG8=",
      },
    });

    await client.handleIncoming(
      JSON.stringify({
        id: payload.id,
        result: {
          event: {
            type: "file_uploaded",
            sessionId: "session-1",
            filename: "notes.txt",
            path: "/workspace/User Uploads/notes.txt",
          },
        },
      }),
    );

    await expect(uploadPromise).resolves.toEqual({
      type: "file_uploaded",
      sessionId: "session-1",
      filename: "notes.txt",
      path: "/workspace/User Uploads/notes.txt",
    });
  });

  test("starts turns with uploaded file input parts", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const startPromise = client.startTurn(
      "thread-1",
      [
        { type: "text", text: "summarize this" },
        {
          type: "uploadedFile",
          filename: "notes.txt",
          path: "/workspace/User Uploads/notes.txt",
          mimeType: "text/plain",
        },
      ],
      "client-msg-1",
    );
    const payload = JSON.parse(sent[0]!);
    expect(payload).toEqual({
      id: expect.any(Number),
      method: "turn/start",
      params: {
        threadId: "thread-1",
        clientMessageId: "client-msg-1",
        input: [
          { type: "text", text: "summarize this" },
          {
            type: "uploadedFile",
            filename: "notes.txt",
            path: "/workspace/User Uploads/notes.txt",
            mimeType: "text/plain",
          },
        ],
      },
    });

    await client.handleIncoming(JSON.stringify({ id: payload.id, result: { turn: {} } }));
    await expect(startPromise).resolves.toBeUndefined();
  });

  test("sends exact retry targets only after capability negotiation", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    await expect(
      client.startTurn("thread-1", "retry", "client-msg-old", ["failed-tool"]),
    ).rejects.toThrow("does not support exact tool retries");

    const handshakePromise = client.initialize();
    const initializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: true,
            toolRetryLineage: true,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await handshakePromise;

    const retryPromise = client.startTurn("thread-1", "retry", "client-msg-new", ["failed-tool"]);
    const retryPayload = JSON.parse(sent.at(-1)!);
    expect(retryPayload).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        clientMessageId: "client-msg-new",
        retry: {
          toolItemIds: ["failed-tool"],
        },
      },
    });
    await client.handleIncoming(
      JSON.stringify({
        id: retryPayload.id,
        result: { turn: {} },
      }),
    );
    await expect(retryPromise).resolves.toBeUndefined();
  });

  test("drops retired ui surface notifications", async () => {
    const sent: string[] = [];
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: { name: "cowork-mobile", version: "0.1.0" },
      send(text) {
        sent.push(text);
      },
      onNotification(message) {
        notifications.push(message);
      },
    });

    const handshakePromise = client.initialize();
    const initializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: { experimentalApi: false },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await handshakePromise;

    await client.handleIncoming(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: null,
          item: {
            id: "ui-surface-1",
            type: "uiSurface",
            surfaceId: "surface-1",
            catalogId: "https://REMOVEDUI.org/specification/v0_9/basic_catalog.json",
            version: "v0.9",
            revision: 2,
            deleted: false,
            changeKind: "updateComponents",
            reason: "refresh summary",
            toolCallId: "tool-1",
          },
        },
      }),
    );

    expect(notifications).toHaveLength(0);
  });

  test("rejects thread snapshots whose feed still contains retired ui surface items", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: { name: "cowork-mobile", version: "0.1.0" },
      send(text) {
        sent.push(text);
      },
    });

    const handshakePromise = client.initialize();
    const initializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: { experimentalApi: false },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await handshakePromise;

    const readPromise = client.readThread("thread-1");
    const readPayload = JSON.parse(sent.at(-1)!);
    await client.handleIncoming(
      JSON.stringify({
        id: readPayload.id,
        result: {
          thread: {
            id: "thread-1",
            title: "Thread",
            preview: "",
            modelProvider: "google",
            model: "gemini-3.1-pro-preview",
            cwd: "/workspace",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 1,
            lastEventSeq: 1,
            status: { type: "idle" },
          },
          coworkSnapshot: {
            sessionId: "session-1",
            title: "Thread",
            titleSource: "manual",
            titleModel: null,
            provider: "google",
            model: "gemini-3.1-pro-preview",
            sessionKind: "root",
            parentSessionId: null,
            role: null,
            mode: null,
            depth: null,
            nickname: null,
            requestedModel: null,
            effectiveModel: null,
            requestedReasoningEffort: null,
            effectiveReasoningEffort: null,
            executionState: null,
            lastMessagePreview: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 1,
            lastEventSeq: 1,
            feed: [
              {
                id: "ui-surface-1",
                kind: "ui_surface",
                ts: new Date().toISOString(),
                surfaceId: "surface-1",
                catalogId: "https://REMOVEDUI.org/specification/v0_9/basic_catalog.json",
                version: "v0.9",
                revision: 2,
                deleted: false,
                changeKind: "updateComponents",
                reason: "refresh summary",
                toolCallId: "tool-1",
              },
            ],
            agents: [],
            todos: [],
            hasPendingAsk: false,
            hasPendingApproval: false,
          },
        },
      }),
    );

    await expect(readPromise).rejects.toThrow();
  });

  test("resetTransportSession allows a fresh initialize handshake", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const firstHandshake = client.initialize();
    const firstInitializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: firstInitializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await firstHandshake;
    expect(JSON.parse(sent[1]!).method).toBe("initialized");

    client.resetTransportSession("Socket closed");

    const secondHandshake = client.initialize();
    const secondInitializePayload = JSON.parse(sent[2]!);
    expect(secondInitializePayload.method).toBe("initialize");
    expect(secondInitializePayload.id).not.toBe(firstInitializePayload.id);
    await client.handleIncoming(
      JSON.stringify({
        id: secondInitializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await secondHandshake;
    expect(JSON.parse(sent[3]!).method).toBe("initialized");
  });

  test("recovers when a local reset reinitializes an already-initialized server session", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const firstHandshake = client.initialize();
    const firstInitializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: firstInitializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );
    await firstHandshake;

    client.resetTransportSession("Transient transport state reset.");

    const resumePromise = client.resumeThread("thread-1");
    const secondInitializePayload = JSON.parse(sent[2]!);
    expect(secondInitializePayload.method).toBe("initialize");
    await client.handleIncoming(
      JSON.stringify({
        id: secondInitializePayload.id,
        error: {
          code: -32003,
          message: "Already initialized",
        },
      }),
    );

    await waitForCondition(() => sent.length >= 4);
    const initializedPayload = JSON.parse(sent[3]!);
    expect(initializedPayload.method).toBe("initialized");

    await waitForCondition(() => sent.length >= 5);
    const resumePayload = JSON.parse(sent[4]!);
    expect(resumePayload).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "thread-1",
      },
    });

    await client.handleIncoming(
      JSON.stringify({
        id: resumePayload.id,
        result: {
          thread: {
            id: "thread-1",
            title: "Remote thread",
            preview: "",
            modelProvider: "opencode",
            model: "gpt-5",
            cwd: "/workspace",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            messageCount: 1,
            lastEventSeq: 1,
            status: { type: "loaded" },
          },
        },
      }),
    );

    await expect(resumePromise).resolves.toMatchObject({
      thread: {
        id: "thread-1",
      },
    });
  });

  test("treats Already initialized response as success even when error code only is supplied", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const resumePromise = client.resumeThread("thread-1");
    const initializePayload = JSON.parse(sent[0]!);
    expect(initializePayload.method).toBe("initialize");
    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        error: {
          code: -32003,
          message: "Server reports prior initialization.",
        },
      }),
    );

    await waitForCondition(() => sent.length >= 3);
    expect(JSON.parse(sent[1]!).method).toBe("initialized");
    const resumePayload = JSON.parse(sent[2]!);
    expect(resumePayload).toMatchObject({
      method: "thread/resume",
      params: { threadId: "thread-1" },
    });

    await client.handleIncoming(
      JSON.stringify({
        id: resumePayload.id,
        result: {
          thread: {
            id: "thread-1",
            title: "Remote thread",
            preview: "",
            modelProvider: "opencode",
            model: "gpt-5",
            cwd: "/workspace",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            messageCount: 1,
            lastEventSeq: 1,
            status: { type: "loaded" },
          },
        },
      }),
    );

    await expect(resumePromise).resolves.toMatchObject({
      thread: { id: "thread-1" },
    });
  });

  test("shares concurrent initialize calls across one handshake", async () => {
    const sent: string[] = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
      },
    });

    const firstInitialize = client.initialize();
    const secondInitialize = client.initialize();
    const initializePayload = JSON.parse(sent[0]!);

    expect(sent).toHaveLength(1);
    expect(initializePayload.method).toBe("initialize");

    await client.handleIncoming(
      JSON.stringify({
        id: initializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );

    await expect(Promise.all([firstInitialize, secondInitialize])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(sent.map((payload) => JSON.parse(payload).method)).toEqual([
      "initialize",
      "initialized",
    ]);
  });

  test("rejects stale initialize work after a transport reset", async () => {
    const sent: string[] = [];
    const firstInitializeSend = createDeferred<void>();
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send(text) {
        sent.push(text);
        if (JSON.parse(text).method === "initialize" && sent.length === 1) {
          return firstInitializeSend.promise;
        }
      },
    });

    const firstInitialize = client.initialize();
    const firstInitializePayload = JSON.parse(sent[0]!);
    await client.handleIncoming(
      JSON.stringify({
        id: firstInitializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );

    client.resetTransportSession("Socket closed");
    firstInitializeSend.resolve();
    await expect(firstInitialize).rejects.toThrow("Transport session reset while initializing.");

    const secondInitialize = client.initialize();
    const secondInitializePayload = JSON.parse(sent[1]!);
    expect(secondInitializePayload.method).toBe("initialize");
    expect(secondInitializePayload.id).not.toBe(firstInitializePayload.id);

    await client.handleIncoming(
      JSON.stringify({
        id: secondInitializePayload.id,
        result: {
          protocolVersion: "0.1",
          serverInfo: {
            name: "cowork-server",
            subprotocol: "cowork.jsonrpc.v1",
          },
          capabilities: {
            experimentalApi: false,
          },
          transport: {
            type: "websocket",
            protocolMode: "jsonrpc",
          },
        },
      }),
    );

    await expect(secondInitialize).resolves.toBeUndefined();
    expect(JSON.parse(sent[2]!).method).toBe("initialized");
  });

  test("cleans up pending requests when send fails", async () => {
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send() {
        throw new Error("offline");
      },
      requestTimeoutMs: 60_000,
    });

    await expect(client.initialize()).rejects.toThrow("offline");
    expect((client as any).pending.size).toBe(0);
  });

  test("handles request timeout before a slow send completes", async () => {
    const slowSend = createDeferred<void>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const client = new CoworkJsonRpcClient({
        clientInfo: {
          name: "cowork-mobile",
          version: "0.1.0",
        },
        send() {
          return slowSend.promise;
        },
        requestTimeoutMs: 1,
      });

      const initialize = client.initialize();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      slowSend.resolve();
      await expect(initialize).rejects.toThrow("JSON-RPC request timed out: initialize");
      await flushMicrotasks();
      expect(unhandled).toEqual([]);
      expect((client as any).pending.size).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("ignores malformed incoming payloads", async () => {
    const notifications: Array<{ method: string; params?: unknown }> = [];
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send() {
        // ignore
      },
      onNotification(message) {
        notifications.push(message);
      },
    });

    await expect(client.handleIncoming("{")).resolves.toBeUndefined();
    await expect(
      client.handleIncoming(
        JSON.stringify({
          method: "thread/started",
          params: { bad: true },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(notifications).toEqual([]);
  });
});
