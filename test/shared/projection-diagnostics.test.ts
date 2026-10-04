import { describe, expect, test } from "bun:test";

import {
  formatApprovalSystemLine,
  formatAskSystemLine,
  shouldSuppressRawDebugLogLine,
} from "../../src/server/projection/conversationProjectionDiagnostics";
import type { SessionEvent } from "../../src/server/protocol";

const askEvent = (question: string): Extract<SessionEvent, { type: "ask" }> => ({
  type: "ask",
  sessionId: "session-1",
  requestId: "ask-1",
  question,
});

const approvalEvent = (command: string): Extract<SessionEvent, { type: "approval" }> => ({
  type: "approval",
  sessionId: "session-1",
  requestId: "approval-1",
  command,
  dangerous: false,
  reasonCode: "requires_manual_review",
});

describe("formatAskSystemLine", () => {
  test("strips a leading question label before truncating, then prefixes it again", () => {
    expect(formatAskSystemLine(askEvent("   "))).toBe("question:");
    expect(formatAskSystemLine(askEvent("Question:  Focus on auth"))).toBe(
      "question: Focus on auth",
    );

    const longQuestion = `question: ${"word ".repeat(60).trim()}`;
    const formatted = formatAskSystemLine(askEvent(longQuestion));
    expect(formatted.startsWith("question: word word")).toBe(true);
    expect(formatted.endsWith("...")).toBe(true);
    expect(formatted.length).toBe("question: ".length + 222);
  });
});

describe("formatApprovalSystemLine", () => {
  test("omits a blank command and otherwise includes the trimmed command", () => {
    expect(formatApprovalSystemLine(approvalEvent("   "))).toBe("approval requested");
    expect(formatApprovalSystemLine(approvalEvent(" git status "))).toBe(
      "approval requested: git status",
    );
  });
});

describe("shouldSuppressRawDebugLogLine", () => {
  test("suppresses raw stream and provider debug payloads but keeps ordinary logs", () => {
    expect(shouldSuppressRawDebugLogLine("")).toBe(false);
    expect(shouldSuppressRawDebugLogLine("   ")).toBe(false);
    expect(shouldSuppressRawDebugLogLine("tool finished")).toBe(false);
    expect(shouldSuppressRawDebugLogLine('raw stream part: {"type":"response.output"}')).toBe(true);
    expect(shouldSuppressRawDebugLogLine("response.function_call_arguments.delta")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("response.reasoning_summary")).toBe(true);
    expect(shouldSuppressRawDebugLogLine('{"type": "response.output_item"}')).toBe(true);
    expect(shouldSuppressRawDebugLogLine("token obfuscation payload")).toBe(true);
  });
});
