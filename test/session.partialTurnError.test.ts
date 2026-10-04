import { describe, expect, test } from "bun:test";

import {
  getPartialTurnProviderState,
  getPartialTurnResponseMessages,
  resolvePartialTurnProgressSource,
} from "../src/server/session/turnExecution/partialTurnError";

describe("partial turn error salvage", () => {
  test("prefers the actual error only when it already carries responseMessages", () => {
    const fallback = { responseMessages: [{ role: "assistant", content: "fallback" }] };
    const actual = {
      responseMessages: [{ role: "assistant", content: "actual" }],
      providerState: { id: "p1" },
    };

    expect(resolvePartialTurnProgressSource(actual, fallback)).toBe(actual);
    expect(resolvePartialTurnProgressSource({ message: "missing messages" }, fallback)).toBe(
      fallback,
    );
    expect(resolvePartialTurnProgressSource("boom", fallback)).toBe(fallback);
    expect(resolvePartialTurnProgressSource(null, fallback)).toBe(fallback);
  });

  test("reads responseMessages only from array-bearing objects", () => {
    const messages = [{ role: "assistant" as const, content: "hello" }];
    expect(getPartialTurnResponseMessages({ responseMessages: messages })).toEqual(messages);
    expect(getPartialTurnResponseMessages({ responseMessages: [] })).toEqual([]);
    expect(
      getPartialTurnResponseMessages({ responseMessages: { role: "assistant" } }),
    ).toBeUndefined();
    expect(getPartialTurnResponseMessages("not-an-object")).toBeUndefined();
    expect(getPartialTurnResponseMessages(null)).toBeUndefined();
  });

  test("passes through object or null provider state and drops invalid shapes", () => {
    const state = { previousResponseId: "resp_1" };
    expect(getPartialTurnProviderState({ providerState: state })).toEqual(state);
    expect(getPartialTurnProviderState({ providerState: null })).toBeNull();
    expect(getPartialTurnProviderState({ providerState: "stale" })).toBeUndefined();
    expect(getPartialTurnProviderState({ providerState: 12 })).toBeUndefined();
    expect(getPartialTurnProviderState("boom")).toBeUndefined();
  });
});
