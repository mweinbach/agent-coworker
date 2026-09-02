import { describe, expect, test } from "bun:test";
import { createRuntimeRouteHandlers } from "../src/server/jsonrpc/routes/runtime";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { jsonRpcRequestSchemas } from "../src/server/jsonrpc/schema";
import {
  jsonRpcMcpRequestSchemas,
  jsonRpcMcpResultSchemas,
} from "../src/server/jsonrpc/schema.mcp";
import {
  jsonRpcMemoryRequestSchemas,
  jsonRpcMemoryResultSchemas,
} from "../src/server/jsonrpc/schema.memory";
import { jsonRpcMiscNotificationSchemas } from "../src/server/jsonrpc/schema.misc";
import {
  jsonRpcProviderRequestSchemas,
  jsonRpcProviderResultSchemas,
} from "../src/server/jsonrpc/schema.provider";
import { jsonRpcRuntimeResultSchemas } from "../src/server/jsonrpc/schema.runtime";
import { sessionDefaultsApplyRequestSchema } from "../src/server/jsonrpc/schema.sessionRuntime";
import {
  jsonRpcSkillsRequestSchemas,
  jsonRpcSkillsResultSchemas,
} from "../src/server/jsonrpc/schema.skills";
import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../src/shared/jsonrpcControlSchemas";

describe("JSON-RPC control schema forwarders", () => {
  test("provider, MCP, skills, and memory methods forward shared request schemas", () => {
    const forwardedRequestSchemas = {
      ...jsonRpcProviderRequestSchemas,
      ...jsonRpcMcpRequestSchemas,
      ...jsonRpcSkillsRequestSchemas,
      ...jsonRpcMemoryRequestSchemas,
    } as const;

    for (const [method, schema] of Object.entries(forwardedRequestSchemas)) {
      expect(schema).toBe(
        jsonRpcControlRequestSchemas[method as keyof typeof forwardedRequestSchemas],
      );
      expect(jsonRpcRequestSchemas[method as keyof typeof jsonRpcRequestSchemas]).toBe(schema);
    }
  });

  test("provider, MCP, skills, and memory methods forward shared result schemas", () => {
    const forwardedResultSchemas = {
      ...jsonRpcProviderResultSchemas,
      ...jsonRpcMcpResultSchemas,
      ...jsonRpcSkillsResultSchemas,
      ...jsonRpcMemoryResultSchemas,
    } as const;

    for (const [method, schema] of Object.entries(forwardedResultSchemas)) {
      expect(schema).toBe(
        jsonRpcControlResultSchemas[method as keyof typeof forwardedResultSchemas],
      );
    }
  });
});

describe("JSON-RPC emitted control payloads", () => {
  test.each(["downloading", "ready"] as const)(
    "runtime diagnostics preserves %s bootstrap progress",
    (phase) => {
      const diagnostics = {
        startup: {
          ready: phase === "ready",
          progress: {
            phase,
            version: "2026-09-01",
            transferredBytes: 50,
            totalBytes: 100,
            percent: 50,
          },
        },
        sendQueue: {
          queuedSends: 0,
          droppedDeltas: 0,
          droppedImportant: 0,
          serializationFailures: 0,
          sendFailures: 0,
          externalSinkFailures: 0,
          maxQueueDepth: 0,
          queueDepthByConnection: {},
        },
        journal: {
          untrustedThreadCount: 0,
          failedWriteCount: 0,
          droppedEventCount: 0,
          pendingThreadCount: 0,
        },
        dbLocks: {
          waitCount: 0,
          timeoutCount: 0,
          sqliteLockErrorCount: 0,
          staleRecoveryCount: 0,
          lastWaitMs: 0,
          maxWaitMs: 0,
        },
      };
      let result: unknown;
      const context = {
        runtime: { getDiagnostics: () => diagnostics },
        jsonrpc: {
          sendResult: (_ws: unknown, _id: unknown, payload: unknown) => {
            result = payload;
          },
        },
      } as unknown as JsonRpcRouteContext;
      createRuntimeRouteHandlers(context)["cowork/runtime/diagnostics/read"]?.({} as never, {
        id: 1,
        method: "cowork/runtime/diagnostics/read",
        params: {},
      });

      expect(jsonRpcRuntimeResultSchemas["cowork/runtime/diagnostics/read"].parse(result)).toEqual({
        diagnostics,
      });
    },
  );

  test("workspace control notifications accept agent profile catalog refreshes", () => {
    const event = {
      cwd: "/workspace",
      type: "agent_profiles_catalog",
      sessionId: "control-1",
      catalog: {
        profiles: [],
        effectiveProfiles: [],
        diagnostics: [],
        roots: {
          globalDir: "/user/.cowork/agent-profiles",
          workspaceDir: "/workspace/.cowork/agent-profiles",
        },
      },
    };

    expect(jsonRpcMiscNotificationSchemas["cowork/control/event"].parse(event)).toEqual(event);
  });
});

describe("cowork/session/defaults/apply schema", () => {
  test("accepts workflowMaxConcurrentAgents in defaults config", () => {
    const payload = {
      cwd: "/workspace",
      config: {
        workflowMaxConcurrentAgents: 4,
      },
    };

    expect(sessionDefaultsApplyRequestSchema.safeParse(payload).success).toBe(true);
    expect(
      jsonRpcControlRequestSchemas["cowork/session/defaults/apply"].safeParse(payload).success,
    ).toBe(true);
  });

  test("rejects out-of-range workflowMaxConcurrentAgents", () => {
    expect(
      sessionDefaultsApplyRequestSchema.safeParse({
        config: {
          workflowMaxConcurrentAgents: 0,
        },
      }).success,
    ).toBe(false);
    expect(
      jsonRpcControlRequestSchemas["cowork/session/defaults/apply"].safeParse({
        config: {
          workflowMaxConcurrentAgents: 17,
        },
      }).success,
    ).toBe(false);
  });
});
