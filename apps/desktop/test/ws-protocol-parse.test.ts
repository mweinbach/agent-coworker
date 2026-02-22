import { describe, expect, test } from "bun:test";

import { safeJsonParse, safeParseServerEvent } from "../src/lib/wsProtocol";

describe("desktop ws protocol parser", () => {
  test("safeJsonParse returns null for invalid JSON", () => {
    expect(safeJsonParse("{invalid")).toBeNull();
  });

  test("safeParseServerEvent rejects malformed envelopes", () => {
    expect(
      safeParseServerEvent(JSON.stringify({ type: "server_hello" })),
    ).toBeNull();
    expect(
      safeParseServerEvent(JSON.stringify({ type: "totally_unknown", sessionId: "s-1" })),
    ).toBeNull();
  });

  test("safeParseServerEvent accepts known server event envelope", () => {
    const parsed = safeParseServerEvent(
      JSON.stringify({
        type: "server_hello",
        sessionId: "desktop-s1",
        config: {
          provider: "google",
          model: "gemini",
          workingDirectory: "/workspace",
        },
      }),
    );

    expect(parsed?.type).toBe("server_hello");
    expect(parsed?.sessionId).toBe("desktop-s1");
  });
});
