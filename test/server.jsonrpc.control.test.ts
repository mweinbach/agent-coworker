import fs from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { MemoryStore } from "../src/memoryStore";
import { startAgentServer } from "../src/server/startServer";
import { WorkspaceBackupService } from "../src/server/workspaceBackups";
import { makeTmpProject, serverOpts, stopTestServer } from "./helpers/wsHarness";

async function connectJsonRpc(url: string) {
  const ws = new WebSocket(`${url}?protocol=jsonrpc`);
  const queue: any[] = [];
  const waiters = new Set<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket open")), 5_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });

  const waitFor = async (predicate: (message: any) => boolean, timeoutMs = 5_000) => {
    const existingIndex = queue.findIndex(predicate);
    if (existingIndex >= 0) {
      return queue.splice(existingIndex, 1)[0];
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Timed out waiting for JSON-RPC message"));
      }, timeoutMs);
      const waiter = { predicate, resolve, reject, timer };
      waiters.add(waiter);
    });
  };

  let nextId = 0;
  const request = async (method: string, params?: unknown) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((message) => message.id === id);
  };

  await request("initialize", {
    clientInfo: {
      name: "jsonrpc-control-test",
    },
  });
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    ws,
    request,
    close: () => ws.close(),
  };
}

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

  test("session state read returns the workspace control config bundle", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/state/read", {
        cwd: tmpDir,
      });

      expect(response.result.events.map((event: any) => event.type)).toEqual([
        "config_updated",
        "session_settings",
        "session_config",
      ]);
      const configUpdated = response.result.events[0];
      const sessionSettings = response.result.events[1];
      const sessionConfig = response.result.events[2];
      expect(configUpdated.config.provider).toBe("google");
      expect(configUpdated.config.workingDirectory).toBe(tmpDir);
      expect(sessionSettings.enableMcp).toBe(true);
      expect(sessionConfig.config.defaultBackupsEnabled).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session state read defaults omitted cwd to the server working directory", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/state/read", {});

      expect(response.result.events.map((event: any) => event.type)).toEqual([
        "config_updated",
        "session_settings",
        "session_config",
      ]);
      expect(response.result.events[0]?.config?.workingDirectory).toBe(tmpDir);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider catalog read returns a legacy-compatible provider_catalog event payload", async () => {
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

  test("provider auth methods read returns a legacy-compatible provider_auth_methods event payload", async () => {
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

  test("provider status refresh returns a legacy-compatible provider_status event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/status/refresh", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("provider_status");
      expect(Array.isArray(response.result.event.providers)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("memory list returns a legacy-compatible memory_list event payload", async () => {
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

  test("MCP servers read returns a legacy-compatible mcp_servers event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/mcp/servers/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("mcp_servers");
      expect(Array.isArray(response.result.event.servers)).toBe(true);
      expect(response.result.event.legacy.workspace.path).toContain("mcp-servers.json");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("skills catalog read returns a legacy-compatible skills_catalog event payload", async () => {
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

  test("workspace backups read returns a legacy-compatible workspace_backups event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/backups/workspace/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("workspace_backups");
      expect(response.result.event.workspacePath).toBe(tmpDir);
      expect(Array.isArray(response.result.event.backups)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  for (const method of [
    "cowork/skills/disable",
    "cowork/skills/enable",
    "cowork/skills/delete",
  ] as const) {
    test(`${method} returns a session error when the skill mutation is rejected`, async () => {
      const tmpDir = await makeTmpProject();
      const { server, url } = await startAgentServer(serverOpts(tmpDir));

      try {
        const rpc = await connectJsonRpc(url);
        const response = await rpc.request(method, {
          cwd: tmpDir,
          skillName: "missing-skill",
        });

        expect(response.error.message).toContain('Skill "missing-skill" not found.');
        expect(response.result).toBeUndefined();
        rpc.close();
      } finally {
        await stopTestServer(server);
      }
    });
  }

  test("cowork/skills/installation/checkUpdate returns the emitted validation error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/installation/checkUpdate", {
        cwd: tmpDir,
        installationId: "missing-installation",
      });

      expect(response.error.message).toContain('Skill installation "missing-installation" was not found');
      expect(response.result).toBeUndefined();
      rpc.close();
      } finally {
        await stopTestServer(server);
      }
  });

  test("cowork/skills/installation/read returns the emitted validation error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/installation/read", {
        cwd: tmpDir,
        installationId: "   ",
      });

      expect(response.error.message).toContain("Installation ID is required");
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  for (const method of [
    "cowork/skills/installation/enable",
    "cowork/skills/installation/disable",
    "cowork/skills/installation/delete",
    "cowork/skills/installation/update",
  ] as const) {
    test(`${method} returns the emitted validation error instead of timing out`, async () => {
      const tmpDir = await makeTmpProject();
      const { server, url } = await startAgentServer(serverOpts(tmpDir));

      try {
        const rpc = await connectJsonRpc(url);
        const response = await rpc.request(method, {
          cwd: tmpDir,
          installationId: "missing-installation",
        });

        expect(response.error.message).toContain('Skill installation "missing-installation" was not found');
        expect(response.result).toBeUndefined();
        rpc.close();
      } finally {
        await stopTestServer(server);
      }
    });
  }

  for (const scenario of [
    {
      name: "list",
      method: "cowork/memory/list",
      patch: "list" as const,
      params: (cwd: string) => ({ cwd }),
      expectedMessage: "mock memory list failure",
    },
    {
      name: "upsert",
      method: "cowork/memory/upsert",
      patch: "upsert" as const,
      params: (cwd: string) => ({ cwd, scope: "workspace", content: "remember this" }),
      expectedMessage: "mock memory upsert failure",
    },
    {
      name: "delete",
      method: "cowork/memory/delete",
      patch: "remove" as const,
      params: (cwd: string) => ({ cwd, scope: "workspace", id: "memory-1" }),
      expectedMessage: "mock memory delete failure",
    },
  ] as const) {
    test(`${scenario.method} returns the emitted memory error instead of timing out`, async () => {
      const original = MemoryStore.prototype[scenario.patch];
      (MemoryStore.prototype as any)[scenario.patch] = async function (...args: unknown[]) {
        throw new Error(scenario.expectedMessage);
      };

      const tmpDir = await makeTmpProject();
      const { server, url } = await startAgentServer(serverOpts(tmpDir));

      try {
        const rpc = await connectJsonRpc(url);
        const response = await rpc.request(scenario.method, scenario.params(tmpDir));

        expect(response.error.message).toContain(scenario.expectedMessage);
        expect(response.result).toBeUndefined();
        rpc.close();
      } finally {
        (MemoryStore.prototype as any)[scenario.patch] = original;
        await stopTestServer(server);
      }
    });
  }

  for (const scenario of [
    {
      name: "read",
      method: "cowork/backups/workspace/read",
      patch: "listWorkspaceBackups" as const,
      params: (cwd: string) => ({ cwd }),
      expectedMessage: "mock backup read failure",
    },
    {
      name: "delta",
      method: "cowork/backups/workspace/delta/read",
      patch: "getCheckpointDelta" as const,
      params: (cwd: string) => ({ cwd, targetSessionId: "thread-1", checkpointId: "cp-1" }),
      expectedMessage: "mock backup delta failure",
    },
    {
      name: "checkpoint",
      method: "cowork/backups/workspace/checkpoint",
      patch: "createCheckpoint" as const,
      params: (cwd: string) => ({ cwd, targetSessionId: "thread-1" }),
      expectedMessage: "mock backup checkpoint failure",
    },
  ] as const) {
    test(`${scenario.method} returns the emitted backup error instead of timing out`, async () => {
      const original = WorkspaceBackupService.prototype[scenario.patch];
      (WorkspaceBackupService.prototype as any)[scenario.patch] = async function (...args: unknown[]) {
        throw new Error(scenario.expectedMessage);
      };

      const tmpDir = await makeTmpProject();
      const { server, url } = await startAgentServer(serverOpts(tmpDir));

      try {
        const rpc = await connectJsonRpc(url);
        const response = await rpc.request(scenario.method, scenario.params(tmpDir));

        expect(response.error.message).toContain(scenario.expectedMessage);
        expect(response.result).toBeUndefined();
        rpc.close();
      } finally {
        (WorkspaceBackupService.prototype as any)[scenario.patch] = original;
        await stopTestServer(server);
      }
    });
  }

  test("session control methods return legacy-compatible event payloads", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const threadId = created.result.thread.id as string;

      const renamed = await rpc.request("cowork/session/title/set", {
        threadId,
        title: "Renamed session",
      });
      expect(renamed.result.event.type).toBe("session_info");
      expect(renamed.result.event.title).toBe("Renamed session");

      const modelUpdated = await rpc.request("cowork/session/model/set", {
        threadId,
        provider: "google",
        model: "gemini-3-flash-preview",
      });
      expect(modelUpdated.result.event.type).toBe("config_updated");
      expect(modelUpdated.result.event.config.model).toBe("gemini-3-flash-preview");

      const usageUpdated = await rpc.request("cowork/session/usageBudget/set", {
        threadId,
        stopAtUsd: null,
      });
      expect(usageUpdated.result.event.type).toBe("session_usage");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace file upload returns the saved path in a legacy event envelope", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/file/upload", {
        cwd: tmpDir,
        filename: "upload.txt",
        contentBase64: Buffer.from("hello upload").toString("base64"),
      });

      expect(response.result.event.type).toBe("file_uploaded");
      expect(response.result.event.filename).toBe("upload.txt");
      await expect(fs.readFile(response.result.event.path, "utf8")).resolves.toBe("hello upload");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace file upload rejects malformed base64 payloads", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/file/upload", {
        cwd: tmpDir,
        filename: "upload.txt",
        contentBase64: "!not-base64!",
      });

      expect(response.error.message).toBe("Invalid base64 file contents");
      await expect(fs.readdir(`${tmpDir}/User Uploads`)).rejects.toThrow();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session model set returns the current config when the selected model is unchanged", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const thread = created.result.thread;
      const response = await rpc.request("cowork/session/model/set", {
        threadId: thread.id,
        provider: thread.modelProvider,
        model: thread.model,
      });

      expect(response.result.event.type).toBe("config_updated");
      expect(response.result.event.config.provider).toBe(thread.modelProvider);
      expect(response.result.event.config.model).toBe(thread.model);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session config set returns the current config event when the patch is a no-op", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const response = await rpc.request("cowork/session/config/set", {
        threadId: created.result.thread.id,
        config: {},
      });

      expect(response.result.event.type).toBe("session_config");
      expect(response.result.event.config.defaultBackupsEnabled).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session usage budget returns the emitted validation error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const response = await rpc.request("cowork/session/usageBudget/set", {
        threadId: created.result.thread.id,
        warnAtUsd: 5,
        stopAtUsd: 1,
      });

      expect(response.error.message).toContain("Warning threshold must be less than the hard-stop threshold");
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
