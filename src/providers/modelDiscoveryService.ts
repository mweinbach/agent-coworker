import type { AiCoworkerPaths } from "../store/connections";
import { raceWithAbort, withRequestTimeout } from "../utils/abortSignal";
import {
  isModelDiscoveryCacheFresh,
  type ModelDiscoveryAdapter,
  type ModelDiscoveryResult,
  modelDiscoveryResultFromCache,
  readModelDiscoveryCache,
  writeModelDiscoveryCache,
} from "./modelDiscoveryCache";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export async function discoverProviderModelsWithCache(opts: {
  paths: AiCoworkerPaths;
  adapter: ModelDiscoveryAdapter;
  name: string;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<{ discovery: ModelDiscoveryResult; stale: boolean; message?: string }> {
  const cached = await readModelDiscoveryCache(
    opts.paths,
    opts.adapter.provider,
    opts.adapter.cache?.scope,
  );
  const missingAdvertisedReasoningEfforts =
    cached?.source === "app-server" &&
    cached.models.some(
      (model) => model.reasoning?.defaultEffort && !model.reasoning.availableEfforts?.length,
    );
  if (
    cached &&
    !opts.forceRefresh &&
    !missingAdvertisedReasoningEfforts &&
    opts.adapter.cache?.ttlMs !== 0 &&
    isModelDiscoveryCacheFresh(cached)
  ) {
    return { discovery: modelDiscoveryResultFromCache(cached), stale: false };
  }

  try {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    const signal = withRequestTimeout(undefined, timeoutMs);
    const discovery = await raceWithAbort(
      opts.adapter.discover({
        reason: opts.forceRefresh ? "manual" : cached ? "ttl" : "catalog",
        force: true,
        signal,
      }),
      signal,
      `${opts.name} model discovery timed out after ${timeoutMs}ms.`,
    );
    if (discovery.source === "static" && cached && cached.source !== "static") {
      return {
        discovery: modelDiscoveryResultFromCache(cached),
        stale: true,
        message:
          discovery.message ??
          `${opts.name} model discovery fell back to static data. Using cached model catalog from ${cached.updatedAt}.`,
      };
    }
    if (discovery.source === "static") {
      return { discovery, stale: false, message: discovery.message };
    }
    if (
      discovery.models.length === 0 &&
      !opts.adapter.cache?.allowEmpty &&
      cached &&
      cached.source !== "static"
    ) {
      return {
        discovery: modelDiscoveryResultFromCache(cached),
        stale: true,
        message:
          discovery.message ??
          `${opts.name} model discovery returned no usable models. Using cached model catalog from ${cached.updatedAt}.`,
      };
    }
    const next = await writeModelDiscoveryCache(opts.paths, opts.adapter.provider, discovery, {
      scope: opts.adapter.cache?.scope,
      ttlMs: opts.adapter.cache?.ttlMs,
    });
    return { discovery: modelDiscoveryResultFromCache(next), stale: false };
  } catch (error) {
    if (cached) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        discovery: modelDiscoveryResultFromCache(cached),
        stale: true,
        message: `${opts.name} model discovery failed: ${reason} Using cached model catalog from ${cached.updatedAt}.`,
      };
    }
    throw error;
  }
}
