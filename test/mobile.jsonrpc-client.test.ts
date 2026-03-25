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

    await client.handleIncoming(JSON.stringify({
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
    }));
    await handshakePromise;

    const initializedPayload = JSON.parse(sent[1]!);
    expect(initializedPayload.method).toBe("initialized");
    const listPromise = client.requestThreadList();
    const listPayload = JSON.parse(sent.at(-1)!);
    await client.handleIncoming(JSON.stringify({
      id: listPayload.id,
      result: {
        threads: [],
      },
    }));
    await expect(listPromise).resolves.toEqual({ threads: [] });

    await flushMicrotasks();

    await client.handleIncoming(JSON.stringify({
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
    }));

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
    await client.handleIncoming(JSON.stringify({
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
    }));
    await handshakePromise;

    const listPromise = client.requestThreadList();
    const listPayload = JSON.parse(sent.at(-1)!);
    await client.handleIncoming(JSON.stringify({
      id: listPayload.id,
      result: {
        threads: [],
      },
    }));
    await expect(listPromise).resolves.toEqual({ threads: [] });

    await client.handleIncoming(JSON.stringify({
      id: 7,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        requestId: "req-1",
        itemId: "item-1",
        question: "Continue?",
      },
    }));
    await flushMicrotasks();
    expect(requests).toEqual([{ id: 7, method: "item/tool/requestUserInput" }]);

    await client.respondServerRequest(7, { answer: "yes" });
    const responsePayload = JSON.parse(sent.at(-1)!);
    expect(responsePayload).toEqual({
      id: 7,
      result: { answer: "yes" },
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
    await client.handleIncoming(JSON.stringify({
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
    }));
    await firstHandshake;
    expect(JSON.parse(sent[1]!).method).toBe("initialized");

    client.resetTransportSession("Socket closed");

    const secondHandshake = client.initialize();
    const secondInitializePayload = JSON.parse(sent[2]!);
    expect(secondInitializePayload.method).toBe("initialize");
    expect(secondInitializePayload.id).not.toBe(firstInitializePayload.id);
    await client.handleIncoming(JSON.stringify({
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
    }));
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
    await expect(client.handleIncoming(JSON.stringify({
      method: "thread/started",
      params: { bad: true },
    }))).resolves.toBeUndefined();
    expect(notifications).toEqual([]);
  });
});
