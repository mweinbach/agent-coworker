import { describe, expect, test } from "bun:test";

import {
  computeRelayReconnectDelayMs,
  createRelaySharedKey,
  decodeRelaySecureEnvelope,
  encodeRelaySecureEnvelope,
  generateRelayKeyPair,
  isCoworkJsonRpcPayload,
  isValidRelayKeyPair,
  parseRelayControlMessage,
} from "../src/shared/mobileRelaySecurity";

describe("mobile relay security helpers", () => {
  test("generates valid relay key pairs", () => {
    const keyPair = generateRelayKeyPair();
    expect(isValidRelayKeyPair(keyPair)).toBe(true);
  });

  test("encrypts and decrypts JSON-RPC payloads", () => {
    const macKeyPair = generateRelayKeyPair();
    const phoneKeyPair = generateRelayKeyPair();
    const sessionId = "session-1";
    const sharedKey = createRelaySharedKey(
      macKeyPair.privateKeyBase64,
      phoneKeyPair.publicKeyBase64,
      sessionId,
    );

    const envelope = encodeRelaySecureEnvelope({
      sharedKey,
      sender: "mac",
      counter: 1,
      plaintext: JSON.stringify({
        id: 1,
        method: "thread/list",
        params: {},
      }),
    });

    const decoded = decodeRelaySecureEnvelope({
      sharedKey: createRelaySharedKey(
        phoneKeyPair.privateKeyBase64,
        macKeyPair.publicKeyBase64,
        sessionId,
      ),
      rawMessage: JSON.stringify(envelope),
      expectedSender: "mac",
      lastAcceptedCounter: 0,
    });

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(JSON.parse(decoded.plaintext)).toEqual({
        id: 1,
        method: "thread/list",
        params: {},
      });
    }
  });

  test("rejects replayed encrypted payloads", () => {
    const macKeyPair = generateRelayKeyPair();
    const phoneKeyPair = generateRelayKeyPair();
    const sessionId = "session-1";
    const sharedKey = createRelaySharedKey(
      macKeyPair.privateKeyBase64,
      phoneKeyPair.publicKeyBase64,
      sessionId,
    );

    const envelope = encodeRelaySecureEnvelope({
      sharedKey,
      sender: "phone",
      counter: 2,
      plaintext: JSON.stringify({
        id: 3,
        result: {},
      }),
    });

    const decoded = decodeRelaySecureEnvelope({
      sharedKey: createRelaySharedKey(
        phoneKeyPair.privateKeyBase64,
        macKeyPair.publicKeyBase64,
        sessionId,
      ),
      rawMessage: JSON.stringify(envelope),
      expectedSender: "phone",
      lastAcceptedCounter: 2,
    });

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error).toContain("replayed");
    }
  });

  test("rejects non JSON-RPC secure payloads", () => {
    const macKeyPair = generateRelayKeyPair();
    const phoneKeyPair = generateRelayKeyPair();
    const sessionId = "session-1";
    const sharedKey = createRelaySharedKey(
      macKeyPair.privateKeyBase64,
      phoneKeyPair.publicKeyBase64,
      sessionId,
    );

    const envelope = encodeRelaySecureEnvelope({
      sharedKey,
      sender: "phone",
      counter: 1,
      plaintext: JSON.stringify({
        hello: "world",
      }),
    });

    const decoded = decodeRelaySecureEnvelope({
      sharedKey: createRelaySharedKey(
        phoneKeyPair.privateKeyBase64,
        macKeyPair.publicKeyBase64,
        sessionId,
      ),
      rawMessage: JSON.stringify(envelope),
      expectedSender: "phone",
      lastAcceptedCounter: 0,
    });

    expect(decoded.ok).toBe(false);
    expect(isCoworkJsonRpcPayload(JSON.stringify({ hello: "world" }))).toBe(false);
  });

  test("derives distinct secure keys for different relay sessions", () => {
    const macKeyPair = generateRelayKeyPair();
    const phoneKeyPair = generateRelayKeyPair();
    const firstSessionKey = createRelaySharedKey(
      macKeyPair.privateKeyBase64,
      phoneKeyPair.publicKeyBase64,
      "session-1",
    );
    const secondSessionKey = createRelaySharedKey(
      phoneKeyPair.privateKeyBase64,
      macKeyPair.publicKeyBase64,
      "session-2",
    );

    expect(Array.from(firstSessionKey)).not.toEqual(Array.from(secondSessionKey));

    const envelope = encodeRelaySecureEnvelope({
      sharedKey: firstSessionKey,
      sender: "mac",
      counter: 1,
      plaintext: JSON.stringify({
        id: 1,
        method: "thread/list",
        params: {},
      }),
    });

    const decoded = decodeRelaySecureEnvelope({
      sharedKey: secondSessionKey,
      rawMessage: JSON.stringify(envelope),
      expectedSender: "mac",
      lastAcceptedCounter: 0,
    });

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error).toContain("decrypt");
    }
  });

  test("parses relay control messages and computes reconnect delay with jitter", () => {
    expect(parseRelayControlMessage(JSON.stringify({
      kind: "secureError",
      message: "bad payload",
    }))).toEqual({
      kind: "secureError",
      message: "bad payload",
    });

    expect(computeRelayReconnectDelayMs(3, {
      random: () => 0,
    })).toBe(3200);
    expect(computeRelayReconnectDelayMs(3, {
      random: () => 1,
    })).toBe(4800);
  });
});
