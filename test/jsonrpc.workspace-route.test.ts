import { describe, expect, test } from "bun:test";
import type {
  JsonRpcLiteError,
  JsonRpcLiteId,
  JsonRpcLiteRequest,
} from "../src/server/jsonrpc/protocol";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import type {
  JsonRpcRequestHandlerMap,
  JsonRpcRouteContext,
  JsonRpcThread,
  JsonRpcThreadSummaryFilter,
} from "../src/server/jsonrpc/routes/types";
import { createWorkspaceRouteHandlers } from "../src/server/jsonrpc/routes/workspace";
import { jsonRpcWorkspaceResultSchemas } from "../src/server/jsonrpc/schema.workspace";

const WORKSPACE_BOOTSTRAP_METHOD = "cowork/workspace/bootstrap";

type RouteResponse = {
  result?: unknown;
  error?: JsonRpcLiteError;
};

function makeThread(id: string, title: string, updatedAt: string): JsonRpcThread {
  return {
    id,
    title,
    preview: `${title} preview`,
    modelProvider: "google",
    model: "gemini-3-flash-preview",
    cwd: "/workspace/project",
    createdAt: "2026-05-16T09:00:00.000Z",
    updatedAt,
    messageCount: 1,
    lastEventSeq: 1,
    status: { type: "loaded" },
  };
}

function createWorkspaceRouteHarness() {
  const results: Array<{ id: JsonRpcLiteId; result: unknown }> = [];
  const errors: Array<{ id: JsonRpcLiteId | null; error: JsonRpcLiteError }> = [];
  const persistedCwds: string[] = [];
  const liveCwds: string[] = [];
  const readStateCwds: string[] = [];
  const summaryFilters: JsonRpcThreadSummaryFilter[] = [];

  const context = {
    threads: {
      listPersisted: (options?: { cwd?: string }) => {
        persistedCwds.push(options?.cwd ?? "");
        return [
          {
            sessionId: "shared-thread",
            titleSource: "manual",
            messageCount: 4,
            hasPendingAsk: false,
            hasPendingApproval: false,
            executionState: "idle",
          },
          {
            sessionId: "empty-default-thread",
            titleSource: "default",
            messageCount: 0,
            hasPendingAsk: false,
            hasPendingApproval: false,
            executionState: null,
          },
          {
            sessionId: "pending-ask-thread",
            titleSource: "default",
            messageCount: 0,
            hasPendingAsk: true,
            hasPendingApproval: false,
            executionState: null,
          },
        ];
      },
      listLiveRoot: (options?: { cwd?: string }) => {
        liveCwds.push(options?.cwd ?? "");
        return [{ id: "shared-thread" }, { id: "live-only-thread" }];
      },
    },
    workspaceControl: {
      readState: async (cwd: string) => {
        readStateCwds.push(cwd);
        return [{ type: "state_marker", sessionId: "state-session" }];
      },
    },
    jsonrpc: {
      sendResult: (_ws: unknown, id: JsonRpcLiteId, result: unknown) => {
        results.push({ id, result });
      },
      sendError: (_ws: unknown, id: JsonRpcLiteId | null, error: JsonRpcLiteError) => {
        errors.push({ id, error });
      },
    },
    utils: {
      resolveWorkspacePath: (params: Record<string, unknown>) => String(params.cwd),
      buildThreadFromRecord: (record: { sessionId: string }) => {
        if (record.sessionId === "pending-ask-thread") {
          return makeThread(record.sessionId, "Pending ask", "2026-05-16T10:02:00.000Z");
        }
        return makeThread(record.sessionId, "Persisted shared", "2026-05-16T10:00:00.000Z");
      },
      buildThreadFromSession: (runtime: { id: string }) => {
        if (runtime.id === "shared-thread") {
          return makeThread(runtime.id, "Live shared", "2026-05-16T10:03:00.000Z");
        }
        return makeThread(runtime.id, "Live only", "2026-05-16T10:01:00.000Z");
      },
      shouldIncludeThreadSummary: (summary: JsonRpcThreadSummaryFilter) => {
        summaryFilters.push(summary);
        return (
          summary.titleSource !== "default" ||
          (summary.messageCount ?? 0) > 0 ||
          summary.hasPendingAsk === true ||
          summary.hasPendingApproval === true ||
          summary.executionState === "running"
        );
      },
    },
  } as unknown as JsonRpcRouteContext;

  return {
    context,
    results,
    errors,
    persistedCwds,
    liveCwds,
    readStateCwds,
    summaryFilters,
  };
}

async function invokeWorkspaceBootstrap(
  handlers: JsonRpcRequestHandlerMap,
  params: unknown,
): Promise<RouteResponse> {
  const handler = handlers[WORKSPACE_BOOTSTRAP_METHOD];
  if (!handler) {
    throw new Error(`${WORKSPACE_BOOTSTRAP_METHOD} handler was not registered`);
  }
  const request: JsonRpcLiteRequest = {
    id: 1,
    method: WORKSPACE_BOOTSTRAP_METHOD,
    params,
  };

  await handler({} as never, request);

  return {};
}

describe("workspace JSON-RPC route", () => {
  test("bootstrap filters empty persisted threads, lets live sessions win, and sorts by updatedAt", async () => {
    const harness = createWorkspaceRouteHarness();
    const handlers = createWorkspaceRouteHandlers(harness.context);

    await invokeWorkspaceBootstrap(handlers, { cwd: "/workspace/project" });

    expect(harness.errors).toEqual([]);
    expect(harness.persistedCwds).toEqual(["/workspace/project"]);
    expect(harness.liveCwds).toEqual(["/workspace/project"]);
    expect(harness.readStateCwds).toEqual(["/workspace/project"]);
    expect(harness.summaryFilters).toEqual([
      {
        titleSource: "manual",
        messageCount: 4,
        hasPendingAsk: false,
        hasPendingApproval: false,
        executionState: "idle",
      },
      {
        titleSource: "default",
        messageCount: 0,
        hasPendingAsk: false,
        hasPendingApproval: false,
        executionState: null,
      },
      {
        titleSource: "default",
        messageCount: 0,
        hasPendingAsk: true,
        hasPendingApproval: false,
        executionState: null,
      },
    ]);

    const parsed = jsonRpcWorkspaceResultSchemas[WORKSPACE_BOOTSTRAP_METHOD].parse(
      harness.results[0]?.result,
    );
    expect(parsed.threads.map((thread) => thread.id)).toEqual([
      "shared-thread",
      "pending-ask-thread",
      "live-only-thread",
    ]);
    expect(parsed.threads.map((thread) => thread.title)).toEqual([
      "Live shared",
      "Pending ask",
      "Live only",
    ]);
    expect(parsed.state).toEqual([{ type: "state_marker", sessionId: "state-session" }]);
  });

  test("bootstrap rejects non-schema params before reading workspace state", async () => {
    const harness = createWorkspaceRouteHarness();
    const handlers = createWorkspaceRouteHandlers(harness.context);

    await invokeWorkspaceBootstrap(handlers, { cwd: "/workspace/project", extra: true });

    expect(harness.results).toEqual([]);
    expect(harness.readStateCwds).toEqual([]);
    expect(harness.errors).toEqual([
      {
        id: 1,
        error: {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Invalid params",
        },
      },
    ]);
  });
});
