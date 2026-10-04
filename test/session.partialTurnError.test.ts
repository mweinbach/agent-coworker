import { describe, expect, test } from "bun:test";
import {
  getPartialTurnProviderState,
  getPartialTurnResponseMessages,
  resolvePartialTurnProgressSource,
} from "../src/server/session/turnExecution/partialTurnError";

describe("partial turn error salvage", () => {
  test("salvages progress source, responseMessages, and providerState only from valid shapes", () => {
    const fallback = { responseMessages: [{ role: "assistant", content: "fallback" }] };
    const actual = {
      responseMessages: [{ role: "assistant", content: "actual" }],
      providerState: { id: "p1" },
    };
    expect(resolvePartialTurnProgressSource(actual, fallback)).toBe(actual);
    for (const v of [{ message: "missing messages" }, "boom", null]) {
      expect(resolvePartialTurnProgressSource(v, fallback)).toBe(fallback);
    }

    const messages = [{ role: "assistant" as const, content: "hello" }];
    expect(getPartialTurnResponseMessages({ responseMessages: messages })).toEqual(messages);
    expect(getPartialTurnResponseMessages({ responseMessages: [] })).toEqual([]);
    for (const v of [{ responseMessages: { role: "assistant" } }, "not-an-object", null]) {
      expect(getPartialTurnResponseMessages(v)).toBeUndefined();
    }

    const state = { previousResponseId: "resp_1" };
    expect(getPartialTurnProviderState({ providerState: state })).toEqual(state);
    expect(getPartialTurnProviderState({ providerState: null })).toBeNull();
    for (const v of [{ providerState: "stale" }, { providerState: 12 }, "boom"]) {
      expect(getPartialTurnProviderState(v)).toBeUndefined();
    }
  });
});
