import { describe, expect, test } from "bun:test";

import { parseBearerToken } from "../../src/server/transport/auth";
import { jsonResponse, withResponseHeaders } from "../../src/server/transport/httpResponse";
import { isLoopbackHost } from "../../src/server/transport/loopbackAddress";

describe("parseBearerToken", () => {
  test("extracts a case-insensitive Bearer token and trims surrounding whitespace", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer abc")).toBe("abc");
    expect(parseBearerToken("BEARER  secret-token  ")).toBe("secret-token");
    expect(parseBearerToken(" Bearer tok ")).toBe("tok");
  });

  test("fails closed for missing, empty, or non-Bearer credentials", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("   ")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
    expect(parseBearerToken("Token abc")).toBeNull();
    expect(parseBearerToken("Basic abc")).toBeNull();
  });
});

describe("isLoopbackHost", () => {
  test.each([
    "127.0.0.1",
    " 127.0.0.1 ",
    "[127.0.0.1]",
    "::1",
    "[::1]",
    "LOCALHOST",
    "localhost",
    "::ffff:127.0.0.1",
    "[::ffff:127.0.0.1]",
  ])("accepts %s", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
    ["0.0.0.0", "0.0.0.0"],
    ["10.0.0.1", "10.0.0.1"],
    ["192.168.1.1", "192.168.1.1"],
    ["127.0.0.2", "127.0.0.2"],
    ["::2", "::2"],
  ] as const)("rejects %s", (_label, host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("HTTP JSON responses", () => {
  test("jsonResponse serializes JSON and keeps caller headers/status", async () => {
    const response = jsonResponse({ error: "nope" }, { status: 403, headers: { "x-test": "1" } });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-test")).toBe("1");
    await expect(response.json()).resolves.toEqual({ error: "nope" });
  });

  test("withResponseHeaders leaves the original response when no headers are added", () => {
    const response = new Response("ok", { status: 204 });
    expect(withResponseHeaders(response, undefined)).toBe(response);
    expect(withResponseHeaders(response, {})).toBe(response);
  });

  test("withResponseHeaders merges headers without changing status or body", async () => {
    const response = jsonResponse({ ok: true }, { status: 201, headers: { "x-existing": "a" } });
    const merged = withResponseHeaders(response, {
      "x-existing": "b",
      "access-control-allow-origin": "http://localhost:5173",
    });

    expect(merged).not.toBe(response);
    expect(merged.status).toBe(201);
    expect(merged.headers.get("content-type")).toBe("application/json");
    expect(merged.headers.get("x-existing")).toBe("b");
    expect(merged.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    await expect(merged.json()).resolves.toEqual({ ok: true });
  });
});
