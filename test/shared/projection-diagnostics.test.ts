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

describe("conversationProjectionDiagnostics", () => {
  test("formatAskSystemLine strips a leading question label before truncating, then prefixes it again", () => {
    expect(formatAskSystemLine(askEvent("   "))).toBe("question:");
    expect(formatAskSystemLine(askEvent("Question:  Focus on auth"))).toBe(
      "question: Focus on auth",
    );

    const formatted = formatAskSystemLine(askEvent(`question: ${"word ".repeat(60).trim()}`));
    expect(formatted.startsWith("question: word word")).toBe(true);
    expect(formatted.endsWith("...")).toBe(true);
    expect(formatted.length).toBe("question: ".length + 222);
  });

  test("formatApprovalSystemLine omits a blank command and otherwise includes the trimmed command", () => {
    expect(formatApprovalSystemLine(approvalEvent("   "))).toBe("approval requested");
    expect(formatApprovalSystemLine(approvalEvent(" git status "))).toBe(
      "approval requested: git status",
    );
  });

  test("shouldSuppressRawDebugLogLine suppresses raw stream and provider debug payloads", () => {
    for (const line of ["", "   ", "tool finished"]) {
      expect(shouldSuppressRawDebugLogLine(line)).toBe(false);
    }
    for (const line of [
      'raw stream part: {"type":"response.output"}',
      "response.function_call_arguments.delta",
      "response.reasoning_summary",
      '{"type": "response.output_item"}',
      "token obfuscation payload",
    ]) {
      expect(shouldSuppressRawDebugLogLine(line)).toBe(true);
    }
  });
});
