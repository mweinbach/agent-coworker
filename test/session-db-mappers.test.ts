import { describe, expect, test } from "bun:test";

import { mapPersistedSessionRecordRow, mapPersistedSessionSummaryRow } from "../src/server/sessionDb/mappers";

describe("sessionDb mappers", () => {
  test("mapPersistedSessionSummaryRow normalizes values and applies fallbacks", () => {
    const mapped = mapPersistedSessionSummaryRow({
      session_id: "  sess-1  ",
      title: "  My Title  ",
      provider: "invalid-provider",
      model: "  gpt-5.2  ",
      created_at: "not-a-date",
      updated_at: "",
      message_count: -4,
    });

    expect(mapped).not.toBeNull();
    expect(mapped).toMatchObject({
      sessionId: "sess-1",
      title: "My Title",
      provider: "google",
      model: "gpt-5.2",
      messageCount: 0,
    });
    expect(Number.isNaN(Date.parse(mapped!.createdAt))).toBeFalse();
    expect(Number.isNaN(Date.parse(mapped!.updatedAt))).toBeFalse();
  });

  test("mapPersistedSessionSummaryRow returns null when required fields are missing", () => {
    const mapped = mapPersistedSessionSummaryRow({
      title: "hello",
      model: "gpt-5.2",
    });

    expect(mapped).toBeNull();
  });

  test("mapPersistedSessionRecordRow normalizes and preserves legacy fallback behavior", () => {
    const mapped = mapPersistedSessionRecordRow({
      session_id: "  sess-2  ",
      title: "  Session Title  ",
      provider: "not-real",
      model: "  gpt-5  ",
      working_directory: "  /workspace  ",
      system_prompt: 1234,
      created_at: "invalid-date",
      updated_at: "2026-02-19T00:00:01.000Z",
      output_directory: "   ",
      uploads_directory: null,
      enable_mcp: 1,
      has_pending_ask: 0,
      has_pending_approval: 2,
      message_count: 12.7,
      last_event_seq: -9,
      status: "anything",
      title_source: "unknown",
      title_model: "   ",
      messages_json: "{\"unexpected\":\"shape\"}",
      todos_json: "not-json",
      harness_context_json: "[]",
    });

    expect(mapped).not.toBeNull();
    expect(mapped).toMatchObject({
      sessionId: "sess-2",
      title: "Session Title",
      provider: "google",
      model: "gpt-5",
      workingDirectory: "/workspace",
      systemPrompt: "",
      outputDirectory: undefined,
      uploadsDirectory: undefined,
      enableMcp: true,
      hasPendingAsk: false,
      hasPendingApproval: false,
      messageCount: 12,
      lastEventSeq: 0,
      status: "active",
      titleSource: "default",
      titleModel: null,
      todos: [],
      harnessContext: null,
    });
    expect((mapped as any).messages).toEqual({ unexpected: "shape" });
    expect(Number.isNaN(Date.parse(mapped!.createdAt))).toBeFalse();
    expect(Number.isNaN(Date.parse(mapped!.updatedAt))).toBeFalse();
  });

  test("mapPersistedSessionRecordRow returns null when required fields are missing", () => {
    const mapped = mapPersistedSessionRecordRow({
      title: "hello",
      model: "gpt-5.2",
      working_directory: "/workspace",
    });

    expect(mapped).toBeNull();
  });
});
