import type { PluginCatalogService } from "./PluginCatalogService";
import type { SessionContext } from "./SessionContext";

type ExtensionMutationOptions = {
  clearedMutationPendingKeys?: string[];
  refreshAllWorkspaces?: boolean;
};

type SkillMutationOptions = ExtensionMutationOptions & {
  selectedInstallationId?: string;
};

type ExtensionMutationEmitters = {
  emitLegacySkillsList: () => Promise<void>;
  emitSkillsCatalog: (clearedMutationPendingKeys?: string[]) => Promise<void>;
  queueRemoteSkillCatalogRefresh: () => void;
  emitSkillInstallationDetail: (installationId: string) => Promise<void>;
  listCommands: () => Promise<void>;
};

export class ExtensionMutationCoordinator {
  constructor(
    private readonly context: SessionContext,
    private readonly pluginCatalogService: PluginCatalogService,
    private readonly emitters: ExtensionMutationEmitters,
  ) {}

  async afterSkillMutation({
    selectedInstallationId,
    clearedMutationPendingKeys = [],
    refreshAllWorkspaces = false,
  }: SkillMutationOptions = {}): Promise<void> {
    await this.refreshExtensionSurfaces({
      clearedMutationPendingKeys,
      refreshAllWorkspaces,
    });
    // Re-fetch the remote skill marketplace so a skill uninstalled/installed here
    // reappears (or drops) under "available" without a manual refresh. Scoped to
    // skill mutations so plugin mutations don't trigger an extra marketplace fetch.
    this.emitters.queueRemoteSkillCatalogRefresh();
    if (selectedInstallationId) {
      await this.emitters.emitSkillInstallationDetail(selectedInstallationId);
    }
  }

  async afterPluginMutation({
    clearedMutationPendingKeys = [],
    refreshAllWorkspaces = false,
  }: ExtensionMutationOptions = {}): Promise<void> {
    await this.refreshExtensionSurfaces({
      clearedMutationPendingKeys,
      refreshAllWorkspaces,
    });
  }

  private async refreshExtensionSurfaces({
    clearedMutationPendingKeys,
    refreshAllWorkspaces,
  }: Required<ExtensionMutationOptions>): Promise<void> {
    this.pluginCatalogService.invalidateRemoteCatalogRefreshes();
    await this.context.refreshSkillsAcrossWorkspaceSessions({
      allWorkspaces: refreshAllWorkspaces,
    });
    await this.emitters.emitLegacySkillsList();
    await this.emitters.listCommands();
    await this.emitters.emitSkillsCatalog(clearedMutationPendingKeys);
    await this.pluginCatalogService.emitCatalog(clearedMutationPendingKeys);
    this.pluginCatalogService.queueRemoteCatalogRefresh();
    await this.context.emitMcpServers?.();
  }
}
