import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { MemoryStore } from "../../src/memoryStore";
import { AgentControl } from "../../src/server/agents/AgentControl";
import { AgentSession } from "../../src/server/session/AgentSession";
import { startAgentServer } from "../../src/server/startServer";
import { WorkspaceBackupService } from "../../src/server/workspaceBackups";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc, enableProjectBackups } from "./control.harness";

describe("server JSON-RPC control methods", () => {
  test("memory list returns a session-event memory_list event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/memory/list", {
        cwd: tmpDir,
      });

      expect(response.result.event).toEqual({
        type: "memory_list",
        sessionId: expect.any(String),
        memories: [],
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("MCP servers read returns a session-event mcp_servers event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/mcp/servers/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("mcp_servers");
      expect(Array.isArray(response.result.event.servers)).toBe(true);
      expect(response.result.event.files[0]?.path).toContain("mcp-servers.json");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("skills catalog read returns a session-event skills_catalog event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/catalog/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("skills_catalog");
      expect(Array.isArray(response.result.event.catalog.installations)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace backups read returns a session-event workspace_backups event payload", async () => {
    const tmpDir = await makeTmpProject();
    const realTmpDir = await fs.realpath(tmpDir);
    await enableProjectBackups(tmpDir);
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/backups/workspace/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("workspace_backups");
      expect(response.result.event.workspacePath).toBe(realTmpDir);
      expect(Array.isArray(response.result.event.backups)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace backups read returns a disabled error when backups are off", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/backups/workspace/read", {
        cwd: tmpDir,
      });

      expect(response.error.message).toContain("Workspace backup APIs are disabled");
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
