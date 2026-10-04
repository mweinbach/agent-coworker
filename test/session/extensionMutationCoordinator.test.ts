import { describe, expect, mock, test } from "bun:test";
import { ExtensionMutationCoordinator } from "../../src/server/session/ExtensionMutationCoordinator";
import type { PluginCatalogService } from "../../src/server/session/PluginCatalogService";
import type { SessionContext } from "../../src/server/session/SessionContext";

function createHarness() {
  const steps: string[] = [];
  const context = {
    refreshSkillsAcrossWorkspaceSessions: mock(async (opts?: { allWorkspaces?: boolean }) => {
      steps.push(`refresh-skills:${opts?.allWorkspaces === true}`);
    }),
    emitMcpServers: mock(async () => {
      steps.push("mcp");
    }),
  } as unknown as SessionContext;
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
  return {
    coordinator: new ExtensionMutationCoordinator(
      context,
      pluginCatalog as unknown as PluginCatalogService,
      emitters,
    ),
    steps,
    pluginCatalog,
    emitters,
  };
}

describe("ExtensionMutationCoordinator", () => {
  test("refreshes surfaces in order and optionally emits selected installation detail", async () => {
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

    steps.length = 0;
    emitters.emitSkillInstallationDetail.mockClear();
    await coordinator.afterPluginMutation();
    await coordinator.afterSkillMutation({ selectedInstallationId: "" });

    const defaultCycle = [
      "invalidate",
      "refresh-skills:false",
      "legacy",
      "commands",
      "skills-catalog:",
      "plugins:",
      "queue-remote",
      "mcp",
    ];
    expect(steps).toEqual([...defaultCycle, ...defaultCycle]);
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
