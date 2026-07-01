import fs from "node:fs/promises";
import path from "node:path";
import {
  type CatalogReasoningEffort,
  isCatalogReasoningEffort,
} from "../shared/openaiCompatibleOptions";
import { asArray, asRecord, asString } from "../shared/recordParsing";
import type { AiCoworkerPaths } from "../store/connections";
import { type ProviderName, resolveProviderName } from "../types";
import { writeTextFileAtomic } from "../utils/atomicFile";

export const MODEL_DISCOVERY_CACHE_VERSION = 1;
export const DEFAULT_MODEL_DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type ModelDiscoverySource =
  | "api"
  | "local-http"
  | "local-cli"
  | "app-server"
  | "filesystem"
  | "static";

export type ModelDiscoveryReason =
  | "startup"
  | "catalog"
  | "status-refresh"
  | "auth-success"
  | "manual"
  | "ttl"
  | "test";

export type CachedModelReasoning = {
  defaultEffort?: CatalogReasoningEffort;
  availableEfforts?: CatalogReasoningEffort[];
};

export type CachedModelDiscoveryModel = {
  id: string;
  model?: string;
  displayName: string;
  description?: string;
  knowledgeCutoff?: string;
  supportsImageInput?: boolean;
  isDefault?: boolean;
  reasoning?: CachedModelReasoning;
  runtimeOptions?: Record<string, unknown>;
  runtimeOverrides?: Record<string, unknown>;
};

export type ModelDiscoveryCacheFile = {
  version: typeof MODEL_DISCOVERY_CACHE_VERSION;
  provider: ProviderName;
  source: ModelDiscoverySource;
  updatedAt: string;
  expiresAt?: string;
  models: CachedModelDiscoveryModel[];
};

export type ModelDiscoveryResult = {
  provider: ProviderName;
  source: ModelDiscoverySource;
  models: CachedModelDiscoveryModel[];
  updatedAt?: string;
  expiresAt?: string;
  message?: string;
};

export type ModelDiscoveryAdapter = {
  provider: ProviderName;
  source: ModelDiscoverySource;
  discover(opts: {
    reason: ModelDiscoveryReason;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<ModelDiscoveryResult>;
};

const MODEL_DISCOVERY_SOURCES: readonly ModelDiscoverySource[] = [
  "api",
  "local-http",
  "local-cli",
  "app-server",
  "filesystem",
  "static",
];

const SECRET_KEY_PATTERN =
  /(^|[_-])(api[_-]?key|authorization|auth|bearer|credential|password|secret|token)([_-]|$)/i;
const MAX_SANITIZED_DEPTH = 4;
const MAX_SANITIZED_OBJECT_KEYS = 100;
const MAX_SANITIZED_ARRAY_ITEMS = 100;
const MAX_SANITIZED_STRING_LENGTH = 4096;

export function modelDiscoveryCacheDir(paths: AiCoworkerPaths): string {
  return path.join(paths.rootDir, "cache", "models");
}

export function modelDiscoveryCachePath(paths: AiCoworkerPaths, provider: ProviderName): string {
  return path.join(modelDiscoveryCacheDir(paths), `${provider}.json`);
}

function isModelDiscoverySource(value: unknown): value is ModelDiscoverySource {
  return (
    typeof value === "string" && MODEL_DISCOVERY_SOURCES.includes(value as ModelDiscoverySource)
  );
}

function normalizeString(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text ? text : undefined;
}

function normalizeReasoning(value: unknown): CachedModelReasoning | undefined {
  const reasoning = asRecord(value);
  if (!reasoning) return undefined;
  const defaultRaw = normalizeString(reasoning.defaultEffort);
  const defaultEffort = isCatalogReasoningEffort(defaultRaw) ? defaultRaw : undefined;
  const availableEfforts: CatalogReasoningEffort[] = [];
  for (const effort of asArray(reasoning.availableEfforts)) {
    const normalized = normalizeString(effort)?.toLowerCase();
    if (!isCatalogReasoningEffort(normalized) || availableEfforts.includes(normalized)) continue;
    availableEfforts.push(normalized);
  }
  const out: CachedModelReasoning = {
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(availableEfforts.length > 0 ? { availableEfforts } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeRuntimeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZED_DEPTH) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, MAX_SANITIZED_STRING_LENGTH);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value.slice(0, MAX_SANITIZED_ARRAY_ITEMS)) {
      const sanitized = sanitizeRuntimeValue(entry, depth + 1);
      if (sanitized !== undefined) out.push(sanitized);
    }
    return out;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record).slice(0, MAX_SANITIZED_OBJECT_KEYS)) {
    if (!key.trim() || SECRET_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeRuntimeValue(entry, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

function normalizeRuntimeRecord(value: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeRuntimeValue(value);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return undefined;
  return Object.keys(sanitized as Record<string, unknown>).length > 0
    ? (sanitized as Record<string, unknown>)
    : undefined;
}

export function normalizeDiscoveredModel(value: unknown): CachedModelDiscoveryModel | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = normalizeString(record.id);
  if (!id) return null;
  const model = normalizeString(record.model);
  const displayName = normalizeString(record.displayName) ?? id;
  const description = normalizeString(record.description);
  const knowledgeCutoff = normalizeString(record.knowledgeCutoff);
  const reasoning = normalizeReasoning(record.reasoning);
  const runtimeOptions = normalizeRuntimeRecord(record.runtimeOptions);
  const runtimeOverrides = normalizeRuntimeRecord(record.runtimeOverrides);
  return {
    id,
    ...(model ? { model } : {}),
    displayName,
    ...(description ? { description } : {}),
    ...(knowledgeCutoff ? { knowledgeCutoff } : {}),
    ...(typeof record.supportsImageInput === "boolean"
      ? { supportsImageInput: record.supportsImageInput }
      : {}),
    ...(record.isDefault === true ? { isDefault: true } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(runtimeOverrides ? { runtimeOverrides } : {}),
  };
}

export function normalizeModelDiscoveryModels(
  models: readonly unknown[],
): CachedModelDiscoveryModel[] {
  const out: CachedModelDiscoveryModel[] = [];
  const seen = new Set<string>();
  for (const rawModel of models) {
    const model = normalizeDiscoveredModel(rawModel);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

function normalizeCacheFile(
  value: unknown,
  provider: ProviderName,
): ModelDiscoveryCacheFile | null {
  const record = asRecord(value);
  if (!record || record.version !== MODEL_DISCOVERY_CACHE_VERSION) return null;
  if (resolveProviderName(record.provider) !== provider) return null;
  if (!isModelDiscoverySource(record.source)) return null;
  const updatedAt = normalizeString(record.updatedAt);
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) return null;
  const expiresAt = normalizeString(record.expiresAt);
  const models = normalizeModelDiscoveryModels(asArray(record.models));
  return {
    version: MODEL_DISCOVERY_CACHE_VERSION,
    provider,
    source: record.source,
    updatedAt,
    ...(expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? { expiresAt } : {}),
    models,
  };
}

export async function readModelDiscoveryCache(
  paths: AiCoworkerPaths,
  provider: ProviderName,
): Promise<ModelDiscoveryCacheFile | null> {
  try {
    const raw = await fs.readFile(modelDiscoveryCachePath(paths, provider), "utf-8");
    return normalizeCacheFile(JSON.parse(raw), provider);
  } catch {
    return null;
  }
}

export function isModelDiscoveryCacheFresh(
  cache: Pick<ModelDiscoveryCacheFile, "expiresAt"> | null | undefined,
  now = Date.now(),
): boolean {
  if (!cache?.expiresAt) return false;
  const expiresAtMs = Date.parse(cache.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > now;
}

export async function writeModelDiscoveryCache(
  paths: AiCoworkerPaths,
  provider: ProviderName,
  result: ModelDiscoveryResult,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<ModelDiscoveryCacheFile> {
  const now = opts.now ?? new Date();
  const ttlMs = opts.ttlMs ?? DEFAULT_MODEL_DISCOVERY_CACHE_TTL_MS;
  const models = normalizeModelDiscoveryModels(result.models);
  const cache: ModelDiscoveryCacheFile = {
    version: MODEL_DISCOVERY_CACHE_VERSION,
    provider,
    source: result.source,
    updatedAt: result.updatedAt ?? now.toISOString(),
    ...(result.expiresAt
      ? { expiresAt: result.expiresAt }
      : ttlMs > 0
        ? { expiresAt: new Date(now.getTime() + ttlMs).toISOString() }
        : {}),
    models,
  };
  await fs.mkdir(modelDiscoveryCacheDir(paths), { recursive: true, mode: 0o700 });
  await writeTextFileAtomic(
    modelDiscoveryCachePath(paths, provider),
    `${JSON.stringify(cache, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  try {
    await fs.chmod(modelDiscoveryCachePath(paths, provider), 0o600);
  } catch {
    // best effort only
  }
  return cache;
}

export function modelDiscoveryResultFromCache(
  cache: ModelDiscoveryCacheFile,
): ModelDiscoveryResult {
  return {
    provider: cache.provider,
    source: cache.source,
    updatedAt: cache.updatedAt,
    ...(cache.expiresAt ? { expiresAt: cache.expiresAt } : {}),
    models: cache.models,
  };
}
