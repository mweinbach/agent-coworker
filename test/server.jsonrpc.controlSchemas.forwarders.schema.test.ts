import { describe, expect, test } from "bun:test";
import { jsonRpcRequestSchemas } from "../src/server/jsonrpc/schema";
import {
  jsonRpcMcpRequestSchemas,
  jsonRpcMcpResultSchemas,
} from "../src/server/jsonrpc/schema.mcp";
import {
  jsonRpcMemoryRequestSchemas,
  jsonRpcMemoryResultSchemas,
} from "../src/server/jsonrpc/schema.memory";
import {
  jsonRpcProviderRequestSchemas,
  jsonRpcProviderResultSchemas,
} from "../src/server/jsonrpc/schema.provider";
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
