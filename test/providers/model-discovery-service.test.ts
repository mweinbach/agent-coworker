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

async function tmpPaths(prefix = "model-discovery-") {
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
  const { provider = "openai", source = "api", scope, ttlMs, allowEmpty, discover } = opts;
  return {
    provider,
    source,
    cache: {
      ...(scope !== undefined ? { scope } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(allowEmpty !== undefined ? { allowEmpty } : {}),
    },
    discover,
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
  return writeModelDiscoveryCache(
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

const modelIds = (result: { discovery: ModelDiscoveryResult }) =>
  result.discovery.models.map((m) => m.id);

describe("discoverProviderModelsWithCache", () => {
  test("serves a fresh cache without calling discovery", async () => {
    const paths = await tmpPaths();
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
    const paths = await tmpPaths();
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
    expect(modelIds(other)).toEqual(["other-endpoint"]);
    expect(sameDiscover).not.toHaveBeenCalled();
    expect(modelIds(same)).toEqual(["scoped"]);
    expect(same.stale).toBe(false);
  });

  test("refreshes a fresh cache when forced or the adapter ttl is zero", async () => {
    const forcedPaths = await tmpPaths();
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
    expect(modelIds(forced)).toEqual(["forced"]);

    const ttlPaths = await tmpPaths();
    await seedFreshCache({ paths: ttlPaths, provider: "lmstudio", source: "local-http" });
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
    expect(modelIds(verified)).toEqual(["live"]);
    expect(verified.discovery.expiresAt).toBeUndefined();
    expect((await readModelDiscoveryCache(ttlPaths, "lmstudio"))?.models.map((m) => m.id)).toEqual([
      "live",
    ]);
  });

  test("refreshes only app-server caches missing advertised reasoning efforts", async () => {
    const fullEfforts = {
      defaultEffort: "medium" as const,
      availableEfforts: ["low", "medium", "high"] as const,
    };
    const appPaths = await tmpPaths();
    await seedFreshCache({
      paths: appPaths,
      provider: "codex-cli",
      source: "app-server",
      models: [{ id: "solstice", displayName: "Solstice", reasoning: { defaultEffort: "medium" } }],
    });
    const appDiscover = mock(
      async (): Promise<ModelDiscoveryResult> => ({
        provider: "codex-cli",
        source: "app-server",
        models: [{ id: "solstice", displayName: "Solstice", reasoning: { ...fullEfforts } }],
      }),
    );
    const refreshed = await discoverProviderModelsWithCache({
      paths: appPaths,
      name: "Codex",
      adapter: adapter({ provider: "codex-cli", source: "app-server", discover: appDiscover }),
    });

    expect(appDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ttl", force: true }),
    );
    expect(refreshed.stale).toBe(false);
    expect(refreshed.discovery.models[0]?.reasoning).toEqual(fullEfforts);

    for (const [provider, source, name, reasoning] of [
      ["openai", "api", "OpenAI", { defaultEffort: "medium" as const }],
      ["codex-cli", "app-server", "Codex", { ...fullEfforts }],
    ] as const) {
      const paths = await tmpPaths();
      await seedFreshCache({
        paths,
        provider,
        source,
        models: [{ id: "m1", displayName: "M1", reasoning }],
      });
      const discover = mock(async () => {
        throw new Error("cache should stay fresh");
      });
      const res = await discoverProviderModelsWithCache({
        paths,
        name,
        adapter: adapter({ provider, source, discover }),
      });
      expect(discover).not.toHaveBeenCalled();
      expect(res.stale).toBe(false);
      expect(res.discovery.models[0]?.reasoning).toEqual(reasoning);
    }
  });

  test("keeps a live cache when discovery falls back to static data", async () => {
    const paths = await tmpPaths();
    const cached = await seedFreshCache({
      paths,
      models: [{ id: "live-model", displayName: "Live Model" }],
    });
    const cacheFile = modelDiscoveryCachePath(paths, "openai");
    const before = await fs.readFile(cacheFile, "utf8");
    const result = await discoverProviderModelsWithCache({
      paths,
      name: "OpenAI",
      forceRefresh: true,
      adapter: adapter({
        discover: async () => ({
          provider: "openai",
          source: "static",
          models: [{ id: "bundled", displayName: "Bundled" }],
        }),
      }),
    });

    expect(result.stale).toBe(true);
    expect(modelIds(result)).toEqual(["live-model"]);
    expect(result.message).toBe(
      `OpenAI model discovery fell back to static data. Using cached model catalog from ${cached.updatedAt}.`,
    );
    expect(await fs.readFile(cacheFile, "utf8")).toBe(before);

    const emptyPaths = await tmpPaths();
    const staticPayload: ModelDiscoveryResult = {
      provider: "openai",
      source: "static",
      message: "credentials missing",
      models: [{ id: "bundled", displayName: "Bundled" }],
    };
    const uncached = await discoverProviderModelsWithCache({
      paths: emptyPaths,
      name: "OpenAI",
      adapter: adapter({ discover: async () => staticPayload }),
    });

    expect(uncached).toEqual({
      discovery: staticPayload,
      stale: false,
      message: "credentials missing",
    });
    expect(await readModelDiscoveryCache(emptyPaths, "openai")).toBeNull();
  });

  test("keeps a live cache when discovery returns no models unless empty is allowed", async () => {
    const preservedPaths = await tmpPaths();
    const cached = await seedFreshCache({ paths: preservedPaths });
    const cacheFile = modelDiscoveryCachePath(preservedPaths, "openai");
    const before = await fs.readFile(cacheFile, "utf8");
    const preserve = await discoverProviderModelsWithCache({
      paths: preservedPaths,
      name: "OpenAI",
      forceRefresh: true,
      adapter: adapter({
        discover: async () => ({ provider: "openai", source: "api", models: [] }),
      }),
    });

    expect(preserve.stale).toBe(true);
    expect(modelIds(preserve)).toEqual(["cached-model"]);
    expect(preserve.message).toBe(
      `OpenAI model discovery returned no usable models. Using cached model catalog from ${cached.updatedAt}.`,
    );
    expect(await fs.readFile(cacheFile, "utf8")).toBe(before);

    const emptyPaths = await tmpPaths();
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
        discover: async () => ({ provider: "lmstudio", source: "local-http", models: [] }),
      }),
    });

    expect(cleared.stale).toBe(false);
    expect(cleared.discovery.models).toEqual([]);
    expect((await readModelDiscoveryCache(emptyPaths, "lmstudio"))?.models).toEqual([]);
  });

  test("falls back to cache on discovery failure and rethrows when nothing is cached", async () => {
    const paths = await tmpPaths();
    const cached = await seedFreshCache({ paths });
    const cacheFile = modelDiscoveryCachePath(paths, "openai");
    const before = await fs.readFile(cacheFile, "utf8");
    const failDiscover = async (): Promise<ModelDiscoveryResult> => {
      throw new Error("socket closed");
    };
    const failed = await discoverProviderModelsWithCache({
      paths,
      name: "OpenAI",
      forceRefresh: true,
      adapter: adapter({ discover: failDiscover }),
    });

    expect(failed.stale).toBe(true);
    expect(modelIds(failed)).toEqual(["cached-model"]);
    expect(failed.message).toBe(
      `OpenAI model discovery failed: socket closed Using cached model catalog from ${cached.updatedAt}.`,
    );
    expect(await fs.readFile(cacheFile, "utf8")).toBe(before);

    const timeoutPaths = await tmpPaths();
    const timeoutCached = await seedFreshCache({ paths: timeoutPaths });
    const timedOut = await discoverProviderModelsWithCache({
      paths: timeoutPaths,
      name: "OpenAI",
      forceRefresh: true,
      timeoutMs: 30,
      adapter: adapter({
        discover: ({ signal }) =>
          new Promise((_, reject) => {
            if (!signal) return reject(new Error("missing timeout signal"));
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      }),
    });

    expect(timedOut.stale).toBe(true);
    expect(modelIds(timedOut)).toEqual(["cached-model"]);
    expect(timedOut.message).toBe(
      `OpenAI model discovery failed: OpenAI model discovery timed out after 30ms. Using cached model catalog from ${timeoutCached.updatedAt}.`,
    );

    const missingPaths = await tmpPaths();
    await expect(
      discoverProviderModelsWithCache({
        paths: missingPaths,
        name: "OpenAI",
        adapter: adapter({ discover: failDiscover }),
      }),
    ).rejects.toThrow("socket closed");
    expect(await readModelDiscoveryCache(missingPaths, "openai")).toBeNull();
  });

  test("persists a successful discovery after dropping blank, duplicate, and secret fields", async () => {
    const paths = await tmpPaths();
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
        runtimeOptions: { temperature: 0.2, nested: { keep: "safe" } },
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
    const paths = await tmpPaths();
    const file = modelDiscoveryCachePath(paths, "openai");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const base = {
      version: 1,
      provider: "openai",
      source: "api",
      updatedAt: CACHED_UPDATED_AT,
      expiresAt: FRESH_EXPIRES_AT,
      models: [{ id: "poison", displayName: "Poison" }],
    };

    for (const override of [
      { version: 99 },
      { provider: "anthropic" },
      { source: "network" },
      { updatedAt: "not-a-date" },
    ]) {
      await fs.writeFile(file, JSON.stringify({ ...base, ...override }));
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
      expect(modelIds(result)).toEqual(["live"]);
    }
  });
});
