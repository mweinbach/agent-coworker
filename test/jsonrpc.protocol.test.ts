import { describe, expect, test } from "bun:test";

import {
  buildJsonRpcErrorResponse,
  buildJsonRpcResultResponse,
  JSONRPC_ERROR_CODES,
  parseInitializedParams,
  parseInitializeParams,
  parseJsonRpcClientMessage,
} from "../src/server/jsonrpc/protocol";
import { jsonRpcAgentNotificationSchemas } from "../src/server/jsonrpc/schema.agents";
import { jsonRpcCoreRequestSchemas } from "../src/server/jsonrpc/schema.core";

describe("JSON-RPC-lite protocol parsing", () => {
  test("workflow progress notifications preserve run and agent errors", () => {
    const parsed = jsonRpcAgentNotificationSchemas["cowork/session/workflowProgress"].parse({
      type: "workflow_progress",
      sessionId: "session-1",
      progress: {
        runId: "wf_123",
        name: "Failure",
        phases: ["main"],
        currentPhase: "main",
        agents: [
          {
            index: 0,
            label: "worker",
            phase: "main",
            state: "errored",
            agentId: "agent-1",
            usdCost: 0.1,
            error: "child failed",
          },
        ],
        logs: [],
        spentUsd: 0.1,
        outcome: "errored",
        error: "run failed",
      },
    });

    expect(parsed.progress.error).toBe("run failed");
    expect(parsed.progress.agents[0]?.error).toBe("child failed");
  });

  test("parses valid requests and notifications", () => {
    const request = parseJsonRpcClientMessage(
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "desktop",
          },
        },
      }),
    );
    expect(request.ok).toBe(true);
    if (request.ok) {
      expect(request.message).toEqual({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "desktop",
          },
        },
      });
    }

    const notification = parseJsonRpcClientMessage(
      JSON.stringify({
        method: "initialized",
      }),
    );
    expect(notification.ok).toBe(true);
    if (notification.ok) {
      expect(notification.message).toEqual({
        method: "initialized",
      });
    }
  });

  test("rejects malformed envelopes", () => {
    expect(parseJsonRpcClientMessage("{bad")).toEqual({
      ok: false,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.parseError,
        message: "Invalid JSON",
      },
    });

    expect(parseJsonRpcClientMessage(JSON.stringify(["bad"]))).toEqual({
      ok: false,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: "Expected object",
      },
    });
  });

  test("validates initialize params", () => {
    expect(
      parseInitializeParams({
        clientInfo: {
          name: "desktop",
          title: "Desktop App",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["thread/started"],
        },
      }),
    ).toEqual({
      ok: true,
      params: {
        clientInfo: {
          name: "desktop",
          title: "Desktop App",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["thread/started"],
        },
      },
    });

    const invalid = parseInitializeParams({
      clientInfo: {
        name: "",
      },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
    }
  });

  test("initialize trims names and opt-outs without altering optional client metadata", () => {
    const params = {
      clientInfo: { name: " desktop \n", title: " Desktop App ", version: " 1.0 " },
      capabilities: {
        experimentalApi: false,
        toolRetryLineage: true,
        optOutNotificationMethods: [" item/started ", "\nturn/completed\t"],
      },
    };
    const expected = {
      clientInfo: { name: "desktop", title: " Desktop App ", version: " 1.0 " },
      capabilities: {
        experimentalApi: false,
        toolRetryLineage: true,
        optOutNotificationMethods: ["item/started", "turn/completed"],
      },
    };
    expect(parseInitializeParams(params)).toEqual({ ok: true, params: expected });
    expect(jsonRpcCoreRequestSchemas.initialize.parse(params)).toEqual(expected);
    expect(params.clientInfo.name).toBe(" desktop \n");
    expect(params.capabilities.optOutNotificationMethods[0]).toBe(" item/started ");
  });

  test.each([
    { label: "minimal client info", params: { clientInfo: { name: "desktop" } }, valid: true },
    {
      label: "disabled retry capability",
      params: { clientInfo: { name: "desktop" }, capabilities: { toolRetryLineage: false } },
      valid: true,
    },
    { label: "missing params", params: undefined, valid: false },
    { label: "null params", params: null, valid: false },
    { label: "missing client info", params: {}, valid: false },
    { label: "blank client name", params: { clientInfo: { name: " \n" } }, valid: false },
    {
      label: "unknown root field",
      params: { clientInfo: { name: "desktop" }, extra: true },
      valid: false,
    },
    {
      label: "unknown client field",
      params: { clientInfo: { name: "desktop", extra: true } },
      valid: false,
    },
    {
      label: "unknown capability",
      params: { clientInfo: { name: "desktop" }, capabilities: { extra: true } },
      valid: false,
    },
    {
      label: "non-boolean retry capability",
      params: { clientInfo: { name: "desktop" }, capabilities: { toolRetryLineage: "true" } },
      valid: false,
    },
    {
      label: "blank notification opt-out",
      params: {
        clientInfo: { name: "desktop" },
        capabilities: { optOutNotificationMethods: [" "] },
      },
      valid: false,
    },
  ])("initialize runtime and core schema agree on $label", ({ params, valid }) => {
    const core = jsonRpcCoreRequestSchemas.initialize.safeParse(params);
    const runtime = parseInitializeParams(params);
    expect(core.success).toBe(valid);
    expect(runtime).toEqual(
      core.success
        ? { ok: true, params: core.data }
        : {
            ok: false,
            error: {
              code: JSONRPC_ERROR_CODES.invalidParams,
              message: core.error.issues[0]?.message,
            },
          },
    );
  });

  test.each([
    { label: "null", params: null },
    { label: "array", params: [] },
    { label: "string", params: "" },
    { label: "boolean", params: false },
    { label: "unknown field", params: { extra: true } },
  ])("initialized rejects $label without normalizing it", ({ params }) => {
    const core = jsonRpcCoreRequestSchemas.initialized.safeParse(params);
    expect(core.success).toBe(false);
    if (core.success) throw new Error("Expected invalid initialized params");
    expect(parseInitializedParams(params)).toEqual({
      ok: false,
      error: { code: JSONRPC_ERROR_CODES.invalidParams, message: core.error.issues[0]?.message },
    });
  });

  test("normalizes initialized params", () => {
    expect(jsonRpcCoreRequestSchemas.initialized.safeParse(undefined).success).toBe(false);
    expect(parseInitializedParams(undefined)).toEqual({
      ok: true,
      params: {},
    });
    expect(parseInitializedParams({})).toEqual({
      ok: true,
      params: {},
    });
  });

  test("builds result and error responses", () => {
    expect(buildJsonRpcResultResponse(1, { ok: true })).toEqual({
      id: 1,
      result: { ok: true },
    });
    expect(buildJsonRpcErrorResponse(1, { code: -1, message: "boom" })).toEqual({
      id: 1,
      error: { code: -1, message: "boom" },
    });
  });
});
