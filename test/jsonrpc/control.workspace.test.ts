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
  test("workspace control reads do not persist ephemeral control sessions", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    const dbPath = path.join(tmpDir, ".cowork", "sessions.db");
    const countPersistedSessions = () => {
      const db = new Database(dbPath);
      try {
        return Number(
          (db.query("select count(*) as count from sessions").get() as { count: number }).count,
        );
      } finally {
        db.close();
      }
    };

    try {
      const rpc = await connectJsonRpc(url);
      expect(countPersistedSessions()).toBe(0);

      await rpc.request("cowork/skills/catalog/read", { cwd: tmpDir });
      await rpc.request("cowork/plugins/catalog/read", { cwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(countPersistedSessions()).toBe(0);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace control reads and persists the target workspace config", async () => {
    const serverRoot = await makeTmpProject("agent-harness-server-config-");
    const targetWorkspace = await makeTmpProject("agent-harness-target-config-");
    const realTargetWorkspace = await fs.realpath(targetWorkspace);
    await fs.writeFile(
      `${targetWorkspace}/.cowork/config.json`,
      `${JSON.stringify(
        {
          provider: "openai",
          model: "gpt-5.4",
          preferredChildModel: "gpt-5.4",
          enableMcp: false,
          enableA2ui: false,
          enableMemory: false,
        },
        null,
        2,
      )}\n`,
    );

    const { server, url } = await startAgentServer(
      serverOpts(serverRoot, {
        env: {
          AGENT_PROVIDER: undefined,
        },
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const stateResponse = await rpc.request("cowork/session/state/read", {
        cwd: targetWorkspace,
      });

      expect(stateResponse.result.events[0]?.config?.provider).toBe("openai");
      expect(stateResponse.result.events[0]?.config?.model).toBe("gpt-5.4");
      expect(stateResponse.result.events[0]?.config?.workingDirectory).toBe(realTargetWorkspace);
      expect(stateResponse.result.events[1]?.enableMcp).toBe(false);
      expect(stateResponse.result.events[2]?.config?.enableA2ui).toBeUndefined();
      expect(stateResponse.result.events[2]?.config?.enableMemory).toBe(false);

      const defaultsResponse = await rpc.request("cowork/session/defaults/apply", {
        cwd: targetWorkspace,
        config: {
          featureFlags: {
            workspace: {
              a2ui: true,
            },
          },
          enableMemory: true,
        },
      });
      expect(defaultsResponse.result.event.type).toBe("session_config");

      const targetConfig = JSON.parse(
        await fs.readFile(`${targetWorkspace}/.cowork/config.json`, "utf-8"),
      );
      expect(targetConfig.featureFlags?.workspace?.a2ui).toBeUndefined();
      expect(targetConfig.enableMemory).toBe(true);
      await expect(fs.readFile(`${serverRoot}/.cowork/config.json`, "utf-8")).rejects.toBeDefined();

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace feature flags round-trip through session defaults apply", async () => {
    const workspace = await makeTmpProject("agent-harness-feature-flags-");
    await fs.writeFile(
      `${workspace}/.cowork/config.json`,
      `${JSON.stringify(
        {
          featureFlags: {
            workspace: {
              a2ui: false,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const { server, url } = await startAgentServer(
      serverOpts(workspace, { env: { COWORK_EXPERIMENTAL_A2UI: "1" } }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const before = await rpc.request("cowork/session/state/read", { cwd: workspace });
      expect(before.result.events[2]?.type).toBe("session_config");
      expect(before.result.events[2]?.config?.featureFlags?.workspace?.a2ui).toBe(false);
      expect(before.result.events[2]?.config?.enableA2ui).toBe(false);

      const apply = await rpc.request("cowork/session/defaults/apply", {
        cwd: workspace,
        config: {
          featureFlags: {
            workspace: {
              a2ui: true,
            },
          },
        },
      });
      expect(apply.result.event.type).toBe("session_config");
      expect(apply.result.event.config.featureFlags.workspace.a2ui).toBe(true);
      expect(apply.result.event.config.enableA2ui).toBe(true);

      const persisted = JSON.parse(await fs.readFile(`${workspace}/.cowork/config.json`, "utf-8"));
      expect(persisted.featureFlags.workspace.a2ui).toBe(true);

      const after = await rpc.request("cowork/session/state/read", { cwd: workspace });
      expect(after.result.events[2]?.config?.featureFlags?.workspace?.a2ui).toBe(true);
      expect(after.result.events[2]?.config?.enableA2ui).toBe(true);

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("shared control notifications include the workspace cwd for sockets subscribed to multiple workspaces", async () => {
    const workspaceA = await makeTmpProject("agent-harness-plugin-notify-a-");
    const workspaceB = await makeTmpProject("agent-harness-plugin-notify-b-");
    const realWorkspaceA = await fs.realpath(workspaceA);
    const realWorkspaceB = await fs.realpath(workspaceB);
    const sourceRoot = `${workspaceB}/skill-source/example-skill`;
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      `${sourceRoot}/SKILL.md`,
      [
        "---",
        "name: example-skill",
        "description: Example skill",
        "---",
        "",
        "# Example skill",
      ].join("\n"),
    );

    const { server, url } = await startAgentServer(serverOpts(workspaceA));

    try {
      const subscriber = await connectJsonRpc(url);
      const mutator = await connectJsonRpc(url);

      await subscriber.request("cowork/plugins/catalog/read", {
        cwd: workspaceA,
      });
      await subscriber.request("cowork/plugins/catalog/read", {
        cwd: workspaceB,
      });

      const installResponse = await mutator.request("cowork/skills/install", {
        cwd: workspaceB,
        sourceInput: sourceRoot,
        targetScope: "global",
      });
      expect(installResponse.error).toBeUndefined();

      const workspaceBNotification = await subscriber.waitFor(
        (message) =>
          message.method === "cowork/control/event" &&
          message.params?.type === "skills_catalog" &&
          message.params?.cwd === realWorkspaceB,
      );
      expect(workspaceBNotification.params.cwd).toBe(realWorkspaceB);

      await expect(
        subscriber.waitFor(
          (message) =>
            message.method === "cowork/control/event" &&
            message.params?.type === "skills_catalog" &&
            message.params?.cwd === realWorkspaceA,
          200,
        ),
      ).rejects.toThrow("Timed out waiting for JSON-RPC message");

      subscriber.close();
      mutator.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace control skill installs resolve relative sources from the request cwd", async () => {
    const serverRoot = await makeTmpProject("agent-harness-server-skill-root-");
    const targetWorkspace = await makeTmpProject("agent-harness-target-skill-root-");
    const sourceRoot = `${targetWorkspace}/skill-source/example-skill`;
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      `${sourceRoot}/SKILL.md`,
      [
        "---",
        "name: example-skill",
        "description: Example skill",
        "---",
        "",
        "# Example skill",
      ].join("\n"),
    );

    const { server, url } = await startAgentServer(serverOpts(serverRoot));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/install", {
        cwd: targetWorkspace,
        sourceInput: "skill-source/example-skill",
        targetScope: "project",
      });

      expect(response.result.event).toEqual(
        expect.objectContaining({
          type: "skills_catalog",
          catalog: expect.objectContaining({
            installations: expect.arrayContaining([
              expect.objectContaining({
                name: "example-skill",
                scope: "project",
              }),
            ]),
          }),
        }),
      );
      await expect(
        fs.stat(`${targetWorkspace}/.cowork/skills/example-skill/SKILL.md`),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(`${serverRoot}/.cowork/skills/example-skill/SKILL.md`),
      ).rejects.toBeDefined();

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
