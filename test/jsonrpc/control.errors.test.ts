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

      expect(response.error.message).toContain(
        'Skill installation "missing-installation" was not found',
      );
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

        expect(response.error.message).toContain(
          'Skill installation "missing-installation" was not found',
        );
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
      (MemoryStore.prototype as any)[scenario.patch] = async (...args: unknown[]) => {
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
      (WorkspaceBackupService.prototype as any)[scenario.patch] = async (...args: unknown[]) => {
        throw new Error(scenario.expectedMessage);
      };

      const tmpDir = await makeTmpProject();
      await enableProjectBackups(tmpDir);
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
});
