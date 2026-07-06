import fs from "node:fs/promises";
import {
  type ImportableKind,
  type ImportSource,
  importPlugin as importPluginFromSource,
  importSkill as importSkillFromSource,
  listImportable,
} from "../../import";
import {
  buildPluginCatalogSnapshot,
  buildPluginInstallPreview,
  checkPluginInstallationUpdate,
  deletePluginInstallation,
  installPluginsFromSource,
  updatePluginInstallation,
} from "../../plugins";
import { buildMarketplaceDetail } from "../../plugins/marketplaceDetail";
import {
  addMarketplace as addMarketplaceToRegistry,
  buildMarketplaceListEntries,
  removeMarketplace as removeMarketplaceFromRegistry,
} from "../../plugins/marketplaceRegistry";
import { setPluginEnabled } from "../../plugins/overrides";
import { discoverSkillsForConfig, stripSkillFrontMatter } from "../../skills";
import { getEffectiveInstallationByName } from "../../skills/catalog";
import {
  checkSkillInstallationUpdate,
  copySkillInstallationToScope,
  deleteSkillInstallation,
  disableSkillInstallation,
  enableSkillInstallation,
  getSkillCatalog,
  getSkillInstallationById,
  installSkillsFromSource,
  updateSkillInstallation,
} from "../../skills/operations";
import { buildSkillInstallPreview } from "../../skills/sourceResolver";
import { captureProductEvent } from "../../telemetry/productAnalytics";
import { createTools, filterToolsForCodexDynamicBoundary } from "../../tools";
import type {
  PluginCatalogEntry,
  PluginInstallTargetScope,
  SkillInstallationEntry,
  SkillMutationTargetScope,
} from "../../types";
import {
  expandCommandTemplate,
  listCommands as listServerCommands,
  resolveCommand,
} from "../commands";
import { ExtensionMutationCoordinator } from "./ExtensionMutationCoordinator";
import { PluginCatalogService } from "./PluginCatalogService";
import type { SessionContext } from "./SessionContext";

export class SkillManager {
  private readonly pluginCatalogService: PluginCatalogService;
  private readonly mutationCoordinator: ExtensionMutationCoordinator;

  constructor(
    private readonly context: SessionContext,
    private readonly handlers: {
      sendUserMessage: (
        text: string,
        clientMessageId?: string,
        displayText?: string,
        attachments?: import("../jsonrpc/routes/shared").FileAttachment[],
      ) => Promise<void>;
    },
  ) {
    this.pluginCatalogService = new PluginCatalogService(context);
    this.mutationCoordinator = new ExtensionMutationCoordinator(
      context,
      this.pluginCatalogService,
      {
        emitLegacySkillsList: async () => await this.emitLegacySkillsList(),
        emitSkillsCatalog: async (clearedMutationPendingKeys) =>
          await this.emitSkillsCatalog(clearedMutationPendingKeys),
        emitSkillInstallationDetail: async (installationId) =>
          await this.emitInstallationDetail(installationId),
        listCommands: async () => await this.listCommands(),
      },
    );
  }

  private skillMutationPendingKey(action: string, id?: string): string {
    return id ? `${action}:${id}` : action;
  }

  private get mutationBlockReason(): string | null {
    return this.context.getSkillMutationBlockReason();
  }

  private async emitLegacySkillsList() {
    const skills = await discoverSkillsForConfig(this.context.state.config, {
      includeDisabled: true,
    });
    this.context.state.discoveredSkills = skills
      .filter((skill) => skill.enabled)
      .map((skill) => ({ name: skill.name, description: skill.description }));
    this.context.emit({ type: "skills_list", sessionId: this.context.id, skills });
  }

  private async emitSkillsCatalog(
    clearedMutationPendingKeys: string[] = [],
    opts: { includeRemoteMarketplace?: boolean } = {},
  ) {
    const { remoteMarketplaceFailed, ...catalog } = await getSkillCatalog(
      this.context.state.config,
      { includeRemoteMarketplace: opts.includeRemoteMarketplace ?? false },
    );
    // Available (marketplace) skills are authoritative only when a remote refresh
    // succeeded; otherwise the client must keep its cached marketplace rows.
    const availableSkillsPartial =
      !opts.includeRemoteMarketplace || remoteMarketplaceFailed === true;
    const mutationBlockedReason = this.mutationBlockReason;
    this.context.emit({
      type: "skills_catalog",
      sessionId: this.context.id,
      catalog,
      mutationBlocked: mutationBlockedReason !== null,
      ...(availableSkillsPartial ? { availableSkillsPartial: true } : {}),
      ...(clearedMutationPendingKeys.length > 0 ? { clearedMutationPendingKeys } : {}),
      ...(mutationBlockedReason ? { mutationBlockedReason } : {}),
    });
  }

  private async emitPluginInstallPreview(
    preview: import("../../types").PluginInstallPreview,
    fromUserPreviewRequest: boolean,
  ) {
    this.context.emit({
      type: "plugin_install_preview",
      sessionId: this.context.id,
      preview,
      fromUserPreviewRequest,
    });
  }

  private pluginMutationPendingKey(
    action: string,
    plugin: Pick<PluginCatalogEntry, "id" | "scope">,
  ): string {
    return this.skillMutationPendingKey(`plugin:${action}`, `${plugin.scope}:${plugin.id}`);
  }

  private async readInstallationContent(
    installation: SkillInstallationEntry,
  ): Promise<string | null> {
    if (!installation.skillPath) {
      return null;
    }
    const content = await fs.readFile(installation.skillPath, "utf-8");
    return stripSkillFrontMatter(content);
  }

  private async emitInstallationDetail(installationId: string) {
    const installation = await getSkillInstallationById({
      config: this.context.state.config,
      installationId,
    });
    if (!installation) {
      this.context.emit({
        type: "skill_installation",
        sessionId: this.context.id,
        installation: null,
        content: null,
      });
      return;
    }

    const content = installation.skillPath
      ? await this.readInstallationContent(installation)
      : null;
    this.context.emit({
      type: "skill_installation",
      sessionId: this.context.id,
      installation,
      content,
    });
  }

  private async withSkillMutationLock<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }
    const reason = this.mutationBlockReason;
    if (reason) {
      this.context.emitError("busy", "session", reason);
      return;
    }
    return await task();
  }

  private isSharedSkillMutationScope(
    scope: SkillMutationTargetScope | SkillInstallationEntry["scope"],
  ): boolean {
    return scope === "global" || scope === "user";
  }

  private isSharedPluginMutationScope(
    scope: PluginInstallTargetScope | PluginCatalogEntry["scope"],
  ): boolean {
    return scope === "user";
  }

  listTools() {
    const toolMap = createTools({
      config: this.context.state.config,
      log: () => {},
      askUser: async () => "",
      approveCommand: async () => false,
      shellPolicy: "full",
    });

    const effectiveToolMap =
      this.context.state.config.provider === "codex-cli"
        ? filterToolsForCodexDynamicBoundary(toolMap)
        : toolMap;

    const tools = Object.entries(effectiveToolMap)
      .map(([name, def]) => {
        const raw = typeof def?.description === "string" ? def.description : "";
        const description = raw.split("\n")[0] || name;
        return { name, description };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    this.context.emit({ type: "tools", sessionId: this.context.id, tools });
  }

  async listCommands() {
    try {
      const commands = await listServerCommands(this.context.state.config);
      this.context.emit({ type: "commands", sessionId: this.context.id, commands });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to list commands: ${String(err)}`,
      );
    }
  }

  async executeCommand(nameRaw: string, argumentsText = "", clientMessageId?: string) {
    const name = nameRaw.trim();
    if (!name) {
      this.context.emitError("validation_failed", "session", "Command name is required");
      return;
    }

    const resolved = await resolveCommand(this.context.state.config, name);
    if (!resolved) {
      this.context.emitError("validation_failed", "session", `Unknown command: ${name}`);
      return;
    }

    const expanded = expandCommandTemplate(resolved.template, argumentsText);
    if (!expanded.trim()) {
      this.context.emitError(
        "validation_failed",
        "session",
        `Command "${name}" expanded to empty prompt`,
      );
      return;
    }

    const trimmedArgs = argumentsText.trim();
    const slashText = `/${resolved.name}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
    await this.handlers.sendUserMessage(expanded, clientMessageId, slashText);
  }

  async listSkills() {
    try {
      await this.emitLegacySkillsList();
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list skills: ${String(err)}`);
    }
  }

  async readSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }

    try {
      const skills = await discoverSkillsForConfig(this.context.state.config, {
        includeDisabled: true,
      });
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
        return;
      }

      const content = await fs.readFile(skill.path, "utf-8");
      this.context.emit({
        type: "skill_content",
        sessionId: this.context.id,
        skill,
        content: stripSkillFrontMatter(content),
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to read skill: ${String(err)}`);
    }
  }

  async disableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await getSkillCatalog(this.context.state.config);
        const installation =
          catalog.installations.find((entry) => entry.name === skillName && entry.enabled) ??
          catalog.installations.find((entry) => entry.name === skillName);
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
          return;
        }
        if (!installation.writable) {
          this.context.emitError(
            "validation_failed",
            "session",
            "Only workspace or global skills can be disabled directly.",
          );
          return;
        }
        const nextCatalog = await disableSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        const nextInstallation =
          getEffectiveInstallationByName(nextCatalog, installation.name) ??
          nextCatalog.installations.find((entry) => entry.name === installation.name) ??
          null;
        await this.mutationCoordinator.afterSkillMutation({
          selectedInstallationId: nextInstallation?.installationId,
          refreshAllWorkspaces: this.isSharedSkillMutationScope(installation.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to disable skill: ${String(err)}`,
        );
      }
    });
  }

  async enableSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await getSkillCatalog(this.context.state.config);
        const installation =
          catalog.installations.find((entry) => entry.name === skillName && !entry.enabled) ??
          catalog.installations.find((entry) => entry.name === skillName);
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
          return;
        }
        if (!installation.writable) {
          this.context.emitError(
            "validation_failed",
            "session",
            "Only workspace or global skills can be enabled directly.",
          );
          return;
        }
        const nextCatalog = await enableSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        const nextInstallation =
          getEffectiveInstallationByName(nextCatalog, installation.name) ??
          nextCatalog.installations.find((entry) => entry.name === installation.name) ??
          null;
        await this.mutationCoordinator.afterSkillMutation({
          selectedInstallationId: nextInstallation?.installationId,
          refreshAllWorkspaces: this.isSharedSkillMutationScope(installation.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to enable skill: ${String(err)}`,
        );
      }
    });
  }

  async deleteSkill(skillNameRaw: string) {
    const skillName = skillNameRaw.trim();
    if (!skillName) {
      this.context.emitError("validation_failed", "session", "Skill name is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await getSkillCatalog(this.context.state.config);
        const installation = catalog.installations.find((entry) => entry.name === skillName);
        if (!installation) {
          this.context.emitError("validation_failed", "session", `Skill "${skillName}" not found.`);
          return;
        }
        if (!installation.writable) {
          this.context.emitError(
            "validation_failed",
            "session",
            "Only workspace or global skills can be deleted directly.",
          );
          return;
        }
        await deleteSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        await this.mutationCoordinator.afterSkillMutation({
          refreshAllWorkspaces: this.isSharedSkillMutationScope(installation.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to delete skill: ${String(err)}`,
        );
      }
    });
  }

  async getSkillsCatalog() {
    try {
      // Emit a single marketplace-inclusive catalog. The workspace-control read/refresh
      // path captures one synchronous skills_catalog emit per operation and disposes the
      // binding, so availableSkills must be present in that emit — an async queued refresh
      // would never reach the client.
      await this.emitSkillsCatalog([], { includeRemoteMarketplace: true });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to get skill catalog: ${String(err)}`,
      );
    }
  }

  async getPluginsCatalog() {
    try {
      await this.pluginCatalogService.emitCatalog();
      this.pluginCatalogService.queueRemoteCatalogRefresh();
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to get plugin catalog: ${String(err)}`,
      );
    }
  }

  private async emitMarketplacesList() {
    const marketplaces = await buildMarketplaceListEntries({
      config: this.context.state.config,
    });
    this.context.emit({
      type: "marketplaces_list",
      sessionId: this.context.id,
      marketplaces,
    });
  }

  /**
   * Marketplace mutations change which remote catalogs feed availablePlugins /
   * availableSkills, so they trigger the same remote-inclusive catalog refreshes
   * a skill install does and the Marketplace tab updates immediately.
   */
  private async refreshCatalogsAfterMarketplaceMutation(clearedMutationPendingKeys: string[]) {
    this.pluginCatalogService.invalidateRemoteCatalogRefreshes();
    await this.context.refreshSkillsAcrossWorkspaceSessions({ allWorkspaces: true });
    await this.emitSkillsCatalog(clearedMutationPendingKeys, { includeRemoteMarketplace: true });
    await this.pluginCatalogService.emitCatalog(clearedMutationPendingKeys, {
      includeRemoteMarketplace: true,
    });
  }

  async listMarketplaces() {
    try {
      await this.emitMarketplacesList();
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to list marketplaces: ${String(err)}`,
      );
    }
  }

  async readMarketplaceDetail(marketplaceIdRaw: string) {
    const marketplaceId = marketplaceIdRaw.trim();
    if (!marketplaceId) {
      this.context.emitError("validation_failed", "session", "Marketplace ID is required");
      return;
    }
    try {
      const detail = await buildMarketplaceDetail({
        config: this.context.state.config,
        id: marketplaceId,
      });
      this.context.emit({
        type: "marketplace_detail",
        sessionId: this.context.id,
        detail,
      });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to read marketplace: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async addMarketplace(sourceInput: string) {
    const normalizedSourceInput = sourceInput.trim();
    if (!normalizedSourceInput) {
      this.context.emitError("validation_failed", "session", "Marketplace source is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        await addMarketplaceToRegistry({
          config: this.context.state.config,
          sourceInput: normalizedSourceInput,
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to add marketplace: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      await this.emitMarketplacesList();
      await this.refreshCatalogsAfterMarketplaceMutation([
        this.skillMutationPendingKey("marketplace:add"),
      ]);
    });
  }

  async removeMarketplace(marketplaceIdRaw: string) {
    const marketplaceId = marketplaceIdRaw.trim();
    if (!marketplaceId) {
      this.context.emitError("validation_failed", "session", "Marketplace ID is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        await removeMarketplaceFromRegistry({
          config: this.context.state.config,
          id: marketplaceId,
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to remove marketplace: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      await this.emitMarketplacesList();
      await this.refreshCatalogsAfterMarketplaceMutation([
        this.skillMutationPendingKey("marketplace:remove", marketplaceId),
      ]);
    });
  }

  async getPlugin(pluginIdRaw: string, scope?: PluginCatalogEntry["scope"]) {
    const pluginId = pluginIdRaw.trim();
    if (!pluginId) {
      this.context.emitError("validation_failed", "session", "Plugin ID is required");
      return;
    }
    try {
      await this.pluginCatalogService.emitPluginDetail(pluginId, scope);
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to read plugin detail: ${String(err)}`,
      );
    }
  }

  async previewPluginInstall(sourceInput: string, targetScope: PluginInstallTargetScope) {
    try {
      const preview = await buildPluginInstallPreview({
        input: sourceInput,
        targetScope,
        catalog: await buildPluginCatalogSnapshot(this.context.state.config),
        cwd: this.context.state.config.workingDirectory,
      });
      await this.emitPluginInstallPreview(preview, true);
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to preview plugin install: ${String(err)}`,
      );
    }
  }

  async installPlugins(sourceInput: string, targetScope: PluginInstallTargetScope) {
    await this.withSkillMutationLock(async () => {
      try {
        const result = await installPluginsFromSource({
          config: this.context.state.config,
          input: sourceInput,
          targetScope,
        });
        await this.emitPluginInstallPreview(result.preview, false);
        await this.mutationCoordinator.afterPluginMutation({
          clearedMutationPendingKeys: [
            this.skillMutationPendingKey(`plugin:install:${targetScope}`),
          ],
          refreshAllWorkspaces: this.isSharedPluginMutationScope(targetScope),
        });
        captureProductEvent("plugin_installed", {
          eventSource: "server",
          status: targetScope,
          pluginCount: 1,
        });
        await this.pluginCatalogService.emitPluginDetail(result.pluginId, targetScope);
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to install plugins: ${String(err)}`,
        );
      }
    });
  }

  async enablePlugin(pluginIdRaw: string, scope?: PluginCatalogEntry["scope"]) {
    const pluginId = pluginIdRaw.trim();
    if (!pluginId) {
      this.context.emitError("validation_failed", "session", "Plugin ID is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await buildPluginCatalogSnapshot(this.context.state.config);
        const plugin = this.pluginCatalogService.resolveInstalledPluginSelection(
          catalog,
          pluginId,
          scope,
        );
        if (!plugin) {
          return;
        }
        await setPluginEnabled({
          config: this.context.state.config,
          pluginId: plugin.id,
          scope: plugin.scope,
          enabled: true,
        });
        await this.mutationCoordinator.afterPluginMutation({
          clearedMutationPendingKeys: [this.pluginMutationPendingKey("enable", plugin)],
          refreshAllWorkspaces: this.isSharedPluginMutationScope(plugin.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to enable plugin: ${String(err)}`,
        );
      }
    });
  }

  async disablePlugin(pluginIdRaw: string, scope?: PluginCatalogEntry["scope"]) {
    const pluginId = pluginIdRaw.trim();
    if (!pluginId) {
      this.context.emitError("validation_failed", "session", "Plugin ID is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await buildPluginCatalogSnapshot(this.context.state.config);
        const plugin = this.pluginCatalogService.resolveInstalledPluginSelection(
          catalog,
          pluginId,
          scope,
        );
        if (!plugin) {
          return;
        }
        await setPluginEnabled({
          config: this.context.state.config,
          pluginId: plugin.id,
          scope: plugin.scope,
          enabled: false,
        });
        await this.mutationCoordinator.afterPluginMutation({
          clearedMutationPendingKeys: [this.pluginMutationPendingKey("disable", plugin)],
          refreshAllWorkspaces: this.isSharedPluginMutationScope(plugin.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to disable plugin: ${String(err)}`,
        );
      }
    });
  }

  async deletePlugin(pluginIdRaw: string, scope?: PluginCatalogEntry["scope"]) {
    const pluginId = pluginIdRaw.trim();
    if (!pluginId) {
      this.context.emitError("validation_failed", "session", "Plugin ID is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await buildPluginCatalogSnapshot(this.context.state.config);
        const plugin = this.pluginCatalogService.resolveInstalledPluginSelection(
          catalog,
          pluginId,
          scope,
        );
        if (!plugin) {
          return;
        }
        await deletePluginInstallation({
          config: this.context.state.config,
          plugin,
        });
        await this.mutationCoordinator.afterPluginMutation({
          clearedMutationPendingKeys: [this.pluginMutationPendingKey("delete", plugin)],
          refreshAllWorkspaces: this.isSharedPluginMutationScope(plugin.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to delete plugin: ${String(err)}`,
        );
      }
    });
  }

  async checkPluginUpdate(pluginIdRaw: string, scope?: PluginCatalogEntry["scope"]) {
    const pluginId = pluginIdRaw.trim();
    if (!pluginId) {
      this.context.emitError("validation_failed", "session", "Plugin ID is required");
      return;
    }
    try {
      const catalog = await buildPluginCatalogSnapshot(this.context.state.config);
      const plugin = this.pluginCatalogService.resolveInstalledPluginSelection(
        catalog,
        pluginId,
        scope,
      );
      if (!plugin) {
        return;
      }
      const result = await checkPluginInstallationUpdate({
        config: this.context.state.config,
        plugin,
      });
      this.context.emit({
        type: "plugin_update_check",
        sessionId: this.context.id,
        result,
      });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to check for plugin update: ${String(err)}`,
      );
    }
  }

  async updatePlugin(pluginIdRaw: string, scope?: PluginCatalogEntry["scope"]) {
    const pluginId = pluginIdRaw.trim();
    if (!pluginId) {
      this.context.emitError("validation_failed", "session", "Plugin ID is required");
      return;
    }
    await this.withSkillMutationLock(async () => {
      try {
        const catalog = await buildPluginCatalogSnapshot(this.context.state.config);
        const plugin = this.pluginCatalogService.resolveInstalledPluginSelection(
          catalog,
          pluginId,
          scope,
        );
        if (!plugin) {
          return;
        }
        const result = await updatePluginInstallation({
          config: this.context.state.config,
          plugin,
        });
        await this.emitPluginInstallPreview(result.preview, false);
        await this.mutationCoordinator.afterPluginMutation({
          clearedMutationPendingKeys: [this.pluginMutationPendingKey("update", plugin)],
          refreshAllWorkspaces: this.isSharedPluginMutationScope(plugin.scope),
        });
        await this.pluginCatalogService.emitPluginDetail(result.pluginId, plugin.scope);
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to update plugin: ${String(err)}`,
        );
      }
    });
  }

  async getSkillInstallation(installationId: string) {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      this.context.emitError("validation_failed", "session", "Installation ID is required");
      return;
    }

    try {
      await this.emitInstallationDetail(normalizedInstallationId);
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to read skill installation: ${String(err)}`,
      );
    }
  }

  async previewSkillInstall(sourceInput: string, targetScope: SkillMutationTargetScope) {
    try {
      const preview = await buildSkillInstallPreview({
        input: sourceInput,
        targetScope,
        catalog: await getSkillCatalog(this.context.state.config),
        cwd: this.context.state.config.workingDirectory,
      });
      this.context.emit({
        type: "skill_install_preview",
        sessionId: this.context.id,
        preview,
        fromUserPreviewRequest: true,
      });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to preview skill install: ${String(err)}`,
      );
    }
  }

  async installSkills(sourceInput: string, targetScope: SkillMutationTargetScope) {
    await this.withSkillMutationLock(async () => {
      try {
        const result = await installSkillsFromSource({
          config: this.context.state.config,
          input: sourceInput,
          targetScope,
        });
        this.context.emit({
          type: "skill_install_preview",
          sessionId: this.context.id,
          preview: result.preview,
          fromUserPreviewRequest: false,
        });
        await this.mutationCoordinator.afterSkillMutation({
          selectedInstallationId: result.installationIds[0],
          clearedMutationPendingKeys: [this.skillMutationPendingKey(`install:${targetScope}`)],
          refreshAllWorkspaces: this.isSharedSkillMutationScope(targetScope),
        });
        captureProductEvent("skill_installed", {
          eventSource: "server",
          status: targetScope,
          skillCount: result.installationIds.length,
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to install skills: ${String(err)}`,
        );
      }
    });
  }

  async listImport(source: ImportSource, kind: ImportableKind) {
    try {
      const result = await listImportable({
        config: this.context.state.config,
        source,
        kind,
      });
      this.context.emit({
        type: "import_list",
        sessionId: this.context.id,
        source: result.source,
        kind: result.kind,
        homeExists: result.homeExists,
        items: result.items,
      });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to list importable ${kind}s: ${String(err)}`,
      );
    }
  }

  async importPlugin(
    sourcePath: string,
    conversionRequired: boolean,
    targetScope: PluginInstallTargetScope,
  ) {
    await this.withSkillMutationLock(async () => {
      try {
        const result = await importPluginFromSource({
          config: this.context.state.config,
          sourcePath,
          conversionRequired,
          targetScope,
        });
        await this.mutationCoordinator.afterPluginMutation({
          clearedMutationPendingKeys: [
            this.skillMutationPendingKey(`plugin:import:${targetScope}`),
          ],
          refreshAllWorkspaces: this.isSharedPluginMutationScope(targetScope),
        });
        captureProductEvent("plugin_installed", {
          eventSource: "server",
          status: targetScope,
          pluginCount: 1,
        });
        await this.pluginCatalogService.emitPluginDetail(result.pluginId, targetScope);
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to import plugin: ${String(err)}`,
        );
      }
    });
  }

  async importSkill(sourcePath: string, targetScope: PluginInstallTargetScope) {
    await this.withSkillMutationLock(async () => {
      try {
        const result = await importSkillFromSource({
          config: this.context.state.config,
          sourcePath,
          targetScope,
        });
        const skillScope: SkillMutationTargetScope = targetScope === "user" ? "global" : "project";
        await this.mutationCoordinator.afterSkillMutation({
          selectedInstallationId: result.installationIds[0],
          clearedMutationPendingKeys: [this.skillMutationPendingKey(`import:${targetScope}`)],
          refreshAllWorkspaces: this.isSharedSkillMutationScope(skillScope),
        });
        captureProductEvent("skill_installed", {
          eventSource: "server",
          status: skillScope,
          skillCount: result.installationIds.length,
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to import skill: ${String(err)}`,
        );
      }
    });
  }

  async enableSkillInstallation(installationId: string) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError(
            "validation_failed",
            "session",
            `Skill installation "${installationId}" was not found`,
          );
          return;
        }
        await enableSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        await this.mutationCoordinator.afterSkillMutation({
          selectedInstallationId: installationId,
          clearedMutationPendingKeys: [this.skillMutationPendingKey("enable", installationId)],
          refreshAllWorkspaces: this.isSharedSkillMutationScope(installation.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to enable skill installation: ${String(err)}`,
        );
      }
    });
  }

  async disableSkillInstallation(installationId: string) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError(
            "validation_failed",
            "session",
            `Skill installation "${installationId}" was not found`,
          );
          return;
        }
        await disableSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        await this.mutationCoordinator.afterSkillMutation({
          selectedInstallationId: installationId,
          clearedMutationPendingKeys: [this.skillMutationPendingKey("disable", installationId)],
          refreshAllWorkspaces: this.isSharedSkillMutationScope(installation.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to disable skill installation: ${String(err)}`,
        );
      }
    });
  }

  async deleteSkillInstallation(installationId: string) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError(
            "validation_failed",
            "session",
            `Skill installation "${installationId}" was not found`,
          );
          return;
        }
        await deleteSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        await this.mutationCoordinator.afterSkillMutation({
          clearedMutationPendingKeys: [this.skillMutationPendingKey("delete", installationId)],
          refreshAllWorkspaces: this.isSharedSkillMutationScope(installation.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to delete skill installation: ${String(err)}`,
        );
      }
    });
  }

  async copySkillInstallation(installationId: string, targetScope: SkillMutationTargetScope) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError(
            "validation_failed",
            "session",
            `Skill installation "${installationId}" was not found`,
          );
          return;
        }
        const result = await copySkillInstallationToScope({
          config: this.context.state.config,
          installation,
          targetScope,
        });
        await this.mutationCoordinator.afterSkillMutation({
          selectedInstallationId: result.installationId,
          clearedMutationPendingKeys: [
            this.skillMutationPendingKey(`copy:${targetScope}`, installationId),
          ],
          refreshAllWorkspaces: this.isSharedSkillMutationScope(targetScope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to copy skill installation: ${String(err)}`,
        );
      }
    });
  }

  async checkSkillInstallationUpdate(installationId: string) {
    try {
      const installation = await getSkillInstallationById({
        config: this.context.state.config,
        installationId,
      });
      if (!installation) {
        this.context.emitError(
          "validation_failed",
          "session",
          `Skill installation "${installationId}" was not found`,
        );
        return;
      }
      const result = await checkSkillInstallationUpdate({
        config: this.context.state.config,
        installation,
      });
      this.context.emit({
        type: "skill_installation_update_check",
        sessionId: this.context.id,
        result,
      });
    } catch (err) {
      this.context.emitError(
        "internal_error",
        "session",
        `Failed to check for skill update: ${String(err)}`,
      );
    }
  }

  async updateSkillInstallation(installationId: string) {
    await this.withSkillMutationLock(async () => {
      try {
        const installation = await getSkillInstallationById({
          config: this.context.state.config,
          installationId,
        });
        if (!installation) {
          this.context.emitError(
            "validation_failed",
            "session",
            `Skill installation "${installationId}" was not found`,
          );
          return;
        }
        const result = await updateSkillInstallation({
          config: this.context.state.config,
          installation,
        });
        this.context.emit({
          type: "skill_install_preview",
          sessionId: this.context.id,
          preview: result.preview,
          fromUserPreviewRequest: false,
        });
        await this.mutationCoordinator.afterSkillMutation({
          selectedInstallationId: installationId,
          clearedMutationPendingKeys: [this.skillMutationPendingKey("update", installationId)],
          refreshAllWorkspaces: this.isSharedSkillMutationScope(installation.scope),
        });
      } catch (err) {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to update skill installation: ${String(err)}`,
        );
      }
    });
  }
}
