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
  test("session state read returns the workspace control config bundle", async () => {
    const tmpDir = await makeTmpProject();
    const realTmpDir = await fs.realpath(tmpDir);
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
      expect(configUpdated.config.workingDirectory).toBe(realTmpDir);
      expect(sessionSettings.enableMcp).toBe(true);
      expect(sessionConfig.config.defaultBackupsEnabled).toBe(false);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session state read defaults omitted cwd to the server working directory", async () => {
    const tmpDir = await makeTmpProject();
    const realTmpDir = await fs.realpath(tmpDir);
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/state/read", {});

      expect(response.result.events.map((event: any) => event.type)).toEqual([
        "config_updated",
        "session_settings",
        "session_config",
      ]);
      expect(response.result.events[0]?.config?.workingDirectory).toBe(realTmpDir);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session control methods return session-event event payloads", async () => {
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

  test("session delete rejects targets from another workspace", async () => {
    const tmpDir = await makeTmpProject();
    const otherTmpDir = await makeTmpProject();
    const primary = await startAgentServer(serverOpts(tmpDir));
    const secondary = await startAgentServer(
      serverOpts(otherTmpDir, {
        homedir: tmpDir,
      }),
    );
    let secondaryStopped = false;

    try {
      const rpc = await connectJsonRpc(primary.url);
      const otherRpc = await connectJsonRpc(secondary.url);
      const other = await otherRpc.request("thread/start", { cwd: otherTmpDir });
      const otherThreadId = other.result.thread.id;
      await otherRpc.request("cowork/session/title/set", {
        threadId: otherThreadId,
        title: "Other workspace",
      });
      otherRpc.close();
      await stopTestServer(secondary.server);
      secondaryStopped = true;

      const response = await rpc.request("cowork/session/delete", {
        cwd: tmpDir,
        targetSessionId: otherThreadId,
      });

      expect(response.error.message).toContain("outside the active workspace");
      expect(response.result).toBeUndefined();
      const db = new Database(path.join(tmpDir, ".cowork", "sessions.db"));
      try {
        const preserved = db
          .query("select count(*) as count from sessions where session_id = ?")
          .get(otherThreadId) as { count: number };
        expect(preserved.count).toBe(1);
      } finally {
        db.close();
      }
      rpc.close();
    } finally {
      if (!secondaryStopped) {
        await stopTestServer(secondary.server);
      }
      await stopTestServer(primary.server);
    }
  });

  test("session agent inspect returns the detailed inspect payload", async () => {
    const originalInspect = AgentControl.prototype.inspect;
    (AgentControl.prototype as any).inspect = async function inspectMock() {
      return {
        agent: {
          agentId: "child-1",
          parentSessionId: "thread-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          effectiveModel: "gpt-5.4",
          title: "child",
          provider: "openai",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lifecycleState: "closed",
          executionState: "completed",
          busy: false,
          lastMessagePreview: "done",
        },
        latestAssistantText:
          'done\n\n<agent_report>{"status":"completed","summary":"Task done"}</agent_report>',
        parsedReport: {
          status: "completed",
          summary: "Task done",
        },
        sessionUsage: null,
        lastTurnUsage: null,
      };
    };

    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const threadId = created.result.thread.id as string;
      const response = await rpc.request("cowork/session/agent/inspect", {
        threadId,
        agentId: "child-1",
      });

      expect(response.result.event.agent.agentId).toBe("child-1");
      expect(response.result.event.latestAssistantText).toContain("done");
      expect(response.result.event.parsedReport.summary).toBe("Task done");
      rpc.close();
    } finally {
      (AgentControl.prototype as any).inspect = originalInspect;
      await stopTestServer(server);
    }
  });

  test("workspace file upload returns the saved path in a session event envelope", async () => {
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
      expect(response.result.event.config.defaultBackupsEnabled).toBe(false);
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

      expect(response.error.message).toContain(
        "Warning threshold must be less than the hard-stop threshold",
      );
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
