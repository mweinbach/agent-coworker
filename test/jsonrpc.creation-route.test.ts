import { describe, expect, test } from "bun:test";
import {
  JSONRPC_ERROR_CODES,
  type JsonRpcLiteError,
  type JsonRpcLiteId,
  type JsonRpcLiteRequest,
} from "../src/server/jsonrpc/protocol";
import { createCreationRouteHandlers } from "../src/server/jsonrpc/routes/creation";
import type {
  JsonRpcRequestHandler,
  JsonRpcRouteContext,
} from "../src/server/jsonrpc/routes/types";
import { jsonRpcCreationResultSchemas } from "../src/server/jsonrpc/schema.creation";
import type { AgentConfig } from "../src/types";

const METHOD = "cowork/creation/preflight";

type CreationRouteHarness = {
  context: JsonRpcRouteContext;
  results: Array<{ id: JsonRpcLiteId; result: unknown }>;
  errors: Array<{ id: JsonRpcLiteId | null; error: JsonRpcLiteError }>;
  resolvedWorkspaces: string[];
};

const routeConfig = {
  provider: "google",
  model: "gemini-2.5-flash",
  workingDirectory: "/workspace/project",
  skillsDirs: [],
  userCoworkDir: "/workspace/.cowork-jsonrpc-creation-route-test",
} as AgentConfig;

function createCreationRouteHarness(
  options: {
    getDiagnostics?: JsonRpcRouteContext["runtime"]["getDiagnostics"];
    resolveWorkspacePath?: JsonRpcRouteContext["utils"]["resolveWorkspacePath"];
  } = {},
): CreationRouteHarness {
  const results: CreationRouteHarness["results"] = [];
  const errors: CreationRouteHarness["errors"] = [];
  const resolvedWorkspaces: string[] = [];

  const context = {
    getConfig: () => routeConfig,
    homedir: "/workspace/jsonrpc-creation-route-home",
    runtime: {
      getDiagnostics:
        options.getDiagnostics ??
        (() => ({
          startup: { ready: true },
        })),
    },
    utils: {
      resolveWorkspacePath:
        options.resolveWorkspacePath ??
        ((params: Record<string, unknown>, method: string) => {
          resolvedWorkspaces.push(`${method}:${String(params.cwd ?? "")}`);
          return String(params.cwd ?? routeConfig.workingDirectory);
        }),
    },
    jsonrpc: {
      sendResult: (_ws: unknown, id: JsonRpcLiteId, result: unknown) => {
        results.push({ id, result });
      },
      sendError: (_ws: unknown, id: JsonRpcLiteId | null, error: JsonRpcLiteError) => {
        errors.push({ id, error });
      },
    },
  } as unknown as JsonRpcRouteContext;

  return { context, results, errors, resolvedWorkspaces };
}

function getCreationPreflightHandler(context: JsonRpcRouteContext): JsonRpcRequestHandler {
  const handler = createCreationRouteHandlers(context)[METHOD];
  if (!handler) {
    throw new Error(`${METHOD} handler was not registered`);
  }
  return handler;
}

async function invokeCreationPreflight(
  context: JsonRpcRouteContext,
  params: unknown,
  id: JsonRpcLiteId = 1,
): Promise<void> {
  await getCreationPreflightHandler(context)({} as never, {
    id,
    method: METHOD,
    params,
  } satisfies JsonRpcLiteRequest);
}

describe("creation preflight JSON-RPC route", () => {
  test("rejects invalid params before touching workspace dependencies", async () => {
    const harness = createCreationRouteHarness({
      resolveWorkspacePath: () => {
        throw new Error("workspace should not resolve for invalid params");
      },
    });

    await invokeCreationPreflight(harness.context, {
      kind: "chat",
      cwd: "/workspace/project",
      provider: "google",
      model: "",
    });

    expect(harness.results).toEqual([]);
    expect(harness.resolvedWorkspaces).toEqual([]);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.error.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
  });

  test("returns a schema-valid research readiness result for valid params", async () => {
    const harness = createCreationRouteHarness();

    await invokeCreationPreflight(
      harness.context,
      {
        kind: "research",
        cwd: "/workspace/project",
      },
      "research-preflight",
    );

    expect(harness.errors).toEqual([]);
    expect(harness.resolvedWorkspaces).toEqual(["cowork/creation/preflight:/workspace/project"]);
    const result = jsonRpcCreationResultSchemas[METHOD].parse(harness.results[0]?.result);
    expect(result.checks.find((entry) => entry.id === "project_access")).toMatchObject({
      status: "ok",
      message: "Workspace is accessible: /workspace/project",
    });
    expect(result.checks.find((entry) => entry.id === "runtime_ready")).toMatchObject({
      status: "ok",
      message: "Runtime is ready.",
    });
  });

  test("maps unexpected preflight failures to JSON-RPC internal errors", async () => {
    const harness = createCreationRouteHarness({
      getDiagnostics: () => {
        throw new Error("diagnostics unavailable");
      },
    });

    await invokeCreationPreflight(harness.context, { kind: "research" }, 42);

    expect(harness.results).toEqual([]);
    expect(harness.errors).toEqual([
      {
        id: 42,
        error: {
          code: JSONRPC_ERROR_CODES.internalError,
          message: "Creation preflight failed: diagnostics unavailable",
        },
      },
    ]);
  });
});
