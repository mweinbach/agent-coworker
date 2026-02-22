import { describe, expect, test } from "bun:test";

import { safeJsonParse, safeParseServerEvent } from "../src/client/agentSocket";

describe("agent socket parser", () => {
  test("safeJsonParse returns null for invalid JSON", () => {
    expect(safeJsonParse("{not json")).toBeNull();
  });

  test("safeParseServerEvent rejects events without required envelope fields", () => {
    const missingSession = JSON.stringify({
      type: "server_hello",
      config: { provider: "google", model: "gemini", workingDirectory: "/" },
    });
    expect(safeParseServerEvent(missingSession)).toBeNull();

    const unknownType = JSON.stringify({ type: "unknown_event", sessionId: "s-1" });
    expect(safeParseServerEvent(unknownType)).toBeNull();
  });

  test("safeParseServerEvent accepts known server event envelope", () => {
    const raw = JSON.stringify({
      type: "server_hello",
      sessionId: "s-1",
      config: { provider: "google", model: "gemini", workingDirectory: "/" },
    });

    const parsed = safeParseServerEvent(raw);
    expect(parsed?.type).toBe("server_hello");
    expect(parsed?.sessionId).toBe("s-1");
  });
});
