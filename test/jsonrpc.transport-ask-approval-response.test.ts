import { describe, expect, mock, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { extractJsonRpcTextInput } from "../src/server/jsonrpc/routes/shared";
import { createJsonRpcTransportAdapter } from "../src/server/jsonrpc/transportAdapter";
import type { SessionBinding, StartServerSocket } from "../src/server/startServer/types";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createAdapterHarness() {
  const sent: unknown[] = [];
  const handleAskResponse = mock((_requestId: string, _answer: string) => true);
  const handleApprovalResponse = mock((_requestId: string, _approved: boolean) => true);
  const enqueueThreadJournalEvent = mock(async () => {});
  const binding = {
    session: null,
    runtime: {
      id: "thread-1",
      turns: { activeTurnId: "turn-1" },
      lifecycle: {
        handleAskResponse,
        handleApprovalResponse,
      },
    },
    sinks: new Map(),
  } as unknown as SessionBinding;

  const adapter = createJsonRpcTransportAdapter({
    maxPendingRequests: 8,
    loadThreadBinding: () => binding,
    getThreadBinding: () => binding,
    getThreadSubscribers: () => [],
    addBindingSink: () => {},
    removeBindingSink: () => {},
    countLiveConnectionSinks: () => 1,
    getThreadProjectionSeed: () => undefined,
    listThreadJournalEvents: () => [],
    getThreadJournalTailSeq: () => 0,
    enqueueThreadJournalEvent,
    shouldSendNotification: () => true,
    sendJsonRpc: (_ws, payload) => {
      sent.push(payload);
    },
    extractTextInput: extractJsonRpcTextInput,
  });

  const ws = {
    data: {
      connectionId: "conn-1",
      protocolMode: "jsonrpc",
    },
  } as StartServerSocket;
  adapter.openConnection(ws);

  const seedPending = (id: string, type: "ask" | "approval") => {
    ws.data.rpc?.pendingServerRequests.set(id, {
      threadId: "thread-1",
      type,
      requestId: id,
    });
  };

  return {
    adapter,
    enqueueThreadJournalEvent,
    handleApprovalResponse,
    handleAskResponse,
    seedPending,
    sent,
    ws,
  };
}

describe("JSON-RPC ask and approval response sanitization", () => {
  test("accepts string and content-part ask answers", async () => {
    const harness = createAdapterHarness();
    harness.seedPending("ask-1", "ask");
    harness.adapter.handleMessage(
      harness.ws,
      { id: "ask-1", result: { answer: "Proceed" } },
      async () => {},
    );
    await flushMicrotasks();

    expect(harness.handleAskResponse).toHaveBeenCalledWith("ask-1", "Proceed");
    expect(harness.enqueueThreadJournalEvent).toHaveBeenCalled();
    expect(
      harness.sent.some(
        (payload) =>
          payload !== null &&
          typeof payload === "object" &&
          "method" in payload &&
          payload.method === "serverRequest/resolved",
      ),
    ).toBe(true);

    const contentHarness = createAdapterHarness();
    contentHarness.seedPending("ask-2", "ask");
    contentHarness.adapter.handleMessage(
      contentHarness.ws,
      { id: "ask-2", result: { content: [{ type: "text", text: "Looks good" }] } },
      async () => {},
    );
    await flushMicrotasks();
    expect(contentHarness.handleAskResponse).toHaveBeenCalledWith("ask-2", "Looks good");
  });

  test("retries whitespace-only asks and rejects malformed ask payloads", async () => {
    const emptyHarness = createAdapterHarness();
    emptyHarness.seedPending("ask-empty", "ask");
    emptyHarness.adapter.handleMessage(
      emptyHarness.ws,
      { id: "ask-empty", result: { answer: "   " } },
      async () => {},
    );
    await flushMicrotasks();
    expect(emptyHarness.handleAskResponse).toHaveBeenCalledWith("ask-empty", "");
    expect(emptyHarness.enqueueThreadJournalEvent).not.toHaveBeenCalled();
    expect(emptyHarness.sent).toEqual([]);

    const invalidHarness = createAdapterHarness();
    invalidHarness.seedPending("ask-bad", "ask");
    invalidHarness.adapter.handleMessage(
      invalidHarness.ws,
      { id: "ask-bad", result: { answer: 123 } },
      async () => {},
    );
    await flushMicrotasks();
    expect(invalidHarness.handleAskResponse).not.toHaveBeenCalled();
    expect(invalidHarness.sent).toEqual([
      {
        id: "ask-bad",
        error: {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: expect.stringContaining("Invalid ask response"),
          data: {
            category: "interaction_response_invalid",
            requestId: "ask-bad",
            threadId: "thread-1",
          },
        },
      },
    ]);
  });

  test("treats approved:false as a denial even when decision is accept", async () => {
    const denied = createAdapterHarness();
    denied.seedPending("appr-1", "approval");
    denied.adapter.handleMessage(
      denied.ws,
      { id: "appr-1", result: { approved: false, decision: "accept" } },
      async () => {},
    );
    await flushMicrotasks();
    expect(denied.handleApprovalResponse).toHaveBeenCalledWith("appr-1", false);

    const accepted = createAdapterHarness();
    accepted.seedPending("appr-2", "approval");
    accepted.adapter.handleMessage(
      accepted.ws,
      { id: "appr-2", result: { decision: "accept" } },
      async () => {},
    );
    await flushMicrotasks();
    expect(accepted.handleApprovalResponse).toHaveBeenCalledWith("appr-2", true);
  });

  test("rejects approval payloads that omit both approved and decision", async () => {
    const harness = createAdapterHarness();
    harness.seedPending("appr-bad", "approval");
    harness.adapter.handleMessage(harness.ws, { id: "appr-bad", result: {} }, async () => {});
    await flushMicrotasks();

    expect(harness.handleApprovalResponse).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([
      {
        id: "appr-bad",
        error: {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: expect.stringContaining("Invalid approval response"),
          data: {
            category: "interaction_response_invalid",
            requestId: "appr-bad",
            threadId: "thread-1",
          },
        },
      },
    ]);
  });
});
