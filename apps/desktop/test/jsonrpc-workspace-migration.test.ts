import { describe, expect, test } from "bun:test";

import { createJsonRpcWorkspaceModule } from "../src/app/store.helpers/threadEventReducer/jsonRpcWorkspace";

describe("jsonRpc workspace thread migration", () => {
  test("merges ordered interactions when migrating thread ids", () => {
    const fromThreadId = "optimistic-thread";
    const toThreadId = "real-thread";
    let state = {
      threads: [
        { id: fromThreadId, sessionId: fromThreadId, workspaceId: "workspace-1" },
        { id: toThreadId, sessionId: toThreadId, workspaceId: "workspace-1" },
      ],
      threadRuntimeById: {},
      latestTodosByThreadId: {},
      interactionsByThread: {
        [fromThreadId]: [
          {
            kind: "approval",
            approvalKind: "sandbox",
            requestId: "approval-from",
            command: "touch ../outside",
            dangerous: true,
            reasonCode: "sandbox_denied_escalation",
            receivedSequence: 2,
            status: "pending",
          },
          {
            kind: "ask",
            requestId: "ask-from",
            question: "Continue?",
            receivedSequence: 3,
            status: "pending",
          },
        ],
        [toThreadId]: [
          {
            kind: "approval",
            approvalKind: "manual",
            requestId: "approval-existing",
            command: "git status",
            dangerous: false,
            reasonCode: "requires_manual_review",
            receivedSequence: 1,
            status: "failed",
          },
        ],
      },
      selectedThreadId: fromThreadId,
    } as any;
    const get = () => state;
    const set = (updater: any) => {
      state = { ...state, ...updater(state) };
    };
    const workspace = {
      isWorkspaceDisposed: () => false,
      forgetThreadForReconnect() {},
      rememberThreadForReconnect() {},
      connectedThreadIdsForWorkspace: () => [],
      workspaceIdForThread: (_get: typeof get, threadId: string) =>
        state.threads.find((thread: any) => thread.id === threadId)?.workspaceId ?? null,
    };
    const module = createJsonRpcWorkspaceModule(
      {
        deps: {},
        jsonRpcRouterCleanupByWorkspace: new Map(),
        jsonRpcLifecycleCleanupByWorkspace: new Map(),
        jsonRpcReconnectThreadsByWorkspace: new Map(),
        jsonRpcThreadConnectPromises: new Map(),
        threadStoreGettersByWorkspace: new Map(),
        disposedWorkspaces: new Set(),
      } as any,
      workspace as any,
      {
        parseProjectedItem() {
          return null;
        },
        applyProjectedStarted() {},
        applyProjectedCompleted() {},
        applyProjectedReasoningDeltaToThread() {},
        applyProjectedAssistantDeltaToThread() {},
        flushPendingContentForThread() {},
      } as any,
      { handleThreadEvent() {} },
      { ensureThreadSocket() {} },
    );

    module.migrateThreadIdentity(get as any, set as any, fromThreadId, toThreadId);

    expect(state.interactionsByThread[fromThreadId]).toBeUndefined();
    expect(
      state.interactionsByThread[toThreadId]?.map((interaction) => interaction.requestId),
    ).toEqual(["approval-existing", "approval-from", "ask-from"]);
    expect(state.interactionsByThread[toThreadId]?.[0]?.status).toBe("failed");
  });
});
