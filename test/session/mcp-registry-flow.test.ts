import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../src/platform/sandbox/policy";
import type { SessionEvent } from "../../src/server/protocol";
import { McpRegistryFlow } from "../../src/server/session/mcp/McpRegistryFlow";
import type { SessionContext } from "../../src/server/session/SessionContext";
import type { AgentConfig, MCPServerConfig } from "../../src/types";

const makeConfig = (
  workspaceRoot = "/unused-workspace",
  userHome = "/unused-home",
): AgentConfig => ({
  provider: "google",
  model: "gemini-3-flash-preview",
  preferredChildModel: "gemini-3-flash-preview",
  workingDirectory: workspaceRoot,
  outputDirectory: path.join(workspaceRoot, "output"),
  uploadsDirectory: path.join(workspaceRoot, "uploads"),
  userName: "tester",
  knowledgeCutoff: "unknown",
  projectCoworkDir: path.join(workspaceRoot, ".cowork"),
  userCoworkDir: path.join(userHome, ".cowork"),
  builtInDir: path.join(userHome, "builtin"),
  builtInConfigDir: path.join(userHome, "builtin", "config"),
  skillsDirs: [],
  memoryDirs: [],
  configDirs: [],
  enableMcp: true,
});

function createHarness(config = makeConfig(), opts?: { persistError?: Error }) {
  const events: SessionEvent[] = [];
  const telemetry: Array<{ event: string; status: string; extra: Record<string, unknown> }> = [];
  const persistProjectConfigPatchImpl = mock(async () => {
    if (opts?.persistError) throw opts.persistError;
  });
  const queuePersistSessionSnapshot = mock(() => {});
  const state = { config, running: false, connecting: false };
  const context = {
    id: "session-mcp-registry",
    state,
    deps: { persistProjectConfigPatchImpl },
    emit: (event: SessionEvent) => events.push(event),
    emitError: (code: string, source: string, message: string) =>
      events.push({
        type: "error",
        sessionId: "session-mcp-registry",
        code,
        source,
        message,
      } as SessionEvent),
    emitTelemetry: (event: string, status: string, extra: Record<string, unknown>) =>
      telemetry.push({ event, status, extra }),
    queuePersistSessionSnapshot,
    guardBusy: () => !state.running && !state.connecting,
  } as unknown as SessionContext;

  return {
    flow: new McpRegistryFlow(context),
    events,
    telemetry,
    state,
    persistProjectConfigPatchImpl,
    queuePersistSessionSnapshot,
  };
}

async function withTempRoots(fn: (workspace: string, home: string) => Promise<void>) {
  const workspace = await fs.mkdtemp(path.join(scratchRoots()[0], "mcp-registry-ws-"));
  const home = await fs.mkdtemp(path.join(scratchRoots()[0], "mcp-registry-home-"));
  try {
    await fn(workspace, home);
  } finally {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(home, { recursive: true, force: true }),
    ]);
  }
}

describe("McpRegistryFlow", () => {
  test("setEnableMcp respects busy gate, no-ops when unchanged, and keeps session flag on persist error", async () => {
    const busy = createHarness();
    busy.state.running = true;
    await busy.flow.setEnableMcp(false);
    expect(busy.state.config.enableMcp).toBe(true);
    expect(busy.persistProjectConfigPatchImpl).not.toHaveBeenCalled();
    expect(busy.events).toEqual([
      expect.objectContaining({ type: "error", code: "busy", message: "Agent is busy" }),
    ]);

    const noop = createHarness();
    await noop.flow.setEnableMcp(true);
    expect(noop.persistProjectConfigPatchImpl).not.toHaveBeenCalled();
    expect(noop.queuePersistSessionSnapshot).not.toHaveBeenCalled();
    expect(noop.telemetry).toEqual([
      expect.objectContaining({
        event: "session.defaults.noop",
        status: "ok",
        extra: expect.objectContaining({ operation: "set_enable_mcp" }),
      }),
    ]);

    const failing = createHarness(makeConfig(), { persistError: new Error("disk full") });
    await failing.flow.setEnableMcp(false);
    expect(failing.state.config.enableMcp).toBe(false);
    expect(failing.queuePersistSessionSnapshot).toHaveBeenCalledWith("session.enable_mcp");
    expect(failing.events.some((event) => event.type === "session_settings")).toBe(true);
    expect(failing.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          code: "internal_error",
          message: expect.stringContaining("failed to persist defaults: Error: disk full"),
        }),
      ]),
    );
  });

  test("classifies mcp-servers.json failures as validation_failed and does not emit a snapshot", async () => {
    await withTempRoots(async (workspace, home) => {
      const harness = createHarness(makeConfig(workspace, home));
      const blankServer: MCPServerConfig = {
        name: "   ",
        transport: { type: "stdio", command: "echo" },
        auth: { type: "none" },
      };
      expect(await harness.flow.upsert(blankServer)).toBeNull();
      await harness.flow.delete("   ");
      await harness.flow.setEnabled({ name: "system-server", source: "system", enabled: false });
      await harness.flow.setEnabled({ name: "plugin-server", source: "plugin", enabled: false });

      const errors = harness.events.filter((event) => event.type === "error");
      expect(errors.map((event) => event.code)).toEqual([
        "validation_failed",
        "validation_failed",
        "validation_failed",
        "validation_failed",
      ]);
      expect(errors.every((event) => event.message.includes("mcp-servers.json"))).toBe(true);
      expect(harness.events.some((event) => event.type === "mcp_servers")).toBe(false);
      expect(await fs.exists(path.join(workspace, ".cowork", "mcp-servers.json"))).toBe(false);
    });
  });

  test("ignores a malformed workspace mcp-servers.json instead of loading it", async () => {
    await withTempRoots(async (workspace, home) => {
      await fs.mkdir(path.join(workspace, ".cowork"), { recursive: true });
      await fs.writeFile(path.join(workspace, ".cowork", "mcp-servers.json"), "{not-json", "utf-8");
      const harness = createHarness(makeConfig(workspace, home));
      await harness.flow.emitMcpServers();

      const snapshot = harness.events.find((event) => event.type === "mcp_servers");
      expect(snapshot?.type).toBe("mcp_servers");
      if (snapshot?.type !== "mcp_servers") return;
      expect(snapshot.servers).toEqual([]);
      expect(
        snapshot.warnings?.some((warning) => warning.includes("malformed workspace config")),
      ).toBe(true);
      expect(
        snapshot.files.some(
          (file) => file.source === "workspace" && typeof file.parseError === "string",
        ),
      ).toBe(true);
      expect(harness.events.some((event) => event.type === "error")).toBe(false);
    });
  });
});
