import type { FetchLike } from "../../extensions/source";
import {
  buildPluginCatalogSnapshot,
  buildRemoteMarketplacePluginDetail,
  resolvePluginCatalogEntry,
} from "../../plugins";
import type {
  InstalledPluginCatalogEntry,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginScope,
} from "../../types";
import type { SessionContext } from "./SessionContext";

export class PluginCatalogService {
  private remoteCatalogRefresh: Promise<void> | null = null;
  private remoteCatalogRefreshEpoch: number | null = null;
  private remoteCatalogRefreshQueued = false;
  private catalogEpoch = 0;

  constructor(
    private readonly context: SessionContext,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  invalidateRemoteCatalogRefreshes() {
    this.catalogEpoch += 1;
  }

  async emitCatalog(
    clearedMutationPendingKeys: string[] = [],
    opts: { includeRemoteMarketplace?: boolean; onlyIfEpoch?: number } = {},
  ) {
    const { remoteMarketplaceFailed, ...catalog } = await buildPluginCatalogSnapshot(
      this.context.state.config,
      {
        includeRemoteMarketplace: opts.includeRemoteMarketplace ?? false,
        fetchImpl: this.fetchImpl,
      },
    );
    if (opts.onlyIfEpoch !== undefined && opts.onlyIfEpoch !== this.catalogEpoch) {
      return;
    }
    // The available (marketplace) plugins are authoritative only when a remote
    // refresh actually succeeded. A local-only refresh, or a remote refresh whose
    // fetch failed, is partial — the client must keep its cached marketplace rows
    // rather than clear them from an empty list.
    const availablePluginsPartial =
      !opts.includeRemoteMarketplace || remoteMarketplaceFailed === true;
    this.context.emit({
      type: "plugins_catalog",
      sessionId: this.context.id,
      catalog,
      ...(availablePluginsPartial ? { availablePluginsPartial: true } : {}),
      ...(clearedMutationPendingKeys.length > 0 ? { clearedMutationPendingKeys } : {}),
    });
  }

  queueRemoteCatalogRefresh() {
    if (this.remoteCatalogRefresh) {
      if (this.remoteCatalogRefreshEpoch !== this.catalogEpoch) {
        this.remoteCatalogRefreshQueued = true;
      }
      return;
    }
    const epoch = this.catalogEpoch;
    this.remoteCatalogRefreshEpoch = epoch;
    const refresh = this.emitCatalog([], {
      includeRemoteMarketplace: true,
      onlyIfEpoch: epoch,
    })
      .catch((err) => {
        this.context.emitError(
          "internal_error",
          "session",
          `Failed to refresh remote plugin catalog: ${String(err)}`,
        );
      })
      .finally(() => {
        this.remoteCatalogRefresh = null;
        this.remoteCatalogRefreshEpoch = null;
        if (this.remoteCatalogRefreshQueued) {
          this.remoteCatalogRefreshQueued = false;
          this.queueRemoteCatalogRefresh();
        }
      });
    this.remoteCatalogRefresh = refresh;
  }

  resolveInstalledPluginSelection(
    catalog: PluginCatalogSnapshot,
    pluginId: string,
    scope?: PluginScope,
  ): InstalledPluginCatalogEntry | null {
    const resolved = resolvePluginCatalogEntry({ catalog, pluginId, scope });
    if (resolved.error) {
      this.context.emitError("validation_failed", "session", resolved.error);
      return null;
    }
    return resolved.plugin;
  }

  async emitPluginDetail(pluginId: string, scope?: PluginScope) {
    const localCatalog = await buildPluginCatalogSnapshot(this.context.state.config, {
      includeRemoteMarketplace: true,
      fetchImpl: this.fetchImpl,
    });
    const localMatches = localCatalog.plugins.filter(
      (entry) => entry.id === pluginId && (scope === undefined || entry.scope === scope),
    );
    let plugin: PluginCatalogEntry | null = null;
    if (localMatches.length === 1) {
      plugin = localMatches[0] ?? null;
    } else if (localMatches.length > 1) {
      this.resolveInstalledPluginSelection(localCatalog, pluginId, scope);
      return;
    } else if (scope === "workspace") {
      this.resolveInstalledPluginSelection(localCatalog, pluginId, scope);
      return;
    } else {
      plugin = await buildRemoteMarketplacePluginDetail({
        config: this.context.state.config,
        pluginId,
        fetchImpl: this.fetchImpl,
      });
      if (plugin === null) {
        this.resolveInstalledPluginSelection(localCatalog, pluginId, scope);
        return;
      }
    }
    this.context.emit({
      type: "plugin_detail",
      sessionId: this.context.id,
      plugin,
    });
  }
}
