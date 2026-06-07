import { describe, expect, test } from "bun:test";

import { createJsonRpcWorkspaceModule } from "../src/app/store.helpers/threadEventReducer/jsonRpcWorkspace";

describe("jsonRpc workspace thread migration", () => {
  test("merges sandbox approvals when migrating thread ids", () => {
    const fromThreadId = "optimistic-thread";
    const toThreadId = "real-thread";
    let state = {
      threads: [
        { id: fromThreadId, sessionId: fromThreadId, workspaceId: "workspace-1" },
        { id: toThreadId, sessionId: toThreadId, workspaceId: "workspace-1" },
      ],
      threadRuntimeById: {},
      latestTodosByThreadId: {},
      sandboxApprovalsByThread: {
        [fromThreadId]: [
          { requestId: "approval-from", command: "touch ../outside" },
          { requestId: "approval-shared", command: "curl https://example.com" },
        ],
        [toThreadId]: [{ requestId: "approval-existing", command: "git status" }],
      },
      selectedThreadId: fromThreadId,
      promptModal: null,
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
      } as any,
      { handleThreadEvent() {} },
      { ensureThreadSocket() {} },
    );

    module.migrateThreadIdentity(get as any, set as any, fromThreadId, toThreadId);

    expect(state.sandboxApprovalsByThread[fromThreadId]).toBeUndefined();
    expect(state.sandboxApprovalsByThread[toThreadId]).toEqual([
      { requestId: "approval-existing", command: "git status" },
      { requestId: "approval-from", command: "touch ../outside" },
      { requestId: "approval-shared", command: "curl https://example.com" },
    ]);
  });
});
