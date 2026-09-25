import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { getAiCoworkerPaths } from "../../src/connect";
import { scratchRoots } from "../../src/platform/sandbox";
import {
  type ModelDiscoveryAdapter,
  type ModelDiscoveryResult,
  modelDiscoveryCachePath,
  readModelDiscoveryCache,
  writeModelDiscoveryCache,
} from "../../src/providers/modelDiscoveryCache";
import { discoverProviderModelsWithCache } from "../../src/providers/modelDiscoveryService";
import type { ProviderName } from "../../src/types";

const FRESH_EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const CACHED_UPDATED_AT = "2026-07-01T12:00:00.000Z";

async function tmpPaths(prefix: string) {
  const homedir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", prefix));
  return getAiCoworkerPaths({ homedir });
}

function adapter(opts: {
  provider?: ProviderName;
  source?: ModelDiscoveryResult["source"];
  ttlMs?: number;
  allowEmpty?: boolean;
  scope?: string;
  discover: ModelDiscoveryAdapter["discover"];
}): ModelDiscoveryAdapter {
  return {
    provider: opts.provider ?? "openai",
    source: opts.source ?? "api",
    cache: {
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.allowEmpty !== undefined ? { allowEmpty: opts.allowEmpty } : {}),
    },
    discover: opts.discover,
  };
}

async function seedFreshCache(opts: {
  paths: Awaited<ReturnType<typeof tmpPaths>>;
  provider?: ProviderName;
  source?: ModelDiscoveryResult["source"];
  scope?: string;
  models?: ModelDiscoveryResult["models"];
}) {
  const provider = opts.provider ?? "openai";
  return await writeModelDiscoveryCache(
    opts.paths,
    provider,
    {
      provider,
      source: opts.source ?? "api",
      updatedAt: CACHED_UPDATED_AT,
      expiresAt: FRESH_EXPIRES_AT,
      models: opts.models ?? [{ id: "cached-model", displayName: "Cached Model" }],
    },
    opts.scope !== undefined ? { scope: opts.scope } : {},
  );
}

function hangUntilAbort(): ModelDiscoveryAdapter["discover"] {
  return (opts) =>
    new Promise((_resolve, reject) => {
      const signal = opts.signal;
      if (!signal) {
        reject(new Error("missing timeout signal"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
}

describe("discoverProviderModelsWithCache", () => {
  test("serves a fresh cache without calling discovery", async () => {
    const paths = await tmpPaths("model-discovery-fresh-");
    const cached = await seedFreshCache({ paths });
    const discover = mock(async () => {
      throw new Error("discovery should not run");
    });

    const result = await discoverProviderModelsWithCache({
      paths,
      name: "OpenAI",
      adapter: adapter({ discover }),
    });

    expect(discover).not.toHaveBeenCalled();
    expect(result).toEqual({
      discovery: {
        provider: "openai",
        source: "api",
        updatedAt: cached.updatedAt,
        expiresAt: cached.expiresAt,
        models: cached.models,
      },
      stale: false,
    });
  });

  test("isolates a fresh cache to the adapter scope", async () => {
    const paths = await tmpPaths("model-discovery-scope-");
    const scope = "http://127.0.0.1:1234";
    await seedFreshCache({
      paths,
      provider: "lmstudio",
      source: "local-http",
      scope,
      models: [{ id: "scoped", displayName: "Scoped" }],
    });
    const otherDiscover = mock(
      async (): Promise<ModelDiscoveryResult> => ({
        provider: "lmstudio",
        source: "local-http",
        models: [{ id: "other-endpoint", displayName: "Other Endpoint" }],
      }),
    );
    const sameDiscover = mock(async () => {
      throw new Error("scoped cache should be served");
    });

    const other = await discoverProviderModelsWithCache({
      paths,
      name: "LM Studio",
      adapter: adapter({
        provider: "lmstudio",
        source: "local-http",
        scope: "http://127.0.0.1:5678",
        ttlMs: 60_000,
        discover: otherDiscover,
      }),
    });
    const same = await discoverProviderModelsWithCache({
      paths,
      name: "LM Studio",
      adapter: adapter({
        provider: "lmstudio",
        source: "local-http",
        scope,
        ttlMs: 60_000,
        discover: sameDiscover,
      }),
    });

    expect(otherDiscover).toHaveBeenCalledTimes(1);
    expect(otherDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "catalog", force: true }),
    );
    expect(other.discovery.models.map((model) => model.id)).toEqual(["other-endpoint"]);
    expect(sameDiscover).not.toHaveBeenCalled();
    expect(same.discovery.models.map((model) => model.id)).toEqual(["scoped"]);
    expect(same.stale).toBe(false);
  });

  test("refreshes a fresh cache when forced or the adapter ttl is zero", async () => {
    const forcedPaths = await tmpPaths("model-discovery-force-");
    await seedFreshCache({ paths: forcedPaths });
    const forcedDiscover = mock(
      async (): Promise<ModelDiscoveryResult> => ({
        provider: "openai",
        source: "api",
        models: [{ id: "forced", displayName: "Forced" }],
      }),
    );
    const forced = await discoverProviderModelsWithCache({
      paths: forcedPaths,
      name: "OpenAI",
      forceRefresh: true,
      adapter: adapter({ discover: forcedDiscover }),
    });

    expect(forcedDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "manual", force: true }),
    );
    expect(forced.stale).toBe(false);
    expect(forced.discovery.models.map((model) => model.id)).toEqual(["forced"]);

    const ttlPaths = await tmpPaths("model-discovery-ttl0-");
    await seedFreshCache({
      paths: ttlPaths,
      provider: "lmstudio",
      source: "local-http",
    });
    const ttlDiscover = mock(
      async (): Promise<ModelDiscoveryResult> => ({
        provider: "lmstudio",
        source: "local-http",
        models: [{ id: "live", displayName: "Live" }],
      }),
    );
    const verified = await discoverProviderModelsWithCache({
      paths: ttlPaths,
      name: "LM Studio",
      adapter: adapter({
        provider: "lmstudio",
        source: "local-http",
        ttlMs: 0,
        allowEmpty: true,
        discover: ttlDiscover,
      }),
    });

    expect(ttlDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ttl", force: true }),
    );
    expect(verified.stale).toBe(false);
    expect(verified.discovery.models.map((model) => model.id)).toEqual(["live"]);
    expect(verified.discovery.expiresAt).toBeUndefined();
    expect(
      (await readModelDiscoveryCache(ttlPaths, "lmstudio"))?.models.map((model) => model.id),
    ).toEqual(["live"]);
  });

  test("refreshes only app-server caches missing advertised reasoning efforts", async () => {
    const appPaths = await tmpPaths("model-discovery-efforts-");
    await seedFreshCache({
      paths: appPaths,
      provider: "codex-cli",
      source: "app-server",
      models: [
        {
          id: "solstice",
          displayName: "Solstice",
          reasoning: { defaultEffort: "medium" },
        },
      ],
    });
    const appDiscover = mock(
      async (): Promise<ModelDiscoveryResult> => ({
        provider: "codex-cli",
        source: "app-server",
        models: [
          {
            id: "solstice",
            displayName: "Solstice",
            reasoning: {
              defaultEffort: "medium",
              availableEfforts: ["low", "medium", "high"],
            },
          },
        ],
      }),
    );
    const refreshed = await discoverProviderModelsWithCache({
      paths: appPaths,
      name: "Codex",
      adapter: adapter({
        provider: "codex-cli",
        source: "app-server",
        discover: appDiscover,
      }),
    });

    expect(appDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ttl", force: true }),
    );
    expect(refreshed.stale).toBe(false);
    expect(refreshed.discovery.models[0]?.reasoning).toEqual({
      defaultEffort: "medium",
      availableEfforts: ["low", "medium", "high"],
    });

    const apiPaths = await tmpPaths("model-discovery-api-efforts-");
    await seedFreshCache({
      paths: apiPaths,
      models: [
        {
          id: "cached-model",
          displayName: "Cached Model",
          reasoning: { defaultEffort: "medium" },
        },
      ],
    });
    const apiDiscover = mock(async () => {
      throw new Error("api cache should stay fresh");
    });
    const served = await discoverProviderModelsWithCache({
      paths: apiPaths,
      name: "OpenAI",
      adapter: adapter({ discover: apiDiscover }),
    });

    expect(apiDiscover).not.toHaveBeenCalled();
    expect(served.stale).toBe(false);
    expect(served.discovery.models[0]?.reasoning).toEqual({ defaultEffort: "medium" });

    const completePaths = await tmpPaths("model-discovery-complete-efforts-");
    await seedFreshCache({
      paths: completePaths,
      provider: "codex-cli",
      source: "app-server",
      models: [
        {
          id: "solstice",
          displayName: "Solstice",
          reasoning: {
            defaultEffort: "medium",
            availableEfforts: ["low", "medium", "high"],
          },
        },
      ],
    });
    const completeDiscover = mock(async () => {
      throw new Error("complete app-server cache should stay fresh");
    });
    const complete = await discoverProviderModelsWithCache({
      paths: completePaths,
      name: "Codex",
      adapter: adapter({
        provider: "codex-cli",
        source: "app-server",
        discover: completeDiscover,
      }),
    });

    expect(completeDiscover).not.toHaveBeenCalled();
    expect(complete.discovery.models[0]?.reasoning?.availableEfforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  test("keeps a live cache when discovery falls back to static data", async () => {
    const paths = await tmpPaths("model-discovery-static-");
    const cached = await seedFreshCache({
      paths,
      models: [{ id: "live-model", displayName: "Live Model" }],
    });
    const before = await fs.readFile(modelDiscoveryCachePath(paths, "openai"), "utf8");
    const discover = mock(
      async (): Promise<ModelDiscoveryResult> => ({
        provider: "openai",
        source: "static",
        models: [{ id: "bundled", displayName: "Bundled" }],
      }),
    );

    const result = await discoverProviderModelsWithCache({
      paths,
      name: "OpenAI",
      forceRefresh: true,
      adapter: adapter({ discover }),
    });

    expect(result.stale).toBe(true);
    expect(result.discovery.models.map((model) => model.id)).toEqual(["live-model"]);
    expect(result.message).toBe(
      `OpenAI model discovery fell back to static data. Using cached model catalog from ${cached.updatedAt}.`,
    );
    expect(await fs.readFile(modelDiscoveryCachePath(paths, "openai"), "utf8")).toBe(before);

    const emptyPaths = await tmpPaths("model-discovery-static-empty-");
    const staticDiscover = mock(
      async (): Promise<ModelDiscoveryResult> => ({
        provider: "openai",
        source: "static",
        message: "credentials missing",
        models: [{ id: "bundled", displayName: "Bundled" }],
      }),
    );
    const uncached = await discoverProviderModelsWithCache({
      paths: emptyPaths,
      name: "OpenAI",
      adapter: adapter({ discover: staticDiscover }),
    });

    expect(uncached).toEqual({
      discovery: {
        provider: "openai",
        source: "static",
        message: "credentials missing",
        models: [{ id: "bundled", displayName: "Bundled" }],
      },
      stale: false,
      message: "credentials missing",
    });
    expect(await readModelDiscoveryCache(emptyPaths, "openai")).toBeNull();
  });

  test("keeps a live cache when discovery returns no models unless empty is allowed", async () => {
    const preservedPaths = await tmpPaths("model-discovery-empty-");
    const cached = await seedFreshCache({ paths: preservedPaths });
    const before = await fs.readFile(modelDiscoveryCachePath(preservedPaths, "openai"), "utf8");
    const preserve = await discoverProviderModelsWithCache({
      paths: preservedPaths,
      name: "OpenAI",
      forceRefresh: true,
      adapter: adapter({
        discover: async () => ({
          provider: "openai",
          source: "api",
          models: [],
        }),
      }),
    });

    expect(preserve.stale).toBe(true);
    expect(preserve.discovery.models.map((model) => model.id)).toEqual(["cached-model"]);
    expect(preserve.message).toBe(
      `OpenAI model discovery returned no usable models. Using cached model catalog from ${cached.updatedAt}.`,
    );
    expect(await fs.readFile(modelDiscoveryCachePath(preservedPaths, "openai"), "utf8")).toBe(
      before,
    );

    const emptyPaths = await tmpPaths("model-discovery-allow-empty-");
    await seedFreshCache({
      paths: emptyPaths,
      provider: "lmstudio",
      source: "local-http",
      models: [{ id: "unloaded", displayName: "Unloaded" }],
    });
    const cleared = await discoverProviderModelsWithCache({
      paths: emptyPaths,
      name: "LM Studio",
      adapter: adapter({
        provider: "lmstudio",
        source: "local-http",
        ttlMs: 0,
        allowEmpty: true,
        discover: async () => ({
          provider: "lmstudio",
          source: "local-http",
          models: [],
        }),
      }),
    });

    expect(cleared.stale).toBe(false);
    expect(cleared.discovery.models).toEqual([]);
    expect((await readModelDiscoveryCache(emptyPaths, "lmstudio"))?.models).toEqual([]);
  });

  test("falls back to cache on discovery failure and rethrows when nothing is cached", async () => {
    const paths = await tmpPaths("model-discovery-error-");
    const cached = await seedFreshCache({ paths });
    const before = await fs.readFile(modelDiscoveryCachePath(paths, "openai"), "utf8");
    const failed = await discoverProviderModelsWithCache({
      paths,
      name: "OpenAI",
      forceRefresh: true,
      adapter: adapter({
        discover: async () => {
          throw new Error("socket closed");
        },
      }),
    });

    expect(failed.stale).toBe(true);
    expect(failed.discovery.models.map((model) => model.id)).toEqual(["cached-model"]);
    expect(failed.message).toBe(
      `OpenAI model discovery failed: socket closed Using cached model catalog from ${cached.updatedAt}.`,
    );
    expect(await fs.readFile(modelDiscoveryCachePath(paths, "openai"), "utf8")).toBe(before);

    const timeoutPaths = await tmpPaths("model-discovery-timeout-");
    const timeoutCached = await seedFreshCache({ paths: timeoutPaths });
    const timedOut = await discoverProviderModelsWithCache({
      paths: timeoutPaths,
      name: "OpenAI",
      forceRefresh: true,
      timeoutMs: 30,
      adapter: adapter({ discover: hangUntilAbort() }),
    });

    expect(timedOut.stale).toBe(true);
    expect(timedOut.discovery.models.map((model) => model.id)).toEqual(["cached-model"]);
    expect(timedOut.message).toBe(
      `OpenAI model discovery failed: OpenAI model discovery timed out after 30ms. Using cached model catalog from ${timeoutCached.updatedAt}.`,
    );

    const missingPaths = await tmpPaths("model-discovery-uncached-error-");
    await expect(
      discoverProviderModelsWithCache({
        paths: missingPaths,
        name: "OpenAI",
        adapter: adapter({
          discover: async () => {
            throw new Error("socket closed");
          },
        }),
      }),
    ).rejects.toThrow("socket closed");
    expect(await readModelDiscoveryCache(missingPaths, "openai")).toBeNull();
  });

  test("persists a successful discovery after dropping blank, duplicate, and secret fields", async () => {
    const paths = await tmpPaths("model-discovery-persist-");
    const discover = mock(
      async (): Promise<ModelDiscoveryResult> => ({
        provider: "openai",
        source: "api",
        models: [
          {
            id: "live",
            displayName: "Live",
            runtimeOptions: {
              temperature: 0.2,
              apiKey: "sk-live-secret",
              nested: { authorization: "Bearer secret", keep: "safe" },
            },
          },
          { id: "live", displayName: "Duplicate" },
          { id: "   ", displayName: "Blank" },
        ],
      }),
    );

    const result = await discoverProviderModelsWithCache({
      paths,
      name: "OpenAI",
      adapter: adapter({ discover }),
    });

    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "catalog", force: true }),
    );
    expect(result.stale).toBe(false);
    expect(result.discovery.models).toEqual([
      {
        id: "live",
        displayName: "Live",
        runtimeOptions: {
          temperature: 0.2,
          nested: { keep: "safe" },
        },
      },
    ]);
    const raw = await fs.readFile(modelDiscoveryCachePath(paths, "openai"), "utf8");
    expect(raw).not.toContain("sk-live-secret");
    expect(raw).not.toContain("Bearer secret");
    expect(await readModelDiscoveryCache(paths, "openai")).toMatchObject({
      provider: "openai",
      source: "api",
      models: result.discovery.models,
    });
  });

  test("treats a cache document that breaks the provider contract as a miss", async () => {
    const paths = await tmpPaths("model-discovery-untrusted-");
    const file = modelDiscoveryCachePath(paths, "openai");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const documents = [
      {
        version: 99,
        provider: "openai",
        source: "api",
        updatedAt: CACHED_UPDATED_AT,
        expiresAt: FRESH_EXPIRES_AT,
        models: [{ id: "poison", displayName: "Poison" }],
      },
      {
        version: 1,
        provider: "anthropic",
        source: "api",
        updatedAt: CACHED_UPDATED_AT,
        expiresAt: FRESH_EXPIRES_AT,
        models: [{ id: "poison", displayName: "Poison" }],
      },
      {
        version: 1,
        provider: "openai",
        source: "network",
        updatedAt: CACHED_UPDATED_AT,
        expiresAt: FRESH_EXPIRES_AT,
        models: [{ id: "poison", displayName: "Poison" }],
      },
      {
        version: 1,
        provider: "openai",
        source: "api",
        updatedAt: "not-a-date",
        expiresAt: FRESH_EXPIRES_AT,
        models: [{ id: "poison", displayName: "Poison" }],
      },
    ];

    for (const document of documents) {
      await fs.writeFile(file, JSON.stringify(document));
      const discover = mock(
        async (): Promise<ModelDiscoveryResult> => ({
          provider: "openai",
          source: "api",
          models: [{ id: "live", displayName: "Live" }],
        }),
      );
      const result = await discoverProviderModelsWithCache({
        paths,
        name: "OpenAI",
        adapter: adapter({ discover }),
      });

      expect(discover).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "catalog", force: true }),
      );
      expect(result.stale).toBe(false);
      expect(result.discovery.models.map((model) => model.id)).toEqual(["live"]);
    }
  });
});
