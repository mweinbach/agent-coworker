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
});
