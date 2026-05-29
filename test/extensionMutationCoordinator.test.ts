import { describe, expect, test } from "bun:test";

import { ExtensionMutationCoordinator } from "../src/server/session/ExtensionMutationCoordinator";

type CoordinatorArgs = ConstructorParameters<typeof ExtensionMutationCoordinator>;

function makeCoordinator() {
  const calls = {
    emitSkillsCatalog: 0,
    queueRemoteSkillCatalogRefresh: 0,
    pluginEmitCatalog: 0,
    pluginQueueRemoteRefresh: 0,
    pluginInvalidate: 0,
    refreshAcrossWorkspaces: 0,
    emitMcpServers: 0,
  };

  const context = {
    refreshSkillsAcrossWorkspaceSessions: async () => {
      calls.refreshAcrossWorkspaces += 1;
    },
    emitMcpServers: async () => {
      calls.emitMcpServers += 1;
    },
  };

  const pluginCatalogService = {
    invalidateRemoteCatalogRefreshes: () => {
      calls.pluginInvalidate += 1;
    },
    emitCatalog: async () => {
      calls.pluginEmitCatalog += 1;
    },
    queueRemoteCatalogRefresh: () => {
      calls.pluginQueueRemoteRefresh += 1;
    },
  };

  const emitters = {
    emitLegacySkillsList: async () => {},
    emitSkillsCatalog: async () => {
      calls.emitSkillsCatalog += 1;
    },
    queueRemoteSkillCatalogRefresh: () => {
      calls.queueRemoteSkillCatalogRefresh += 1;
    },
    emitSkillInstallationDetail: async () => {},
    listCommands: async () => {},
  };

  const coordinator = new ExtensionMutationCoordinator(
    context as unknown as CoordinatorArgs[0],
    pluginCatalogService as unknown as CoordinatorArgs[1],
    emitters,
  );
  return { coordinator, calls };
}

describe("ExtensionMutationCoordinator", () => {
  test("afterSkillMutation re-fetches the remote skill marketplace so uninstalled skills reappear as available", async () => {
    const { coordinator, calls } = makeCoordinator();
    await coordinator.afterSkillMutation();
    expect(calls.emitSkillsCatalog).toBe(1);
    expect(calls.queueRemoteSkillCatalogRefresh).toBe(1);
    // Plugins keep their own remote refresh as before.
    expect(calls.pluginQueueRemoteRefresh).toBe(1);
  });

  test("afterPluginMutation does not trigger an extra skill marketplace fetch", async () => {
    const { coordinator, calls } = makeCoordinator();
    await coordinator.afterPluginMutation();
    // Plugin mutations refresh the plugin marketplace but must not fetch the skill
    // marketplace (keeps plugin-only refresh timing unchanged).
    expect(calls.queueRemoteSkillCatalogRefresh).toBe(0);
    expect(calls.pluginQueueRemoteRefresh).toBe(1);
  });
});
