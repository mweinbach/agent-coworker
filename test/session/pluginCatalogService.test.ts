import { describe, expect, mock, test } from "bun:test";

import type { SessionEvent } from "../../src/server/protocol";
import {
  PluginCatalogService,
  type PluginCatalogServiceDeps,
} from "../../src/server/session/PluginCatalogService";
import type { SessionContext } from "../../src/server/session/SessionContext";
import type {
  AgentConfig,
  InstalledPluginCatalogEntry,
  MarketplacePluginCatalogEntry,
  PluginCatalogSnapshot,
} from "../../src/types";

function makeConfig(): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: "/tmp/project",
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: "/tmp/project/.cowork",
    userCoworkDir: "/tmp/.cowork",
    builtInDir: "/tmp/project",
    builtInConfigDir: "/tmp/project/config",
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

function emptyCatalog(
  overrides: Partial<PluginCatalogSnapshot> & { remoteMarketplaceFailed?: boolean } = {},
): PluginCatalogSnapshot & { remoteMarketplaceFailed?: boolean } {
  const { remoteMarketplaceFailed, ...snapshot } = overrides;
  return {
    plugins: [],
    availablePlugins: [],
    warnings: [],
    ...snapshot,
    ...(remoteMarketplaceFailed ? { remoteMarketplaceFailed: true } : {}),
  };
}

function installedPlugin(
  overrides: Partial<InstalledPluginCatalogEntry> &
    Pick<InstalledPluginCatalogEntry, "id" | "scope">,
): InstalledPluginCatalogEntry {
  return {
    name: overrides.id,
    displayName: overrides.id,
    description: "",
    discoveryKind: "direct",
    installed: true,
    enabled: true,
    rootDir: `/plugins/${overrides.id}`,
    manifestPath: `/plugins/${overrides.id}/plugin.json`,
    skillsPath: `/plugins/${overrides.id}/skills`,
    skills: [],
    mcpServers: [],
    apps: [],
    warnings: [],
    ...overrides,
  };
}

function marketplacePlugin(id: string): MarketplacePluginCatalogEntry {
  return {
    id,
    name: id,
    displayName: id,
    description: `Available from marketplace.`,
    scope: "user",
    discoveryKind: "marketplace",
    installed: false,
    enabled: false,
    installSource: `https://github.com/example/plugins/tree/main/${id}`,
    warnings: [],
  };
}

function makeContext(): {
  context: SessionContext;
  events: SessionEvent[];
  errors: Array<{ code: string; source: string; message: string }>;
} {
  const events: SessionEvent[] = [];
  const errors: Array<{ code: string; source: string; message: string }> = [];
  const context = {
    id: "session-1",
    state: {
      config: makeConfig(),
    },
    emit: (evt: SessionEvent) => {
      events.push(evt);
    },
    emitError: (code: string, source: string, message: string) => {
      errors.push({ code, source, message });
    },
  } as unknown as SessionContext;
  return { context, events, errors };
}

function makeService(
  context: SessionContext,
  deps: PluginCatalogServiceDeps = {},
): PluginCatalogService {
  return new PluginCatalogService(context, globalThis.fetch, deps);
}

describe("PluginCatalogService", () => {
  test("local emit marks availablePluginsPartial so clients keep cached marketplace rows", async () => {
    const { context, events } = makeContext();
    const buildPluginCatalogSnapshot = mock(async () =>
      emptyCatalog({ availablePlugins: [marketplacePlugin("remote-only")] }),
    );
    const service = makeService(context, { buildPluginCatalogSnapshot });

    await service.emitCatalog(["pending:1"]);

    expect(buildPluginCatalogSnapshot).toHaveBeenCalledWith(
      context.state.config,
      expect.objectContaining({ includeRemoteMarketplace: false }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "plugins_catalog",
        sessionId: "session-1",
        availablePluginsPartial: true,
        clearedMutationPendingKeys: ["pending:1"],
      }),
    ]);
  });

  test("successful remote emit omits availablePluginsPartial", async () => {
    const { context, events } = makeContext();
    const buildPluginCatalogSnapshot = mock(async () =>
      emptyCatalog({ availablePlugins: [marketplacePlugin("remote-only")] }),
    );
    const service = makeService(context, { buildPluginCatalogSnapshot });

    await service.emitCatalog([], { includeRemoteMarketplace: true });

    const catalogEvt = events.find((event) => event.type === "plugins_catalog");
    expect(catalogEvt).toBeDefined();
    expect(catalogEvt).not.toHaveProperty("availablePluginsPartial");
  });

  test("failed remote marketplace fetch still marks the catalog partial", async () => {
    const { context, events } = makeContext();
    const buildPluginCatalogSnapshot = mock(async () =>
      emptyCatalog({ remoteMarketplaceFailed: true }),
    );
    const service = makeService(context, { buildPluginCatalogSnapshot });

    await service.emitCatalog([], { includeRemoteMarketplace: true });

    expect(events).toEqual([
      expect.objectContaining({
        type: "plugins_catalog",
        availablePluginsPartial: true,
      }),
    ]);
  });

  test("onlyIfEpoch skips emit after invalidateRemoteCatalogRefreshes", async () => {
    const { context, events } = makeContext();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const buildPluginCatalogSnapshot = mock(async () => {
      started.resolve();
      await release.promise;
      return emptyCatalog({ availablePlugins: [marketplacePlugin("stale")] });
    });
    const service = makeService(context, { buildPluginCatalogSnapshot });

    const pending = service.emitCatalog([], {
      includeRemoteMarketplace: true,
      onlyIfEpoch: 0,
    });
    await started.promise;
    service.invalidateRemoteCatalogRefreshes();
    release.resolve();
    await pending;

    expect(events).toEqual([]);
  });

  test("queueRemoteCatalogRefresh classifies build failures as internal_error", async () => {
    const { context, events, errors } = makeContext();
    const buildPluginCatalogSnapshot = mock(async () => {
      throw new Error("catalog boom");
    });
    const service = makeService(context, { buildPluginCatalogSnapshot });

    service.queueRemoteCatalogRefresh();
    await service.waitForRemoteCatalogRefresh();

    expect(events.filter((event) => event.type === "plugins_catalog")).toEqual([]);
    expect(errors).toEqual([
      {
        code: "internal_error",
        source: "session",
        message: "Failed to refresh remote plugin catalog: Error: catalog boom",
      },
    ]);
  });

  test("invalidate during an in-flight remote refresh queues a follow-up refresh", async () => {
    const { context, events } = makeContext();
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let calls = 0;
    const buildPluginCatalogSnapshot = mock(async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return emptyCatalog({ availablePlugins: [marketplacePlugin("stale")] });
      }
      return emptyCatalog({ availablePlugins: [marketplacePlugin("fresh")] });
    });
    const service = makeService(context, { buildPluginCatalogSnapshot });

    service.queueRemoteCatalogRefresh();
    await firstStarted.promise;
    service.invalidateRemoteCatalogRefreshes();
    // Same-epoch overlap stays coalesced; only an epoch mismatch queues a redo.
    service.queueRemoteCatalogRefresh();
    releaseFirst.resolve();
    await service.waitForRemoteCatalogRefresh();

    expect(calls).toBe(2);
    const catalogs = events.filter((event) => event.type === "plugins_catalog");
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]).toMatchObject({
      type: "plugins_catalog",
      catalog: {
        availablePlugins: [expect.objectContaining({ id: "fresh" })],
      },
    });
    expect(catalogs[0]).not.toHaveProperty("availablePluginsPartial");
  });

  test("resolveInstalledPluginSelection emits validation_failed for missing and ambiguous plugins", () => {
    const { context, errors } = makeContext();
    const service = makeService(context);
    const catalog: PluginCatalogSnapshot = {
      plugins: [
        installedPlugin({ id: "dup", scope: "workspace" }),
        installedPlugin({ id: "dup", scope: "user" }),
      ],
      availablePlugins: [],
      warnings: [],
    };

    expect(service.resolveInstalledPluginSelection(catalog, "missing")).toBeNull();
    expect(service.resolveInstalledPluginSelection(catalog, "dup")).toBeNull();
    expect(errors.map((error) => error.message)).toEqual([
      'Plugin "missing" was not found.',
      'Plugin "dup" exists in multiple scopes. Specify whether you want the workspace or user copy.',
    ]);
  });

  test("emitPluginDetail fails closed for workspace-scoped misses without remote lookup", async () => {
    const { context, events, errors } = makeContext();
    const buildRemoteMarketplacePluginDetail = mock(async () => marketplacePlugin("remote"));
    const buildPluginCatalogSnapshot = mock(async () => emptyCatalog());
    const service = makeService(context, {
      buildPluginCatalogSnapshot,
      buildRemoteMarketplacePluginDetail,
    });

    await service.emitPluginDetail("missing", "workspace");

    expect(buildRemoteMarketplacePluginDetail).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "plugin_detail")).toEqual([]);
    expect(errors).toEqual([
      {
        code: "validation_failed",
        source: "session",
        message: 'Plugin "missing" was not found in the workspace scope.',
      },
    ]);
  });

  test("emitPluginDetail falls back to remote marketplace detail when local catalog misses", async () => {
    const { context, events, errors } = makeContext();
    const remote = marketplacePlugin("remote-plugin");
    const buildPluginCatalogSnapshot = mock(async () => emptyCatalog());
    const buildRemoteMarketplacePluginDetail = mock(async () => remote);
    const service = makeService(context, {
      buildPluginCatalogSnapshot,
      buildRemoteMarketplacePluginDetail,
    });

    await service.emitPluginDetail("remote-plugin");

    expect(errors).toEqual([]);
    expect(events).toEqual([
      {
        type: "plugin_detail",
        sessionId: "session-1",
        plugin: remote,
      },
    ]);
  });

  test("emitPluginDetail reports not-found when local and remote lookups both miss", async () => {
    const { context, events, errors } = makeContext();
    const service = makeService(context, {
      buildPluginCatalogSnapshot: mock(async () => emptyCatalog()),
      buildRemoteMarketplacePluginDetail: mock(async () => null),
    });

    await service.emitPluginDetail("ghost");

    expect(events.filter((event) => event.type === "plugin_detail")).toEqual([]);
    expect(errors).toEqual([
      {
        code: "validation_failed",
        source: "session",
        message: 'Plugin "ghost" was not found.',
      },
    ]);
  });
});
