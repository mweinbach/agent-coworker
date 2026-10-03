import { describe, expect, mock, test } from "bun:test";
import type { MCPResolvedServerAuth } from "../../src/mcp/authStore";
import type { MCPRegistryServer } from "../../src/mcp/configRegistry";
import type { SessionEvent } from "../../src/server/protocol";
import type { McpServerLookup } from "../../src/server/session/mcp/McpServerLookup";
import { McpValidationFlow } from "../../src/server/session/mcp/McpValidationFlow";
import type { AgentConfig, MCPServerConfig } from "../../src/types";

function workspaceServer(name: string): MCPRegistryServer {
  return {
    name,
    source: "workspace",
    inherited: false,
    transport: { type: "stdio", command: "echo" },
    auth: { type: "none" },
  };
}

function authState(
  mode: MCPResolvedServerAuth["mode"],
  message = `${mode} credentials`,
): MCPResolvedServerAuth {
  return {
    mode,
    scope: "workspace",
    authType:
      mode === "api_key"
        ? "api_key"
        : mode === "oauth" || mode === "oauth_pending"
          ? "oauth"
          : "none",
    message,
  };
}

function createHarness(opts?: {
  resolveByName?: (
    name: string,
    lookup?: McpServerLookup | MCPRegistryServer["source"],
  ) => Promise<MCPRegistryServer | null>;
  authState?: MCPResolvedServerAuth | ((server: MCPRegistryServer) => MCPResolvedServerAuth);
  runtimeServer?: MCPServerConfig | null;
  loadTools?: () => Promise<{
    tools: Record<string, unknown>;
    errors: string[];
    close: () => Promise<void>;
  }>;
}) {
  const events: SessionEvent[] = [];
  const telemetry: Array<{ name: string; properties: Record<string, unknown> }> = [];
  const loadValidation = mock(async () => opts?.runtimeServer ?? null);
  const loadTools = mock(
    async () =>
      (await opts?.loadTools?.()) ?? {
        tools: {},
        errors: [],
        close: async () => {},
      },
  );
  const resolveAuth = mock(async (_config: AgentConfig, server: MCPRegistryServer) =>
    typeof opts?.authState === "function"
      ? opts.authState(server)
      : (opts?.authState ?? authState("none", "ready")),
  );
  const captureProductEvent = mock((name: string, properties: Record<string, unknown> = {}) => {
    telemetry.push({ name, properties });
  });
  const resolveByName = mock(
    opts?.resolveByName ??
      (async (name: string) => (name === "live-server" ? workspaceServer(name) : null)),
  );

  const context = {
    id: "session-mcp-validation",
    state: { config: { enableMcp: true } as AgentConfig, running: false, connecting: false },
    emit: (event: SessionEvent) => {
      events.push(event);
    },
    emitError: (code: string, source: string, message: string) => {
      events.push({
        type: "error",
        sessionId: "session-mcp-validation",
        code,
        source,
        message,
      } as SessionEvent);
    },
  };

  const flow = new McpValidationFlow(context as never, { resolveByName } as never, {
    loadMCPServerForValidation: loadValidation,
    loadMCPTools: loadTools,
    resolveMCPServerAuthState: resolveAuth,
    captureProductEvent: captureProductEvent as never,
  });

  return {
    flow,
    events,
    telemetry,
    resolveByName,
    loadValidation,
    loadTools,
    resolveAuth,
  };
}

function validationEvents(events: SessionEvent[]) {
  return events.filter((event) => event.type === "mcp_server_validation");
}

describe("McpValidationFlow", () => {
  test("fails closed for a blank or whitespace-only name before lookup or spawn", async () => {
    const harness = createHarness();
    await harness.flow.validate("   ");
    await harness.flow.validate("");

    expect(harness.resolveByName).not.toHaveBeenCalled();
    expect(harness.resolveAuth).not.toHaveBeenCalled();
    expect(harness.loadValidation).not.toHaveBeenCalled();
    expect(harness.loadTools).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    expect(
      harness.events
        .filter((event) => event.type === "error")
        .map((event) => ({
          code: "code" in event ? event.code : undefined,
          message: "message" in event ? event.message : undefined,
        })),
    ).toEqual([
      { code: "validation_failed", message: "MCP server name is required" },
      { code: "validation_failed", message: "MCP server name is required" },
    ]);
  });

  test("trims the name and reports not-found without spawning", async () => {
    const harness = createHarness({
      resolveByName: async () => null,
    });
    await harness.flow.validate("  missing-server  ");

    expect(harness.resolveByName).toHaveBeenCalledWith("missing-server", undefined);
    expect(harness.resolveAuth).not.toHaveBeenCalled();
    expect(harness.loadValidation).not.toHaveBeenCalled();
    expect(harness.loadTools).not.toHaveBeenCalled();
    expect(validationEvents(harness.events)).toEqual([
      expect.objectContaining({
        type: "mcp_server_validation",
        name: "missing-server",
        ok: false,
        mode: "error",
        message: 'MCP server "missing-server" not found.',
      }),
    ]);
    expect(harness.telemetry).toEqual([
      expect.objectContaining({
        name: "mcp_server_validation_failed",
        properties: expect.objectContaining({ errorCategory: "not_found", status: "failed" }),
      }),
    ]);
  });

  test.each(["missing", "oauth_pending", "error"] as const)(
    "short-circuits %s auth before hydrating or spawning the server",
    async (mode) => {
      const harness = createHarness({
        authState: authState(mode, `${mode} blocked`),
        runtimeServer: { name: "live-server", transport: { type: "stdio", command: "echo" } },
      });
      await harness.flow.validate("live-server");

      expect(harness.resolveAuth).toHaveBeenCalledTimes(1);
      expect(harness.loadValidation).not.toHaveBeenCalled();
      expect(harness.loadTools).not.toHaveBeenCalled();
      expect(validationEvents(harness.events)).toEqual([
        expect.objectContaining({
          type: "mcp_server_validation",
          name: "live-server",
          ok: false,
          mode,
          message: `${mode} blocked`,
        }),
      ]);
      expect(harness.telemetry[0]?.properties).toMatchObject({ errorCategory: mode });
    },
  );

  test("reports not_active when the server is disabled in the current layer", async () => {
    const harness = createHarness({
      authState: authState("none", "ready"),
      runtimeServer: null,
    });
    await harness.flow.validate("live-server");

    expect(harness.loadValidation).toHaveBeenCalledTimes(1);
    expect(harness.loadTools).not.toHaveBeenCalled();
    expect(validationEvents(harness.events)).toEqual([
      expect.objectContaining({
        type: "mcp_server_validation",
        name: "live-server",
        ok: false,
        mode: "error",
        message: "Server is not active in current MCP layering.",
      }),
    ]);
    expect(harness.telemetry[0]?.properties).toMatchObject({ errorCategory: "not_active" });
  });

  test("serializes overlapping validation and emits busy without a second lookup", async () => {
    const lookupReady = Promise.withResolvers<void>();
    const harness = createHarness({
      resolveByName: async () => {
        await lookupReady.promise;
        return null;
      },
    });
    const first = harness.flow.validate("live-server");
    const second = harness.flow.validate("live-server");
    await Promise.resolve();
    expect(harness.resolveByName).toHaveBeenCalledTimes(1);
    expect(harness.events.some((event) => event.type === "error" && event.code === "busy")).toBe(
      true,
    );
    lookupReady.resolve();
    await Promise.all([first, second]);
    expect(harness.resolveByName).toHaveBeenCalledTimes(1);
    expect(harness.loadTools).not.toHaveBeenCalled();
  });

  test("forwards lookup metadata and maps loaded tools on success", async () => {
    const close = mock(async () => {});
    const lookup: McpServerLookup = {
      source: "plugin",
      pluginId: "grep-toolkit",
      pluginScope: "workspace",
    };
    const harness = createHarness({
      authState: authState("none", "ready"),
      runtimeServer: { name: "live-server", transport: { type: "stdio", command: "echo" } },
      loadTools: async () => ({
        tools: {
          search: { description: "Search files" },
          count: { description: 12 },
        },
        errors: [],
        close,
      }),
    });
    await harness.flow.validate("  live-server  ", lookup);

    expect(harness.resolveByName).toHaveBeenCalledWith("live-server", lookup);
    expect(harness.loadTools).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(validationEvents(harness.events)).toEqual([
      expect.objectContaining({
        type: "mcp_server_validation",
        name: "live-server",
        ok: true,
        mode: "none",
        message: "MCP server validation succeeded.",
        toolCount: 2,
        tools: [
          { name: "search", description: "Search files" },
          { name: "count", description: undefined },
        ],
      }),
    ]);
    expect(harness.telemetry).toEqual([]);
  });

  test("records load_failed when tool loading returns errors and still closes the client", async () => {
    const close = mock(async () => {});
    const harness = createHarness({
      authState: authState("api_key", "ready"),
      runtimeServer: {
        name: "live-server",
        transport: { type: "http", url: "https://mcp.example" },
      },
      loadTools: async () => ({
        tools: { ping: { description: "Ping" } },
        errors: ["stdio exited 1"],
        close,
      }),
    });
    await harness.flow.validate("live-server");

    expect(close).toHaveBeenCalledTimes(1);
    expect(validationEvents(harness.events)).toEqual([
      expect.objectContaining({
        ok: false,
        mode: "api_key",
        message: "stdio exited 1",
        toolCount: 1,
      }),
    ]);
    expect(harness.telemetry[0]?.properties).toMatchObject({ errorCategory: "load_failed" });
  });

  test("classifies resolver exceptions without spawning", async () => {
    const harness = createHarness({
      resolveByName: async () => {
        throw new Error("registry unavailable");
      },
    });
    await harness.flow.validate("live-server");

    expect(harness.loadValidation).not.toHaveBeenCalled();
    expect(harness.loadTools).not.toHaveBeenCalled();
    expect(validationEvents(harness.events)).toEqual([
      expect.objectContaining({
        ok: false,
        mode: "error",
        message: "Error: registry unavailable",
      }),
    ]);
    expect(harness.telemetry[0]?.properties).toMatchObject({ errorCategory: "exception" });
  });
});
