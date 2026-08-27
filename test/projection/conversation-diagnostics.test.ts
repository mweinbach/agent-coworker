import { describe, expect, test } from "bun:test";

import {
  developerDiagnosticSystemLineFromSessionEvent,
  formatApprovalSystemLine,
  formatAskSystemLine,
  shouldSuppressRawDebugLogLine,
} from "../../src/server/projection/conversationProjectionDiagnostics";
import type { SessionEvent } from "../../src/server/protocol";

const sessionId = "session-1";

describe("conversation projection diagnostics", () => {
  test("suppresses raw provider debug stream lines and keeps benign logs", () => {
    expect(shouldSuppressRawDebugLogLine('raw stream part: {"type":"response.output_text"}')).toBe(
      true,
    );
    expect(shouldSuppressRawDebugLogLine("  RAW STREAM PART: hello  ")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("response.function_call_arguments.delta")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("response.reasoning_summary_text.delta")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("response.reasoning.delta")).toBe(true);
    expect(shouldSuppressRawDebugLogLine('{"type":"response.output_item.added"}')).toBe(true);
    expect(shouldSuppressRawDebugLogLine("token obfuscation payload")).toBe(true);
    expect(shouldSuppressRawDebugLogLine("")).toBe(false);
    expect(shouldSuppressRawDebugLogLine("   ")).toBe(false);
    expect(shouldSuppressRawDebugLogLine("Fetched 3 search results")).toBe(false);
    expect(shouldSuppressRawDebugLogLine("response completed")).toBe(false);
  });

  test("normalizes ask and approval system lines", () => {
    expect(
      formatAskSystemLine({
        type: "ask",
        sessionId,
        requestId: "ask-1",
        question: "  Question:   May I edit package.json?  ",
      }),
    ).toBe("question: May I edit package.json?");
    expect(
      formatAskSystemLine({
        type: "ask",
        sessionId,
        requestId: "ask-2",
        question: "   ",
      }),
    ).toBe("question:");
    expect(
      formatAskSystemLine({
        type: "ask",
        sessionId,
        requestId: "ask-3",
        question: `Question: ${"a".repeat(240)}`,
      }),
    ).toBe(`question: ${"a".repeat(219)}...`);

    expect(
      formatApprovalSystemLine({
        type: "approval",
        sessionId,
        requestId: "appr-1",
        command: "  rm -rf output  ",
        dangerous: true,
        reasonCode: "matches_dangerous_pattern",
      }),
    ).toBe("approval requested: rm -rf output");
    expect(
      formatApprovalSystemLine({
        type: "approval",
        sessionId,
        requestId: "appr-2",
        command: "   ",
        dangerous: false,
        reasonCode: "requires_manual_review",
      }),
    ).toBe("approval requested");
  });

  test("formats observability, backup, and harness diagnostic lines", () => {
    const observability: Extract<SessionEvent, { type: "observability_status" }> = {
      type: "observability_status",
      sessionId,
      enabled: true,
      health: {
        status: "degraded",
        reason: "export_failed",
        message: "upstream 503",
        updatedAt: "2026-08-27T10:00:00.000Z",
      },
      config: {
        provider: "langfuse",
        baseUrl: "https://langfuse.example",
        otelEndpoint: "https://otel.example",
        hasPublicKey: true,
        hasSecretKey: false,
        configured: true,
      },
    };
    expect(developerDiagnosticSystemLineFromSessionEvent(observability)).toBe(
      "Observability: enabled=yes, configured=yes, health=degraded (export_failed: upstream 503)",
    );

    const unconfigured: Extract<SessionEvent, { type: "observability_status" }> = {
      type: "observability_status",
      sessionId,
      enabled: false,
      health: { status: "disabled", reason: "disabled", updatedAt: "2026-08-27T10:00:00.000Z" },
      config: null,
    };
    expect(developerDiagnosticSystemLineFromSessionEvent(unconfigured)).toBe(
      "Observability: enabled=no, configured=no, health=disabled (disabled)",
    );

    expect(
      developerDiagnosticSystemLineFromSessionEvent({
        type: "session_backup_state",
        sessionId,
        reason: "auto_checkpoint",
        backup: { status: "ready", checkpoints: [{ id: "cp-1" }, { id: "cp-2" }] },
      } as Extract<SessionEvent, { type: "session_backup_state" }>),
    ).toBe("Session backup (auto checkpoint): status=ready, checkpoints=2");
    expect(
      developerDiagnosticSystemLineFromSessionEvent({
        type: "session_backup_state",
        sessionId,
        reason: "requested",
        backup: { status: "failed" },
      } as Extract<SessionEvent, { type: "session_backup_state" }>),
    ).toBe("Session backup (requested): status=failed");

    expect(
      developerDiagnosticSystemLineFromSessionEvent({
        type: "harness_context",
        sessionId,
        context: null,
      }),
    ).toBe("Harness context cleared");
    expect(
      developerDiagnosticSystemLineFromSessionEvent({
        type: "harness_context",
        sessionId,
        context: {
          runId: "run-1",
          taskId: "task-9",
          objective: "Ship the coverage tests",
          acceptanceCriteria: ["green CI", "deterministic"],
          constraints: ["no prod edits"],
          updatedAt: "2026-08-27T10:00:00.000Z",
        },
      }),
    ).toBe(
      "Harness context updated: taskId=task-9, runId=run-1, objective=Ship the coverage tests, acceptanceCriteria=2, constraints=1",
    );
    expect(
      developerDiagnosticSystemLineFromSessionEvent({
        type: "harness_context",
        sessionId,
        context: { updatedAt: "2026-08-27T10:00:00.000Z" } as never,
      }),
    ).toBe("Harness context updated");
  });
});
