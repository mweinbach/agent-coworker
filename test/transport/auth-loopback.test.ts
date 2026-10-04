import { describe, expect, test } from "bun:test";

import { parseBearerToken } from "../../src/server/transport/auth";
import { jsonResponse, withResponseHeaders } from "../../src/server/transport/httpResponse";
import { isLoopbackHost } from "../../src/server/transport/loopbackAddress";

describe("parseBearerToken", () => {
  test("extracts a case-insensitive Bearer token and fails closed otherwise", () => {
    for (const [header, expected] of [
      ["Bearer abc", "abc"],
      ["bearer abc", "abc"],
      ["BEARER  secret-token  ", "secret-token"],
      [" Bearer tok ", "tok"],
    ] as const) {
      expect(parseBearerToken(header)).toBe(expected);
    }
    for (const invalid of [null, "", "   ", "Bearer", "Bearer ", "Token abc", "Basic abc"]) {
      expect(parseBearerToken(invalid)).toBeNull();
    }
  });
});

describe("isLoopbackHost", () => {
  test("accepts loopback hosts and rejects non-loopback or blank hosts", () => {
    for (const host of [
      "127.0.0.1",
      " 127.0.0.1 ",
      "[127.0.0.1]",
      "::1",
      "[::1]",
      "LOCALHOST",
      "localhost",
      "::ffff:127.0.0.1",
      "[::ffff:127.0.0.1]",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of [
      null,
      undefined,
      "",
      "   ",
      "0.0.0.0",
      "10.0.0.1",
      "192.168.1.1",
      "127.0.0.2",
      "::2",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("HTTP JSON responses", () => {
  test("jsonResponse and withResponseHeaders preserve status, body, and merged headers", async () => {
    const response = jsonResponse({ error: "nope" }, { status: 403, headers: { "x-test": "1" } });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-test")).toBe("1");
    await expect(response.json()).resolves.toEqual({ error: "nope" });

    const noop = new Response("ok", { status: 204 });
    expect(withResponseHeaders(noop, undefined)).toBe(noop);
    expect(withResponseHeaders(noop, {})).toBe(noop);

    const base = jsonResponse({ ok: true }, { status: 201, headers: { "x-existing": "a" } });
    const merged = withResponseHeaders(base, {
      "x-existing": "b",
      "access-control-allow-origin": "http://localhost:5173",
    });
    expect(merged).not.toBe(base);
    expect(merged.status).toBe(201);
    expect(merged.headers.get("content-type")).toBe("application/json");
    expect(merged.headers.get("x-existing")).toBe("b");
    expect(merged.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    await expect(merged.json()).resolves.toEqual({ ok: true });
  });
});
