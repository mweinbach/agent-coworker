import { describe, expect, test } from "bun:test";

import {
  createHttpJsonRpcConnection,
  dispatchHttpRpcMessage,
  parseJsonRpcPayload,
} from "../src/server/transport/httpJsonRpcConnection";

function stubRuntime() {
  return {
    handleDecodedMessage() {},
    openHttpConnection() {},
    closeConnection() {},
  };
}

describe("parseJsonRpcPayload", () => {
  test("rejects non-object payloads before dispatch", () => {
    for (const raw of [null, undefined, 1, "rpc", true, []]) {
      expect(() => parseJsonRpcPayload(raw)).toThrow("JSON-RPC payload must be an object.");
    }
  });

  test("rejects response envelopes with a non-string/number id", () => {
    expect(() => parseJsonRpcPayload({ id: true, result: {} })).toThrow(
      "JSON-RPC response id must be a string or number.",
    );
    expect(() => parseJsonRpcPayload({ id: { nested: 1 }, error: { code: -1 } })).toThrow(
      "JSON-RPC response id must be a string or number.",
    );
  });

  test("rejects missing, blank, or non-string methods", () => {
    expect(() => parseJsonRpcPayload({})).toThrow("JSON-RPC method is required.");
    expect(() => parseJsonRpcPayload({ method: "   " })).toThrow("JSON-RPC method is required.");
    expect(() => parseJsonRpcPayload({ method: 12, id: 1 })).toThrow(
      "JSON-RPC method is required.",
    );
  });

  test("rejects request ids that are not a string or number", () => {
    expect(() => parseJsonRpcPayload({ method: "turn/start", id: false })).toThrow(
      "JSON-RPC id must be a string or number.",
    );
    expect(() => parseJsonRpcPayload({ method: "turn/start", id: { value: 1 } })).toThrow(
      "JSON-RPC id must be a string or number.",
    );
  });

  test("parses notifications, requests, and responses and drops extra fields", () => {
    expect(
      parseJsonRpcPayload({ method: "cowork/session/state/read", params: { cwd: "/tmp" } }),
    ).toEqual({
      method: "cowork/session/state/read",
      params: { cwd: "/tmp" },
    });

    expect(
      parseJsonRpcPayload({
        id: "req-1",
        method: "turn/start",
        params: { text: "hello" },
        extra: true,
      }),
    ).toEqual({
      id: "req-1",
      method: "turn/start",
      params: { text: "hello" },
    });

    expect(parseJsonRpcPayload({ id: 7, result: { ok: true }, leftover: "nope" })).toEqual({
      id: 7,
      result: { ok: true },
      error: undefined,
    });
  });
});

describe("dispatchHttpRpcMessage", () => {
  test("returns 400 with the parser message for invalid payloads", async () => {
    const response = await dispatchHttpRpcMessage([], {
      async dispatch() {
        throw new Error("should not dispatch");
      },
    } as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "JSON-RPC payload must be an object." });
  });

  test("returns 202 for notifications and responses without a method", async () => {
    const dispatched: unknown[] = [];
    const connection = {
      async dispatch(message: unknown) {
        dispatched.push(message);
        return { unused: true };
      },
    };

    const notification = await dispatchHttpRpcMessage(
      { method: "cowork/session/settings" },
      connection as never,
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");

    const clientResponse = await dispatchHttpRpcMessage(
      { id: "ack-1", result: { ok: true } },
      connection as never,
    );
    expect(clientResponse.status).toBe(202);
    expect(dispatched).toHaveLength(2);
  });

  test("returns 503 when the connection rejects a request", async () => {
    const response = await dispatchHttpRpcMessage({ id: 1, method: "turn/start", params: {} }, {
      async dispatch() {
        throw new Error("HTTP JSON-RPC connection closed.");
      },
    } as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "HTTP JSON-RPC connection closed." });
  });
});

describe("createHttpJsonRpcConnection", () => {
  test("resolves a pending request from send and rejects leftovers on close", async () => {
    const connection = createHttpJsonRpcConnection(stubRuntime() as never);
    const pending = connection.dispatch({ id: 11, method: "turn/start", params: {} });

    connection.send(JSON.stringify({ id: 11, result: { accepted: true } }));
    await expect(pending).resolves.toEqual({ id: 11, result: { accepted: true } });

    const leftover = connection.dispatch({ id: "open", method: "turn/steer", params: {} });
    connection.close();
    await expect(leftover).rejects.toThrow("HTTP JSON-RPC connection closed.");
  });

  test("does not treat a string id as the same pending key as a numeric id", async () => {
    const connection = createHttpJsonRpcConnection(stubRuntime() as never);
    const numeric = connection.dispatch({ id: 1, method: "a", params: {} });
    const textual = connection.dispatch({ id: "1", method: "b", params: {} });

    connection.send(JSON.stringify({ id: "1", result: { kind: "string" } }));
    await expect(textual).resolves.toEqual({ id: "1", result: { kind: "string" } });

    connection.close();
    await expect(numeric).rejects.toThrow("HTTP JSON-RPC connection closed.");
  });
});
