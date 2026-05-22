import { describe, expect, test } from "bun:test";

import { createJsonRpcNotificationProjector } from "../../../src/server/jsonrpc/notificationProjector";
import { createThreadJournalNotificationProjector } from "../../../src/server/jsonrpc/threadJournalNotificationProjector";
import { PI_PROVIDER_CASES, piChunk, sessionId, turnId } from "./fixtures";

describe("JSON-RPC projectors", () => {
  for (const { provider, model } of PI_PROVIDER_CASES) {
    test(`projectors keep repeated PI reasoning and tool occurrences distinct for ${provider}`, () => {
      const outbound: Array<{ method: string; params?: any }> = [];
      const emissions: Array<{ eventType: string; payload: any }> = [];
      const live = createJsonRpcNotificationProjector({
        threadId: sessionId,
        send: (message) => outbound.push(message as { method: string; params?: any }),
      });
      const journal = createThreadJournalNotificationProjector({
        threadId: sessionId,
        emit: (event) => emissions.push({ eventType: event.eventType, payload: event.payload }),
      });
      const both = [live, journal] as const;

      for (const projector of both) {
        projector.handle({
          type: "session_busy",
          sessionId,
          busy: true,
          turnId,
          cause: "user_message",
        });
        projector.handle(
          piChunk(provider, model, "reasoning_start", { id: "s0", mode: "reasoning" }),
        );
        projector.handle(
          piChunk(provider, model, "reasoning_delta", {
            id: "s0",
            mode: "reasoning",
            text: "First step.",
          }),
        );
        projector.handle(
          piChunk(provider, model, "reasoning_end", { id: "s0", mode: "reasoning" }),
        );
        projector.handle(
          piChunk(provider, model, "tool_input_start", {
            id: "tool_call_0",
            toolName: "webSearch",
          }),
        );
        projector.handle(
          piChunk(provider, model, "tool_input_delta", {
            id: "tool_call_0",
            delta: '{"query":"first"}',
          }),
        );
        projector.handle(
          piChunk(provider, model, "tool_input_end", { id: "tool_call_0", toolName: "webSearch" }),
        );
        projector.handle(
          piChunk(provider, model, "tool_call", {
            toolCallId: "tool_call_0",
            toolName: "webSearch",
            input: { query: "first" },
          }),
        );
        projector.handle(
          piChunk(provider, model, "tool_result", {
            toolCallId: "tool_call_0",
            toolName: "webSearch",
            output: { result: "first" },
          }),
        );
        projector.handle(
          piChunk(provider, model, "reasoning_start", { id: "s0", mode: "reasoning" }),
        );
        projector.handle(
          piChunk(provider, model, "reasoning_delta", {
            id: "s0",
            mode: "reasoning",
            text: "Second step.",
          }),
        );
        projector.handle(
          piChunk(provider, model, "reasoning_end", { id: "s0", mode: "reasoning" }),
        );
        projector.handle(
          piChunk(provider, model, "tool_input_start", {
            id: "tool_call_0",
            toolName: "webSearch",
          }),
        );
        projector.handle(
          piChunk(provider, model, "tool_input_delta", {
            id: "tool_call_0",
            delta: '{"query":"second"}',
          }),
        );
        projector.handle(
          piChunk(provider, model, "tool_input_end", { id: "tool_call_0", toolName: "webSearch" }),
        );
        projector.handle(
          piChunk(provider, model, "tool_call", {
            toolCallId: "tool_call_0",
            toolName: "webSearch",
            input: { query: "second" },
          }),
        );
        projector.handle(
          piChunk(provider, model, "tool_result", {
            toolCallId: "tool_call_0",
            toolName: "webSearch",
            output: { result: "second" },
          }),
        );
        projector.handle({
          type: "reasoning",
          sessionId,
          kind: "reasoning",
          text: "First step.\n\nSecond step.",
        });
        projector.handle({
          type: "assistant_message",
          sessionId,
          text: "Final answer.",
        });
      }

      const liveCompletedReasoning = outbound
        .filter((message) => message.method === "item/completed")
        .filter((message) => message.params?.item?.type === "reasoning");
      expect(liveCompletedReasoning.map((message) => message.params?.item?.text)).toEqual([
        "First step.",
        "Second step.",
      ]);
      expect(new Set(liveCompletedReasoning.map((message) => message.params?.item?.id)).size).toBe(
        2,
      );

      const liveCompletedTools = outbound
        .filter((message) => message.method === "item/completed")
        .filter((message) => message.params?.item?.type === "toolCall");
      const liveFinalTools = liveCompletedTools.filter(
        (message) => message.params?.item?.state === "output-available",
      );
      expect(liveFinalTools.map((message) => message.params?.item?.args)).toEqual([
        { query: "first" },
        { query: "second" },
      ]);
      expect(new Set(liveFinalTools.map((message) => message.params?.item?.id)).size).toBe(2);

      const journalCompletedReasoning = emissions
        .filter((event) => event.eventType === "item/completed")
        .filter((event) => event.payload?.item?.type === "reasoning");
      expect(journalCompletedReasoning.map((event) => event.payload?.item?.text)).toEqual([
        "First step.",
        "Second step.",
      ]);
      expect(new Set(journalCompletedReasoning.map((event) => event.payload?.item?.id)).size).toBe(
        2,
      );

      const journalCompletedTools = emissions
        .filter((event) => event.eventType === "item/completed")
        .filter((event) => event.payload?.item?.type === "toolCall");
      const journalFinalTools = journalCompletedTools.filter(
        (event) => event.payload?.item?.state === "output-available",
      );
      expect(journalFinalTools.map((event) => event.payload?.item?.args)).toEqual([
        { query: "first" },
        { query: "second" },
      ]);
      expect(new Set(journalFinalTools.map((event) => event.payload?.item?.id)).size).toBe(2);
    });
  }
});
