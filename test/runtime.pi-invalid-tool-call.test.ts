import { describe, expect, test } from "bun:test";

import {
  buildInvalidToolCallFormatReminderMessage,
  extractToolExecutionErrorMessage,
  shouldAddInvalidToolCallFormatReminder,
} from "../src/runtime/pi/tools";
import { INVALID_TOOL_CALL_FORMAT_REMINDER } from "../src/runtime/pi/types";
import type { RuntimeToolMap } from "../src/runtime/types";

const tools: RuntimeToolMap = {
  read: { inputSchema: {}, execute: async () => null },
};

const call = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  id: name,
  arguments: args,
});

describe("extractToolExecutionErrorMessage", () => {
  test("returns undefined unless isError is exactly true", () => {
    expect(extractToolExecutionErrorMessage({ isError: false, error: "hidden" })).toBeUndefined();
    expect(extractToolExecutionErrorMessage({ error: "hidden" })).toBeUndefined();
    expect(extractToolExecutionErrorMessage("not an object")).toBeUndefined();
    expect(extractToolExecutionErrorMessage(null)).toBeUndefined();
  });

  test("prefers joined content text over error or message fields", () => {
    expect(
      extractToolExecutionErrorMessage({
        isError: true,
        content: [
          { type: "text", text: "first" },
          { type: "json", text: "ignored" },
          { type: "text", text: "second" },
        ],
        error: "explicit error",
        message: "explicit message",
      }),
    ).toBe("first\n\nsecond");
  });

  test("falls back to trimmed error, then message, then JSON", () => {
    expect(
      extractToolExecutionErrorMessage({
        isError: true,
        content: [{ type: "text", text: "   " }],
        error: "  explicit error  ",
        message: "explicit message",
      }),
    ).toBe("explicit error");
    expect(
      extractToolExecutionErrorMessage({
        isError: true,
        message: "  explicit message  ",
      }),
    ).toBe("explicit message");
    expect(extractToolExecutionErrorMessage({ isError: true, extra: 1 })).toBe(
      JSON.stringify({ isError: true, extra: 1 }),
    );
  });
});

describe("shouldAddInvalidToolCallFormatReminder", () => {
  test("does not remind for successful results or empty names/messages", () => {
    expect(shouldAddInvalidToolCallFormatReminder(call("read"), { isError: false }, tools)).toBe(
      false,
    );
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("   "),
        { isError: true, error: "Invalid input" },
        tools,
      ),
    ).toBe(false);
    expect(shouldAddInvalidToolCallFormatReminder(call("read"), { isError: true }, tools)).toBe(
      false,
    );
  });

  test("reminds for unknown tools whose names look like leaked XML or markers", () => {
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("tool<read>"),
        { isError: true, error: "Tool tool<read> not found" },
        tools,
      ),
    ).toBe(true);
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("arg_key"),
        { isError: true, error: "Tool arg_key not found" },
        tools,
      ),
    ).toBe(true);
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("tool_call"),
        { isError: true, error: "Tool tool_call not found" },
        tools,
      ),
    ).toBe(true);
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("tool missing"),
        { isError: true, error: "Tool tool missing not found" },
        tools,
      ),
    ).toBe(true);
  });

  test("does not treat a valid unknown name plus a generic not-found error as a format leak", () => {
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("read_file"),
        { isError: true, error: "Tool read_file not found" },
        tools,
      ),
    ).toBe(false);
  });

  test("reminds for known tools only when arguments are empty and the error looks like schema failure", () => {
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("read"),
        { isError: true, error: "Invalid input" },
        tools,
      ),
    ).toBe(true);
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("read"),
        { isError: true, error: "Expected string, received number" },
        tools,
      ),
    ).toBe(true);
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("read"),
        { isError: true, error: "Too small: expected array to have >=1 items" },
        tools,
      ),
    ).toBe(true);
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("read", { path: "README.md" }),
        { isError: true, error: "Invalid input" },
        tools,
      ),
    ).toBe(false);
    expect(
      shouldAddInvalidToolCallFormatReminder(
        call("read"),
        { isError: true, error: "permission denied" },
        tools,
      ),
    ).toBe(false);
  });

  test("builds the shared recovery reminder message", () => {
    expect(buildInvalidToolCallFormatReminderMessage()).toEqual({
      role: "assistant",
      content: [{ type: "text", text: INVALID_TOOL_CALL_FORMAT_REMINDER }],
    });
  });
});
