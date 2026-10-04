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

const emptyCatalog = (
  overrides: Partial<PluginCatalogSnapshot> & { remoteMarketplaceFailed?: boolean } = {},
): PluginCatalogSnapshot & { remoteMarketplaceFailed?: boolean } => {
  const { remoteMarketplaceFailed, ...snapshot } = overrides;
  return {
    plugins: [],
    availablePlugins: [],
    warnings: [],
    ...snapshot,
    ...(remoteMarketplaceFailed ? { remoteMarketplaceFailed: true } : {}),
  };
};

const installedPlugin = (
  overrides: Partial<InstalledPluginCatalogEntry> &
    Pick<InstalledPluginCatalogEntry, "id" | "scope">,
): InstalledPluginCatalogEntry => ({
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
});

const marketplacePlugin = (id: string): MarketplacePluginCatalogEntry => ({
  id,
  name: id,
  displayName: id,
  description: "Available from marketplace.",
  scope: "user",
  discoveryKind: "marketplace",
  installed: false,
  enabled: false,
  installSource: `https://github.com/example/plugins/tree/main/${id}`,
  warnings: [],
});

function makeHarness(deps: PluginCatalogServiceDeps = {}) {
  const events: SessionEvent[] = [];
  const errors: Array<{ code: string; source: string; message: string }> = [];
  const context = {
    id: "session-1",
    state: {
      config: {
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
      } satisfies AgentConfig,
    },
    emit: (evt: SessionEvent) => events.push(evt),
    emitError: (code: string, source: string, message: string) =>
      errors.push({ code, source, message }),
  } as unknown as SessionContext;
  return {
    context,
    events,
    errors,
    service: new PluginCatalogService(context, globalThis.fetch, deps),
  };
}

describe("PluginCatalogService", () => {
  test("emitCatalog sets availablePluginsPartial only for local or failed remote refreshes", async () => {
    const buildPluginCatalogSnapshot = mock(async () =>
      emptyCatalog({ availablePlugins: [marketplacePlugin("remote-only")] }),
    );
    const local = makeHarness({ buildPluginCatalogSnapshot });
    await local.service.emitCatalog(["pending:1"]);

    expect(buildPluginCatalogSnapshot).toHaveBeenCalledWith(
      local.context.state.config,
      expect.objectContaining({ includeRemoteMarketplace: false }),
    );
    expect(local.events).toEqual([
      expect.objectContaining({
        type: "plugins_catalog",
        sessionId: "session-1",
        availablePluginsPartial: true,
        clearedMutationPendingKeys: ["pending:1"],
      }),
    ]);

    const remoteOk = makeHarness({ buildPluginCatalogSnapshot });
    await remoteOk.service.emitCatalog([], { includeRemoteMarketplace: true });
    expect(remoteOk.events[0]).not.toHaveProperty("availablePluginsPartial");

    const remoteFail = makeHarness({
      buildPluginCatalogSnapshot: mock(async () => emptyCatalog({ remoteMarketplaceFailed: true })),
    });
    await remoteFail.service.emitCatalog([], { includeRemoteMarketplace: true });
    expect(remoteFail.events).toEqual([
      expect.objectContaining({ type: "plugins_catalog", availablePluginsPartial: true }),
    ]);
  });

  test("onlyIfEpoch skips emit after invalidateRemoteCatalogRefreshes", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { service, events } = makeHarness({
      buildPluginCatalogSnapshot: mock(async () => {
        started.resolve();
        await release.promise;
        return emptyCatalog({ availablePlugins: [marketplacePlugin("stale")] });
      }),
    });

    const pending = service.emitCatalog([], { includeRemoteMarketplace: true, onlyIfEpoch: 0 });
    await started.promise;
    service.invalidateRemoteCatalogRefreshes();
    release.resolve();
    await pending;

    expect(events).toEqual([]);
  });

  test("queueRemoteCatalogRefresh classifies build failures as internal_error", async () => {
    const { service, events, errors } = makeHarness({
      buildPluginCatalogSnapshot: mock(async () => {
        throw new Error("catalog boom");
      }),
    });

    service.queueRemoteCatalogRefresh();
    await service.waitForRemoteCatalogRefresh();

    expect(events).toEqual([]);
    expect(errors).toEqual([
      {
        code: "internal_error",
        source: "session",
        message: "Failed to refresh remote plugin catalog: Error: catalog boom",
      },
    ]);
  });

  test("invalidate during an in-flight remote refresh queues a follow-up refresh", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let calls = 0;
    const { service, events } = makeHarness({
      buildPluginCatalogSnapshot: mock(async () => {
        calls += 1;
        if (calls === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          return emptyCatalog({ availablePlugins: [marketplacePlugin("stale")] });
        }
        return emptyCatalog({ availablePlugins: [marketplacePlugin("fresh")] });
      }),
    });

    service.queueRemoteCatalogRefresh();
    await firstStarted.promise;
    service.invalidateRemoteCatalogRefreshes();
    service.queueRemoteCatalogRefresh();
    releaseFirst.resolve();
    await service.waitForRemoteCatalogRefresh();

    expect(calls).toBe(2);
    expect(events).toEqual([
      expect.objectContaining({
        type: "plugins_catalog",
        catalog: {
          plugins: [],
          availablePlugins: [expect.objectContaining({ id: "fresh" })],
          warnings: [],
        },
      }),
    ]);
    expect(events[0]).not.toHaveProperty("availablePluginsPartial");
  });

  test("resolveInstalledPluginSelection emits validation_failed for missing and ambiguous plugins", () => {
    const { service, errors } = makeHarness();
    const catalog = emptyCatalog({
      plugins: [
        installedPlugin({ id: "dup", scope: "workspace" }),
        installedPlugin({ id: "dup", scope: "user" }),
      ],
    });

    expect(service.resolveInstalledPluginSelection(catalog, "missing")).toBeNull();
    expect(service.resolveInstalledPluginSelection(catalog, "dup")).toBeNull();
    expect(errors.map((error) => error.message)).toEqual([
      'Plugin "missing" was not found.',
      'Plugin "dup" exists in multiple scopes. Specify whether you want the workspace or user copy.',
    ]);
  });

  test("emitPluginDetail enforces workspace-scope fail-closed and remote fallback", async () => {
    const remote = marketplacePlugin("remote-plugin");
    const buildRemoteMarketplacePluginDetail = mock(async ({ pluginId }: { pluginId: string }) =>
      pluginId === "remote-plugin" ? remote : null,
    );
    const { service, events, errors } = makeHarness({
      buildPluginCatalogSnapshot: mock(async () => emptyCatalog()),
      buildRemoteMarketplacePluginDetail: buildRemoteMarketplacePluginDetail as never,
    });

    await service.emitPluginDetail("missing", "workspace");
    expect(buildRemoteMarketplacePluginDetail).not.toHaveBeenCalled();

    await service.emitPluginDetail("remote-plugin");
    await service.emitPluginDetail("ghost");

    expect(events).toEqual([{ type: "plugin_detail", sessionId: "session-1", plugin: remote }]);
    expect(errors).toEqual([
      {
        code: "validation_failed",
        source: "session",
        message: 'Plugin "missing" was not found in the workspace scope.',
      },
      {
        code: "validation_failed",
        source: "session",
        message: 'Plugin "ghost" was not found.',
      },
    ]);
  });
});
