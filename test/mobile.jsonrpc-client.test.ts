import { describe, expect, test } from "bun:test";

import { CoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/jsonRpcClient";

function flushMicrotasks() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
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
        },
      }),
    );
    await expect(listPromise).resolves.toEqual({ threads: [] });

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
        },
      }),
    );
    await expect(listPromise).resolves.toEqual({ threads: [] });

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

  test("accepts uiSurface notifications with A2UI metadata fields", async () => {
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
            id: "uiSurface:surface-1",
            type: "uiSurface",
            surfaceId: "surface-1",
            catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
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

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.method).toBe("item/completed");
  });

  test("accepts thread snapshots whose ui_surface feed items include A2UI metadata fields", async () => {
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
                catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
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

    await expect(readPromise).resolves.toMatchObject({
      coworkSnapshot: {
        feed: [
          expect.objectContaining({
            kind: "ui_surface",
            changeKind: "updateComponents",
            reason: "refresh summary",
            toolCallId: "tool-1",
          }),
        ],
      },
    });
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
