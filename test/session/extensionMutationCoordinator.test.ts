import { describe, expect, mock, test } from "bun:test";
import { ExtensionMutationCoordinator } from "../../src/server/session/ExtensionMutationCoordinator";
import type { PluginCatalogService } from "../../src/server/session/PluginCatalogService";
import type { SessionContext } from "../../src/server/session/SessionContext";

function createHarness() {
  const steps: string[] = [];
  const refreshSkillsAcrossWorkspaceSessions = mock(async (opts?: { allWorkspaces?: boolean }) => {
    steps.push(`refresh-skills:${opts?.allWorkspaces === true}`);
  });
  const emitMcpServers = mock(async () => {
    steps.push("mcp");
  });
  const context = {
    refreshSkillsAcrossWorkspaceSessions,
    emitMcpServers,
  } as SessionContext;
  const pluginCatalog = {
    invalidateRemoteCatalogRefreshes: mock(() => {
      steps.push("invalidate");
    }),
    emitCatalog: mock(async (keys: string[] = []) => {
      steps.push(`plugins:${keys.join(",")}`);
    }),
    queueRemoteCatalogRefresh: mock(() => {
      steps.push("queue-remote");
    }),
  };
  const emitters = {
    emitLegacySkillsList: mock(async () => {
      steps.push("legacy");
    }),
    emitSkillsCatalog: mock(async (keys: string[] = []) => {
      steps.push(`skills-catalog:${keys.join(",")}`);
    }),
    emitSkillInstallationDetail: mock(async (installationId: string) => {
      steps.push(`detail:${installationId}`);
    }),
    listCommands: mock(async () => {
      steps.push("commands");
    }),
  };
  const coordinator = new ExtensionMutationCoordinator(
    context,
    pluginCatalog as unknown as PluginCatalogService,
    emitters,
  );
  return { coordinator, steps, context, pluginCatalog, emitters };
}

describe("ExtensionMutationCoordinator", () => {
  test("refreshes skill surfaces before the selected installation detail", async () => {
    const { coordinator, steps, emitters } = createHarness();

    await coordinator.afterSkillMutation({
      selectedInstallationId: "install-1",
      clearedMutationPendingKeys: ["skill:alpha"],
      refreshAllWorkspaces: true,
    });

    expect(steps).toEqual([
      "invalidate",
      "refresh-skills:true",
      "legacy",
      "commands",
      "skills-catalog:skill:alpha",
      "plugins:skill:alpha",
      "queue-remote",
      "mcp",
      "detail:install-1",
    ]);
    expect(emitters.emitSkillInstallationDetail).toHaveBeenCalledTimes(1);
  });

  test("plugin mutations skip installation detail and default to the current workspace", async () => {
    const { coordinator, steps, emitters } = createHarness();

    await coordinator.afterPluginMutation();
    await coordinator.afterSkillMutation({ selectedInstallationId: "" });

    expect(steps).toEqual([
      "invalidate",
      "refresh-skills:false",
      "legacy",
      "commands",
      "skills-catalog:",
      "plugins:",
      "queue-remote",
      "mcp",
      "invalidate",
      "refresh-skills:false",
      "legacy",
      "commands",
      "skills-catalog:",
      "plugins:",
      "queue-remote",
      "mcp",
    ]);
    expect(emitters.emitSkillInstallationDetail).not.toHaveBeenCalled();
  });

  test("stops the refresh when an earlier surface fails", async () => {
    const { coordinator, steps, emitters, pluginCatalog } = createHarness();
    emitters.listCommands.mockImplementation(async () => {
      steps.push("commands");
      throw new Error("command list failed");
    });

    await expect(
      coordinator.afterSkillMutation({
        selectedInstallationId: "install-1",
        clearedMutationPendingKeys: ["skill:alpha"],
      }),
    ).rejects.toThrow("command list failed");

    expect(steps).toEqual(["invalidate", "refresh-skills:false", "legacy", "commands"]);
    expect(emitters.emitSkillsCatalog).not.toHaveBeenCalled();
    expect(pluginCatalog.emitCatalog).not.toHaveBeenCalled();
    expect(pluginCatalog.queueRemoteCatalogRefresh).not.toHaveBeenCalled();
    expect(emitters.emitSkillInstallationDetail).not.toHaveBeenCalled();
  });
});
