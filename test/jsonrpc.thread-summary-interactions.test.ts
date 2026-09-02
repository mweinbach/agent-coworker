import { describe, expect, test } from "bun:test";

import {
  buildJsonRpcThreadFromRecord,
  buildJsonRpcThreadFromSession,
} from "../src/server/jsonrpc/routes/shared";
import { jsonRpcThreadSchema } from "../src/server/jsonrpc/schema.threadTurn";

const timestamp = "2026-08-24T12:00:00.000Z";

function makeSummaryBase() {
  return {
    id: "thread-1",
    title: "Needs your input",
    preview: "Waiting for you",
    modelProvider: "google",
    model: "gemini-3-flash-preview",
    cwd: "/workspace/project",
    createdAt: timestamp,
    updatedAt: timestamp,
    messageCount: 2,
    lastEventSeq: 8,
    status: { type: "running" },
  };
}

describe("canonical JSON-RPC thread interaction summaries", () => {
  test("includes pending ask and approval flags from the live authoritative snapshot", () => {
    const runtime = {
      id: "thread-1",
      read: {
        info: {
          title: "Needs your input",
          lastMessagePreview: "Waiting for you",
          provider: "google",
          model: "gemini-3-flash-preview",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        workingDirectory: "/workspace/project",
        isBusy: true,
        getLatestAssistantText: () => "",
      },
      snapshot: {
        peek: () => ({
          messageCount: 2,
          lastEventSeq: 8,
          hasPendingAsk: true,
          hasPendingApproval: true,
        }),
      },
    };

    expect(buildJsonRpcThreadFromSession(runtime as never)).toMatchObject({
      ...makeSummaryBase(),
      hasPendingAsk: true,
      hasPendingApproval: true,
    });
  });

  test("preserves pending interaction flags for unloaded persisted threads", () => {
    const record = {
      sessionId: "thread-1",
      title: "Needs your input",
      lastMessagePreview: "Waiting for you",
      provider: "google",
      model: "gemini-3-flash-preview",
      workingDirectory: "/workspace/project",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 2,
      lastEventSeq: 8,
      hasPendingAsk: false,
      hasPendingApproval: true,
    };

    expect(buildJsonRpcThreadFromRecord(record as never)).toMatchObject({
      ...makeSummaryBase(),
      status: { type: "notLoaded" },
      hasPendingAsk: false,
      hasPendingApproval: true,
    });
  });

  test("strict canonical schema accepts both enhanced and legacy thread summaries", () => {
    expect(
      jsonRpcThreadSchema.parse({
        ...makeSummaryBase(),
        hasPendingAsk: true,
        hasPendingApproval: false,
      }),
    ).toMatchObject({ hasPendingAsk: true, hasPendingApproval: false });
    expect(jsonRpcThreadSchema.parse(makeSummaryBase())).not.toHaveProperty("hasPendingAsk");
  });
});
