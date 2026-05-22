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
  test("provider auth authorize returns the emitted session error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/auth/authorize", {
        cwd: tmpDir,
        provider: "google",
        methodId: "missing_method",
      });

      expect(response.error.message).toContain("Unsupported auth method");
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider catalog read returns a session-event provider_catalog event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/catalog/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("provider_catalog");
      expect(Array.isArray(response.result.event.all)).toBe(true);
      expect(response.result.event.default.google).toBeDefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider auth methods read returns a session-event provider_auth_methods event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/authMethods/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("provider_auth_methods");
      expect(response.result.event.methods.google).toEqual(expect.any(Array));
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider status refresh returns a session-event provider_status event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/status/refresh", {
        cwd: tmpDir,
        refreshBedrockDiscovery: true,
      });

      expect(response.result.event.type).toBe("provider_status");
      expect(Array.isArray(response.result.event.providers)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
