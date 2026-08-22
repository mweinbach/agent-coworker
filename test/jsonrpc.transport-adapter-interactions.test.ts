import { describe, expect, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createJsonRpcTransportAdapter } from "../src/server/jsonrpc/transportAdapter";
import type { SessionBinding, StartServerSocket } from "../src/server/startServer/types";

function createHarness(opts?: { acceptApproval?: boolean; acceptAsk?: boolean }) {
  const sent: unknown[] = [];
  const approvals: Array<{ requestId: string; approved: boolean }> = [];
  const asks: Array<{ requestId: string; answer: string }> = [];
  const binding = {
    session: null,
    runtime: {
      turns: { activeTurnId: "turn-1" },
      lifecycle: {
        handleApprovalResponse: (requestId: string, approved: boolean) => {
          approvals.push({ requestId, approved });
          return opts?.acceptApproval ?? true;
        },
        handleAskResponse: (requestId: string, answer: string) => {
          asks.push({ requestId, answer });
          return opts?.acceptAsk ?? true;
        },
      },
    },
    socket: null,
    sinks: new Map(),
  } as unknown as SessionBinding;

  const adapter = createJsonRpcTransportAdapter({
    maxPendingRequests: 8,
    loadThreadBinding: () => binding,
    getThreadBinding: () => binding,
    addBindingSink: () => {},
    removeBindingSink: () => {},
    countLiveConnectionSinks: () => 0,
    listThreadJournalEvents: () => [],
    getThreadJournalTailSeq: () => 0,
    enqueueThreadJournalEvent: async () => {},
    shouldSendNotification: () => true,
    sendJsonRpc: (_ws, payload) => {
      sent.push(payload);
    },
    extractTextInput: (input) => {
      if (!Array.isArray(input)) return "";
      return input
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
    },
  });

  const ws = {
    data: {
      connectionId: "conn-1",
    },
    send: () => {},
  } as unknown as StartServerSocket;
  adapter.openConnection(ws);

  return { adapter, ws, sent, approvals, asks };
}

async function dispatchResponse(
  harness: ReturnType<typeof createHarness>,
  message: { id: string | number; result?: unknown },
) {
  harness.adapter.handleMessage(harness.ws, message, async () => {});
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("JSON-RPC transport adapter interaction replies", () => {
  test("unknown server-request ids fail closed", async () => {
    const harness = createHarness();
    await dispatchResponse(harness, { id: "missing-1", result: { approved: true } });
    expect(harness.sent).toEqual([
      {
        id: "missing-1",
        error: {
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: "Unknown server request id: missing-1",
          data: {
            category: "interaction_response_not_found",
            requestId: "missing-1",
          },
        },
      },
    ]);
    expect(harness.approvals).toEqual([]);
  });

  test("maps approval decisions and rejects payloads with neither approved nor decision", async () => {
    const harness = createHarness();
    harness.ws.data.rpc?.pendingServerRequests.set("approval-1", {
      threadId: "thread-1",
      type: "approval",
      requestId: "approval-1",
    });
    harness.ws.data.rpc?.pendingServerRequests.set("approval-2", {
      threadId: "thread-1",
      type: "approval",
      requestId: "approval-2",
    });
    harness.ws.data.rpc?.pendingServerRequests.set("approval-3", {
      threadId: "thread-1",
      type: "approval",
      requestId: "approval-3",
    });

    await dispatchResponse(harness, {
      id: "approval-1",
      result: { decision: "acceptForSession" },
    });
    await dispatchResponse(harness, {
      id: "approval-2",
      result: { decision: "decline" },
    });
    await dispatchResponse(harness, {
      id: "approval-3",
      result: {},
    });

    expect(harness.approvals).toEqual([
      { requestId: "approval-1", approved: true },
      { requestId: "approval-2", approved: false },
    ]);
    expect(harness.sent).toContainEqual({
      method: "serverRequest/resolved",
      params: {
        threadId: "thread-1",
        requestId: "approval-1",
        response: { kind: "approval", approved: true },
      },
    });
    expect(harness.sent).toContainEqual({
      method: "serverRequest/resolved",
      params: {
        threadId: "thread-1",
        requestId: "approval-2",
        response: { kind: "approval", approved: false },
      },
    });
    const invalidApproval = harness.sent.find(
      (payload) =>
        payload && typeof payload === "object" && "id" in payload && payload.id === "approval-3",
    );
    expect(invalidApproval).toMatchObject({
      id: "approval-3",
      error: {
        code: JSONRPC_ERROR_CODES.invalidParams,
        data: {
          category: "interaction_response_invalid",
          requestId: "approval-3",
          threadId: "thread-1",
        },
      },
    });
    expect(
      String((invalidApproval as { error?: { message?: string } })?.error?.message ?? ""),
    ).toContain("Invalid approval response:");
  });

  test("treats empty ask answers as retries and rejects malformed ask payloads", async () => {
    const harness = createHarness();
    harness.ws.data.rpc?.pendingServerRequests.set("ask-1", {
      threadId: "thread-1",
      type: "ask",
      requestId: "ask-1",
    });
    harness.ws.data.rpc?.pendingServerRequests.set("ask-2", {
      threadId: "thread-1",
      type: "ask",
      requestId: "ask-2",
    });
    harness.ws.data.rpc?.pendingServerRequests.set("ask-3", {
      threadId: "thread-1",
      type: "ask",
      requestId: "ask-3",
    });

    await dispatchResponse(harness, {
      id: "ask-1",
      result: { answer: "   " },
    });
    await dispatchResponse(harness, {
      id: "ask-2",
      result: { content: [{ type: "text", text: "use the workspace" }] },
    });
    await dispatchResponse(harness, {
      id: "ask-3",
      result: { approved: true },
    });

    expect(harness.asks).toEqual([
      { requestId: "ask-1", answer: "" },
      { requestId: "ask-2", answer: "use the workspace" },
    ]);
    expect(harness.ws.data.rpc?.pendingServerRequests.has("ask-1")).toBe(true);
    expect(harness.sent).toContainEqual({
      method: "serverRequest/resolved",
      params: {
        threadId: "thread-1",
        requestId: "ask-2",
        response: { kind: "ask", answer: "use the workspace" },
      },
    });
    const invalidAsk = harness.sent.find(
      (payload) =>
        payload && typeof payload === "object" && "id" in payload && payload.id === "ask-3",
    );
    expect(invalidAsk).toMatchObject({
      id: "ask-3",
      error: {
        code: JSONRPC_ERROR_CODES.invalidParams,
        data: {
          category: "interaction_response_invalid",
          requestId: "ask-3",
          threadId: "thread-1",
        },
      },
    });
    expect(
      String((invalidAsk as { error?: { message?: string } })?.error?.message ?? ""),
    ).toContain("Invalid ask response:");
  });
});
