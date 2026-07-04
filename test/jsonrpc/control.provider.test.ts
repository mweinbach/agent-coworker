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

  test("provider custom model add returns the updated provider_catalog event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/customModel/add", {
        cwd: tmpDir,
        provider: "nvidia",
        modelId: "nvidia/custom-preview-model",
      });

      expect(response.result.event.type).toBe("provider_catalog");
      const nvidia = response.result.event.all.find(
        (entry: { id?: string }) => entry.id === "nvidia",
      );
      expect(nvidia?.models).toContainEqual(
        expect.objectContaining({
          id: "nvidia/custom-preview-model",
          runtimeOptions: { source: "custom" },
        }),
      );
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider model setEnabled and resetEnabled round-trip through the provider_catalog payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const initial = await rpc.request("cowork/provider/catalog/read", { cwd: tmpDir });
      const initialOpenai = initial.result.event.all.find(
        (entry: { id?: string }) => entry.id === "openai",
      );
      const initialDefault = initialOpenai.defaultModel as string;
      expect(initialOpenai.models.length).toBeGreaterThan(1);

      const disabled = await rpc.request("cowork/provider/model/setEnabled", {
        cwd: tmpDir,
        provider: "openai",
        models: [{ id: initialDefault, enabled: false }],
      });
      expect(disabled.result.event.type).toBe("provider_catalog");
      const disabledOpenai = disabled.result.event.all.find(
        (entry: { id?: string }) => entry.id === "openai",
      );
      expect(
        disabledOpenai.models.find((model: { id?: string }) => model.id === initialDefault)
          ?.enabled,
      ).toBe(false);
      expect(disabledOpenai.defaultModel).not.toBe(initialDefault);
      expect(disabled.result.event.default.openai).toBe(disabledOpenai.defaultModel);

      const reset = await rpc.request("cowork/provider/model/resetEnabled", {
        cwd: tmpDir,
        provider: "openai",
      });
      const resetOpenai = reset.result.event.all.find(
        (entry: { id?: string }) => entry.id === "openai",
      );
      expect(
        resetOpenai.models.find((model: { id?: string }) => model.id === initialDefault)?.enabled,
      ).toBeUndefined();
      expect(resetOpenai.defaultModel).toBe(initialDefault);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider model setEnabled rejects malformed params", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const missingModels = await rpc.request("cowork/provider/model/setEnabled", {
        cwd: tmpDir,
        provider: "openai",
        models: [],
      });
      expect(missingModels.error.code).toBe(-32602);

      const badProvider = await rpc.request("cowork/provider/model/setEnabled", {
        cwd: tmpDir,
        provider: "not-a-provider",
        models: [{ id: "gpt-5.4", enabled: false }],
      });
      expect(badProvider.error.code).toBe(-32602);

      const badEntry = await rpc.request("cowork/provider/model/setEnabled", {
        cwd: tmpDir,
        provider: "openai",
        models: [{ id: "gpt-5.4" }],
      });
      expect(badEntry.error.code).toBe(-32602);
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
