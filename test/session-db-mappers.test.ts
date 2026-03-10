import { describe, expect, test } from "bun:test";

import {
  mapPersistedSessionRecordRow,
  mapPersistedSessionSubagentSummaryRow,
  mapPersistedSessionSummaryRow,
} from "../src/server/sessionDb/mappers";

describe("sessionDb mappers", () => {
  test("mapPersistedSessionSummaryRow parses valid rows", () => {
    const mapped = mapPersistedSessionSummaryRow({
      session_id: "sess-1",
      title: "My Title",
      provider: "google",
      model: "gpt-5.2",
      created_at: "2026-02-19T00:00:00.000Z",
      updated_at: "2026-02-19T00:00:01.000Z",
      message_count: 4,
    });

    expect(mapped).toMatchObject({
      sessionId: "sess-1",
      title: "My Title",
      provider: "google",
      model: "gpt-5.2",
      messageCount: 4,
    });
    expect(Number.isNaN(Date.parse(mapped.createdAt))).toBeFalse();
    expect(Number.isNaN(Date.parse(mapped.updatedAt))).toBeFalse();
  });

  test("mapPersistedSessionSummaryRow throws when required fields are missing", () => {
    expect(() =>
      mapPersistedSessionSummaryRow({
        title: "hello",
        model: "gpt-5.2",
      }),
    ).toThrow("Invalid session summary row");
  });

  test("mapPersistedSessionRecordRow parses strict row shape and JSON payloads", () => {
    const mapped = mapPersistedSessionRecordRow({
      session_id: "sess-2",
      session_kind: "subagent",
      parent_session_id: "sess-1",
      agent_type: "general",
      title: "Session Title",
      provider: "openai",
      model: "gpt-5",
      working_directory: "/workspace",
      system_prompt: "system",
      created_at: "2026-02-19T00:00:00.000Z",
      updated_at: "2026-02-19T00:00:01.000Z",
      output_directory: null,
      uploads_directory: null,
      enable_mcp: 1,
      has_pending_ask: 0,
      has_pending_approval: 1,
      message_count: 12,
      last_event_seq: 9,
      status: "closed",
      title_source: "manual",
      title_model: "gpt-5",
      messages_json: "[{\"role\":\"user\",\"content\":\"hello\"}]",
      provider_state_json: "{\"provider\":\"openai\",\"model\":\"gpt-5\",\"responseId\":\"resp_1\",\"updatedAt\":\"2026-02-19T00:00:01.000Z\"}",
      todos_json: "[]",
      harness_context_json: "{\"runId\":\"r-1\"}",
      cost_tracker_json: "{\"sessionId\":\"sess-2\",\"totalTurns\":1,\"totalPromptTokens\":10,\"totalCompletionTokens\":5,\"totalTokens\":15,\"estimatedTotalCostUsd\":0.001,\"costTrackingAvailable\":true,\"byModel\":[],\"turns\":[],\"budgetStatus\":{\"configured\":false,\"warnAtUsd\":null,\"stopAtUsd\":null,\"warningTriggered\":false,\"stopTriggered\":false,\"currentCostUsd\":0.001},\"createdAt\":\"2026-02-19T00:00:00.000Z\",\"updatedAt\":\"2026-02-19T00:00:01.000Z\"}",
    });

    expect(mapped).toMatchObject({
      sessionId: "sess-2",
      sessionKind: "subagent",
      parentSessionId: "sess-1",
      agentType: "general",
      title: "Session Title",
      provider: "openai",
      model: "gpt-5",
      workingDirectory: "/workspace",
      systemPrompt: "system",
      outputDirectory: undefined,
      uploadsDirectory: undefined,
      enableMcp: true,
      hasPendingAsk: false,
      hasPendingApproval: true,
      messageCount: 12,
      lastEventSeq: 9,
      status: "closed",
      titleSource: "manual",
      titleModel: "gpt-5",
      providerState: {
        provider: "openai",
        model: "gpt-5",
        responseId: "resp_1",
        updatedAt: "2026-02-19T00:00:01.000Z",
      },
      costTracker: {
        sessionId: "sess-2",
        totalTurns: 1,
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        totalTokens: 15,
        estimatedTotalCostUsd: 0.001,
        costTrackingAvailable: true,
        byModel: [],
        turns: [],
        budgetStatus: {
          configured: false,
          warnAtUsd: null,
          stopAtUsd: null,
          warningTriggered: false,
          stopTriggered: false,
          currentCostUsd: 0.001,
        },
        createdAt: "2026-02-19T00:00:00.000Z",
        updatedAt: "2026-02-19T00:00:01.000Z",
      },
      todos: [],
      harnessContext: { runId: "r-1" },
    });
    expect((mapped as any).messages).toEqual([{ role: "user", content: "hello" }]);
    expect(Number.isNaN(Date.parse(mapped.createdAt))).toBeFalse();
    expect(Number.isNaN(Date.parse(mapped.updatedAt))).toBeFalse();
  });

  test("mapPersistedSessionSubagentSummaryRow parses valid child-session rows", () => {
    const mapped = mapPersistedSessionSubagentSummaryRow({
      session_id: "child-1",
      parent_session_id: "root-1",
      agent_type: "research",
      title: "Research Child",
      provider: "openai",
      model: "gpt-5.2",
      created_at: "2026-02-19T00:00:00.000Z",
      updated_at: "2026-02-19T00:00:01.000Z",
      status: "closed",
    });

    expect(mapped).toEqual({
      sessionId: "child-1",
      parentSessionId: "root-1",
      agentType: "research",
      title: "Research Child",
      provider: "openai",
      model: "gpt-5.2",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      status: "closed",
      busy: false,
    });
  });

  test("mapPersistedSessionRecordRow throws when required fields are missing", () => {
    expect(() =>
      mapPersistedSessionRecordRow({
        title: "hello",
        model: "gpt-5.2",
        working_directory: "/workspace",
      }),
    ).toThrow("Invalid persisted session row");
  });

  test("mapPersistedSessionRecordRow throws for invalid embedded JSON", () => {
    expect(() =>
      mapPersistedSessionRecordRow({
        session_id: "sess-2",
        session_kind: "root",
        parent_session_id: null,
        agent_type: null,
        title: "Session Title",
        provider: "openai",
        model: "gpt-5",
        working_directory: "/workspace",
        system_prompt: "system",
        created_at: "2026-02-19T00:00:00.000Z",
        updated_at: "2026-02-19T00:00:01.000Z",
        output_directory: null,
        uploads_directory: null,
        enable_mcp: 1,
        has_pending_ask: 0,
        has_pending_approval: 1,
        message_count: 12,
        last_event_seq: 9,
        status: "closed",
        title_source: "manual",
        title_model: null,
        messages_json: "not-json",
        provider_state_json: null,
        todos_json: "[]",
        harness_context_json: null,
        cost_tracker_json: null,
      }),
    ).toThrow("Invalid JSON in messages_json");
  });

  test("mapPersistedSessionRecordRow rejects malformed cost tracker snapshots", () => {
    expect(() =>
      mapPersistedSessionRecordRow({
        session_id: "sess-2",
        session_kind: "root",
        parent_session_id: null,
        agent_type: null,
        title: "Session Title",
        provider: "openai",
        model: "gpt-5",
        working_directory: "/workspace",
        system_prompt: "system",
        created_at: "2026-02-19T00:00:00.000Z",
        updated_at: "2026-02-19T00:00:01.000Z",
        output_directory: null,
        uploads_directory: null,
        enable_mcp: 1,
        has_pending_ask: 0,
        has_pending_approval: 1,
        message_count: 12,
        last_event_seq: 9,
        status: "closed",
        title_source: "manual",
        title_model: null,
        messages_json: "[{\"role\":\"user\",\"content\":\"hello\"}]",
        provider_state_json: null,
        todos_json: "[]",
        harness_context_json: null,
        cost_tracker_json: "{}",
      }),
    ).toThrow("Invalid cost_tracker_json");
  });
});
