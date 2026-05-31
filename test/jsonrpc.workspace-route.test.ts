import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    getConfig: () => ({
      builtInDir: "/mocked/builtInDir",
    }),
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
        if (summary.titleSource !== "default") return true;
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

async function invokeWorkspacePresentationPreview(
  handlers: JsonRpcRequestHandlerMap,
  params: unknown,
): Promise<RouteResponse> {
  const handler = handlers["cowork/workspace/presentation/preview"];
  if (!handler) {
    throw new Error("cowork/workspace/presentation/preview handler was not registered");
  }
  const request: JsonRpcLiteRequest = {
    id: 1,
    method: "cowork/workspace/presentation/preview",
    params,
  };

  await handler({} as never, request);

  return {};
}

async function invokeWorkspaceSpreadsheetPatch(
  handlers: JsonRpcRequestHandlerMap,
  params: unknown,
): Promise<void> {
  const handler = handlers["cowork/workspace/spreadsheet/patch"];
  if (!handler) {
    throw new Error("cowork/workspace/spreadsheet/patch handler was not registered");
  }
  await handler({} as never, {
    id: 1,
    method: "cowork/workspace/spreadsheet/patch",
    params,
  } satisfies JsonRpcLiteRequest);
}

async function invokeWorkspaceSpreadsheetVersion(
  handlers: JsonRpcRequestHandlerMap,
  params: unknown,
): Promise<void> {
  const handler = handlers["cowork/workspace/spreadsheet/version"];
  if (!handler) {
    throw new Error("cowork/workspace/spreadsheet/version handler was not registered");
  }
  await handler({} as never, {
    id: 1,
    method: "cowork/workspace/spreadsheet/version",
    params,
  } satisfies JsonRpcLiteRequest);
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

  test("presentation/preview rejects invalid params schema", async () => {
    const harness = createWorkspaceRouteHarness();
    const handlers = createWorkspaceRouteHandlers(harness.context);

    await invokeWorkspacePresentationPreview(handlers, { cwd: "/workspace/project" }); // missing path

    expect(harness.results).toEqual([]);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.error.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
  });

  test("spreadsheet/patch writes a cell and returns ok", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-edit-route-"));
    try {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "a,b\nc,d\n", "utf8");

      const harness = createWorkspaceRouteHarness();
      const handlers = createWorkspaceRouteHandlers(harness.context);
      await invokeWorkspaceSpreadsheetPatch(handlers, {
        cwd: dir,
        path: filePath,
        operations: [{ type: "cell", address: "A1", rawInput: "edited" }],
      });

      expect(harness.errors).toEqual([]);
      const parsed = jsonRpcWorkspaceResultSchemas["cowork/workspace/spreadsheet/patch"].parse(
        harness.results[0]?.result,
      );
      expect(parsed).toEqual({ ok: true });
      expect(await fs.readFile(filePath, "utf8")).toBe("edited,b\nc,d\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("spreadsheet/version returns a file fingerprint for spreadsheet canvases", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-version-route-"));
    try {
      const filePath = path.join(dir, "data.csv");
      await fs.writeFile(filePath, "a,b\nc,d\n", "utf8");

      const harness = createWorkspaceRouteHarness();
      const handlers = createWorkspaceRouteHandlers(harness.context);
      await invokeWorkspaceSpreadsheetVersion(handlers, {
        cwd: dir,
        path: filePath,
      });

      expect(harness.errors).toEqual([]);
      const parsed = jsonRpcWorkspaceResultSchemas["cowork/workspace/spreadsheet/version"].parse(
        harness.results[0]?.result,
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.version.size).toBeGreaterThan(0);
        expect(parsed.version.fingerprint).toContain(":");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("spreadsheet/patch rejects invalid params schema", async () => {
    const harness = createWorkspaceRouteHarness();
    const handlers = createWorkspaceRouteHandlers(harness.context);

    await invokeWorkspaceSpreadsheetPatch(handlers, { cwd: "/workspace/project", path: "x.csv" }); // missing operations

    expect(harness.results).toEqual([]);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.error.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
  });
});
