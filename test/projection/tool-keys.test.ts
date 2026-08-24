import { describe, expect, test } from "bun:test";

import {
  incompleteToolStreamError,
  shouldReuseLatestToolItemByName,
  toolArgsFromApproval,
  toolNameFromApproval,
  toolSyntheticApprovalKey,
  toolTurnNameKey,
} from "../../src/server/projection/conversationProjectionToolKeys";
import { normalizeToolArgsFromInput, occurrenceItemId } from "../../src/server/projection/shared";

describe("projection tool-key helpers", () => {
  test("toolNameFromApproval prefers name aliases and fails closed to tool", () => {
    expect(toolNameFromApproval({ name: "  bash  " })).toBe("bash");
    expect(toolNameFromApproval({ toolName: "webFetch" })).toBe("webFetch");
    expect(toolNameFromApproval({ functionName: "read" })).toBe("read");
    expect(toolNameFromApproval({ name: "", toolName: "grep" })).toBe("tool");
    expect(toolNameFromApproval({ name: "   ", toolName: "grep" })).toBe("tool");
    expect(toolNameFromApproval(["bash"])).toBe("tool");
    expect(toolNameFromApproval(null)).toBe("tool");
  });

  test("toolArgsFromApproval prefers arguments then input, otherwise the payload", () => {
    expect(toolArgsFromApproval({ arguments: { path: "a" }, input: { path: "b" } })).toEqual({
      path: "a",
    });
    expect(toolArgsFromApproval({ input: { url: "https://example.com" } })).toEqual({
      url: "https://example.com",
    });
    expect(toolArgsFromApproval("raw")).toBe("raw");
  });

  test("native search and url-context tool cards do not reuse by name", () => {
    expect(shouldReuseLatestToolItemByName("nativeWebSearch")).toBe(false);
    expect(shouldReuseLatestToolItemByName("nativeUrlContext")).toBe(false);
    expect(shouldReuseLatestToolItemByName("webSearch")).toBe(true);
    expect(shouldReuseLatestToolItemByName("bash")).toBe(true);
  });

  test("occurrenceItemId stays occurrence-stable for the first item", () => {
    expect(occurrenceItemId("tool-1", 1)).toBe("tool-1");
    expect(occurrenceItemId("tool-1", 0)).toBe("tool-1");
    expect(occurrenceItemId("tool-1", 2)).toBe("tool-1:2");
  });

  test("normalizeToolArgsFromInput merges parsed JSON and preserves raw input on parse failure", () => {
    expect(normalizeToolArgsFromInput('{"path":"README.md"}', { input: "old", extra: 1 })).toEqual({
      extra: 1,
      path: "README.md",
    });
    expect(normalizeToolArgsFromInput("not-json", { extra: true, input: "stale" })).toEqual({
      extra: true,
      input: "not-json",
    });
    expect(normalizeToolArgsFromInput("not-json")).toEqual({ input: "not-json" });
  });

  test("approval keys keep turn identity and incomplete errors keep the default message", () => {
    expect(toolTurnNameKey("turn-1", "bash")).toBe("turn-1:bash");
    expect(toolSyntheticApprovalKey("turn-1", "appr-9")).toBe("turn-1:approval:appr-9");
    expect(incompleteToolStreamError()).toEqual({
      error: "Turn failed before the tool call completed.",
    });
    expect(incompleteToolStreamError("boom")).toEqual({ error: "boom" });
  });
});
