import { describe, expect, test } from "bun:test";

import { decodeClientMessage } from "../src/server/startServer/decodeClientMessage";

describe("decodeClientMessage", () => {
  test("decodes valid messages from Uint8Array payloads", () => {
    const raw = new Uint8Array(
      Buffer.from(JSON.stringify({ type: "user_message", sessionId: "s-1", text: "hello" }), "utf-8"),
    );

    const decoded = decodeClientMessage(raw, "s-1");
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.message.type).toBe("user_message");
      if (decoded.message.type === "user_message") {
        expect(decoded.message.text).toBe("hello");
      }
    }
  });

  test("decodes valid messages from ArrayBuffer payloads", () => {
    const encoded = Buffer.from(JSON.stringify({ type: "ping", sessionId: "s-1" }), "utf-8");
    const raw = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);

    const decoded = decodeClientMessage(raw, "s-1");
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.message.type).toBe("ping");
    }
  });

  test("maps malformed binary payloads to invalid_json", () => {
    const decoded = decodeClientMessage(new Uint8Array([0xff, 0xfe, 0xfd]), "s-1");

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.event.code).toBe("invalid_json");
      expect(decoded.event.source).toBe("protocol");
    }
  });

  test("maps unknown client message types from binary payloads", () => {
    const raw = new Uint8Array(
      Buffer.from(JSON.stringify({ type: "totally_unknown", sessionId: "s-1" }), "utf-8"),
    );
    const decoded = decodeClientMessage(raw, "s-1");

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.event.code).toBe("unknown_type");
      expect(decoded.event.message).toContain("Unknown type");
    }
  });

  test("maps non-object JSON payloads to invalid_payload", () => {
    const raw = new Uint8Array(Buffer.from(JSON.stringify(["not", "an", "object"]), "utf-8"));
    const decoded = decodeClientMessage(raw, "s-1");

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.event.code).toBe("invalid_payload");
      expect(decoded.event.sessionId).toBe("s-1");
      expect(decoded.event.message).toBe("Expected object");
    }
  });

  test("maps object payloads missing a type to missing_type", () => {
    const raw = new Uint8Array(Buffer.from(JSON.stringify({ sessionId: "s-1" }), "utf-8"));
    const decoded = decodeClientMessage(raw, "s-1");

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.event.code).toBe("missing_type");
      expect(decoded.event.message).toBe("Missing type");
      expect(decoded.event.source).toBe("protocol");
    }
  });

  test("maps known message validation failures to validation_failed", () => {
    const raw = new Uint8Array(Buffer.from(JSON.stringify({ type: "ping" }), "utf-8"));
    const decoded = decodeClientMessage(raw, "s-1");

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.event.code).toBe("validation_failed");
      expect(decoded.event.message).toBe("ping missing sessionId");
      expect(decoded.event.sessionId).toBe("s-1");
    }
  });

  test("decodes valid steer_message payloads", () => {
    const raw = new Uint8Array(
      Buffer.from(JSON.stringify({
        type: "steer_message",
        sessionId: "s-1",
        expectedTurnId: "turn-1",
        text: "continue in the same turn",
      }), "utf-8"),
    );

    const decoded = decodeClientMessage(raw, "s-1");
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.message.type).toBe("steer_message");
      if (decoded.message.type === "steer_message") {
        expect(decoded.message.expectedTurnId).toBe("turn-1");
      }
    }
  });

  test("maps invalid steer_message payloads to validation_failed", () => {
    const raw = new Uint8Array(
      Buffer.from(JSON.stringify({
        type: "steer_message",
        sessionId: "s-1",
        expectedTurnId: "   ",
        text: "continue",
      }), "utf-8"),
    );

    const decoded = decodeClientMessage(raw, "s-1");
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.event.code).toBe("validation_failed");
      expect(decoded.event.message).toBe("steer_message missing/invalid expectedTurnId");
    }
  });

  test("maps unsupported raw websocket payload types to invalid_json", () => {
    const decoded = decodeClientMessage({ bad: "payload" }, "s-1");

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.event.code).toBe("invalid_json");
      expect(decoded.event.message).toBe("Invalid JSON");
      expect(decoded.event.sessionId).toBe("s-1");
    }
  });
});
