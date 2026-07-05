import fs from "node:fs/promises";
import path from "node:path";

import { parseGitHubShorthand, parseGitHubUrl } from "../extensions/github";
import type { FetchLike } from "../extensions/source";
import type { AgentConfig } from "../types";
import { writeTextFileAtomic } from "../utils/atomicFile";
import type { ParsedMarketplaceDocument } from "./marketplace";
import { BUILT_IN_MARKETPLACE_REPO, fetchRemotePluginMarketplace } from "./remoteMarketplace";

const DEFAULT_MARKETPLACE_REF = "main";
const DEFAULT_MARKETPLACE_MANIFEST_PATH = ".agents/plugins/marketplace.json";
const MARKETPLACES_FILE = "marketplaces.json";
const MARKETPLACES_FILE_VERSION = 1;

/** Narrow config surface so tests can pin the persistence file via a temp homedir. */
export type MarketplaceRegistryConfig = Pick<AgentConfig, "userCoworkDir">;

export type ConfiguredMarketplace = {
  id: string;
  repo: string;
  ref: string;
  marketplacePath: string;
  url: string;
  builtIn: boolean;
  addedAt?: string;
};

export type ConfiguredMarketplaceFetchResult = {
  marketplaces: Array<{ source: ConfiguredMarketplace; document: ParsedMarketplaceDocument }>;
  failures: Array<{ source: ConfiguredMarketplace; error: string }>;
};

type PersistedMarketplaceEntry = {
  repo: string;
  ref: string;
  marketplacePath: string;
  addedAt: string;
};

const registryInternals: { defaultFetchImpl: FetchLike | undefined } = {
  defaultFetchImpl: undefined,
};

function resolveMarketplaceFetchImpl(fetchImpl?: FetchLike): FetchLike | undefined {
  return fetchImpl ?? registryInternals.defaultFetchImpl;
}

export function marketplaceIdForRepo(repo: string): string {
  return repo.trim().toLowerCase();
}

function marketplaceUrl(repo: string, ref: string): string {
  return `https://github.com/${repo}/tree/${ref}`;
}

export function marketplacesFileForConfig(config: MarketplaceRegistryConfig): string {
  // Derive strictly from the session's cowork home. Never fall back to the
  // real OS home: configs pointing elsewhere (tests, isolated sessions) must
  // stay hermetic instead of silently reading the developer's registry.
  return path.join(config.userCoworkDir, "config", MARKETPLACES_FILE);
}

function builtInMarketplace(): ConfiguredMarketplace {
  return {
    id: marketplaceIdForRepo(BUILT_IN_MARKETPLACE_REPO),
    repo: BUILT_IN_MARKETPLACE_REPO,
    ref: DEFAULT_MARKETPLACE_REF,
    marketplacePath: DEFAULT_MARKETPLACE_MANIFEST_PATH,
    url: marketplaceUrl(BUILT_IN_MARKETPLACE_REPO, DEFAULT_MARKETPLACE_REF),
    builtIn: true,
  };
}

function toConfiguredMarketplace(entry: PersistedMarketplaceEntry): ConfiguredMarketplace {
  return {
    id: marketplaceIdForRepo(entry.repo),
    repo: entry.repo,
    ref: entry.ref,
    marketplacePath: entry.marketplacePath,
    url: marketplaceUrl(entry.repo, entry.ref),
    builtIn: false,
    addedAt: entry.addedAt,
  };
}

function isValidRepoSlug(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function normalizePersistedEntry(value: unknown): PersistedMarketplaceEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const repo = typeof record.repo === "string" ? record.repo.trim() : "";
  if (!isValidRepoSlug(repo)) return null;
  const ref =
    typeof record.ref === "string" && record.ref.trim().length > 0
      ? record.ref.trim()
      : DEFAULT_MARKETPLACE_REF;
  const marketplacePath =
    typeof record.marketplacePath === "string" && record.marketplacePath.trim().length > 0
      ? record.marketplacePath.trim()
      : DEFAULT_MARKETPLACE_MANIFEST_PATH;
  const addedAt = typeof record.addedAt === "string" ? record.addedAt : new Date(0).toISOString();
  return { repo, ref, marketplacePath, addedAt };
}

async function readPersistedMarketplaces(filePath: string): Promise<PersistedMarketplaceEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (record.version !== MARKETPLACES_FILE_VERSION || !Array.isArray(record.marketplaces)) {
    return [];
  }

  const builtInId = marketplaceIdForRepo(BUILT_IN_MARKETPLACE_REPO);
  const seenIds = new Set<string>();
  const entries: PersistedMarketplaceEntry[] = [];
  for (const candidate of record.marketplaces) {
    const entry = normalizePersistedEntry(candidate);
    if (!entry) continue;
    const id = marketplaceIdForRepo(entry.repo);
    if (id === builtInId || seenIds.has(id)) continue;
    seenIds.add(id);
    entries.push(entry);
  }
  return entries;
}

async function writePersistedMarketplaces(
  filePath: string,
  entries: PersistedMarketplaceEntry[],
): Promise<void> {
  const state = {
    version: MARKETPLACES_FILE_VERSION,
    marketplaces: entries,
  };
  await writeTextFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

export async function listConfiguredMarketplaces(
  config: MarketplaceRegistryConfig,
): Promise<ConfiguredMarketplace[]> {
  const entries = await readPersistedMarketplaces(marketplacesFileForConfig(config));
  return [builtInMarketplace(), ...entries.map(toConfiguredMarketplace)];
}

export function parseMarketplaceSourceInput(input: string): { repo: string; ref?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parsed = parseGitHubShorthand(trimmed) ?? parseGitHubUrl(trimmed);
  if (!parsed) return null;

  if (parsed.kind === "repo") {
    return isValidRepoSlug(parsed.repo) ? { repo: parsed.repo } : null;
  }

  // Only a repo-root tree URL (https://github.com/owner/repo/tree/<ref>) identifies
  // a marketplace; blob/raw URLs and subdirectory tree URLs are ambiguous.
  if (parsed.kind === "tree" && !parsed.subdir && isValidRepoSlug(parsed.repo)) {
    return parsed.ref ? { repo: parsed.repo, ref: parsed.ref } : { repo: parsed.repo };
  }

  return null;
}

export async function addMarketplace(opts: {
  config: MarketplaceRegistryConfig;
  sourceInput: string;
  fetchImpl?: FetchLike;
}): Promise<{ entry: ConfiguredMarketplace; marketplace: ParsedMarketplaceDocument }> {
  const parsed = parseMarketplaceSourceInput(opts.sourceInput);
  if (!parsed) {
    throw new Error(
      `Unrecognized marketplace source "${opts.sourceInput}". Use "owner/repo", a github.com repository URL, or a github.com tree URL with a branch.`,
    );
  }

  const repo = parsed.repo;
  const ref = parsed.ref ?? DEFAULT_MARKETPLACE_REF;
  const marketplacePath = DEFAULT_MARKETPLACE_MANIFEST_PATH;
  const id = marketplaceIdForRepo(repo);

  const configured = await listConfiguredMarketplaces(opts.config);
  const duplicate = configured.find((marketplace) => marketplace.id === id);
  if (duplicate) {
    throw new Error(
      duplicate.builtIn
        ? `Marketplace "${repo}" is the built-in marketplace and is always available.`
        : `Marketplace "${repo}" is already configured.`,
    );
  }

  // Validate before persisting: the manifest must fetch and parse.
  const marketplace = await fetchRemotePluginMarketplace({
    repo,
    ref,
    marketplacePath,
    fetchImpl: resolveMarketplaceFetchImpl(opts.fetchImpl),
  });

  const entry: PersistedMarketplaceEntry = {
    repo,
    ref,
    marketplacePath,
    addedAt: new Date().toISOString(),
  };
  const filePath = marketplacesFileForConfig(opts.config);
  const existing = await readPersistedMarketplaces(filePath);
  await writePersistedMarketplaces(filePath, [...existing, entry]);

  return { entry: toConfiguredMarketplace(entry), marketplace };
}

export async function removeMarketplace(opts: {
  config: MarketplaceRegistryConfig;
  id: string;
}): Promise<void> {
  const id = marketplaceIdForRepo(opts.id);
  if (id === marketplaceIdForRepo(BUILT_IN_MARKETPLACE_REPO)) {
    throw new Error("The built-in marketplace cannot be removed.");
  }

  const filePath = marketplacesFileForConfig(opts.config);
  const existing = await readPersistedMarketplaces(filePath);
  const remaining = existing.filter((entry) => marketplaceIdForRepo(entry.repo) !== id);
  if (remaining.length === existing.length) {
    throw new Error(`Marketplace "${opts.id}" is not configured.`);
  }
  await writePersistedMarketplaces(filePath, remaining);
}

async function fetchMarketplaceSources(
  sources: ConfiguredMarketplace[],
  fetchImpl?: FetchLike,
): Promise<ConfiguredMarketplaceFetchResult> {
  const effectiveFetchImpl = resolveMarketplaceFetchImpl(fetchImpl);
  const settled = await Promise.allSettled(
    sources.map(
      async (source) =>
        await fetchRemotePluginMarketplace({
          repo: source.repo,
          ref: source.ref,
          marketplacePath: source.marketplacePath,
          ...(effectiveFetchImpl ? { fetchImpl: effectiveFetchImpl } : {}),
        }),
    ),
  );

  const marketplaces: ConfiguredMarketplaceFetchResult["marketplaces"] = [];
  const failures: ConfiguredMarketplaceFetchResult["failures"] = [];
  settled.forEach((result, index) => {
    const source = sources[index];
    if (!source) return;
    if (result.status === "fulfilled") {
      marketplaces.push({ source, document: result.value });
      return;
    }
    failures.push({
      source,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  });

  return { marketplaces, failures };
}

export async function fetchConfiguredMarketplaces(opts: {
  config: MarketplaceRegistryConfig;
  fetchImpl?: FetchLike;
}): Promise<ConfiguredMarketplaceFetchResult> {
  const sources = await listConfiguredMarketplaces(opts.config);
  return await fetchMarketplaceSources(sources, opts.fetchImpl);
}

export type MarketplaceListEntry = {
  id: string;
  repo: string;
  ref: string;
  url: string;
  marketplacePath: string;
  builtIn: boolean;
  displayName?: string;
  pluginCount?: number;
  skillCount?: number;
  fetchError?: string;
  addedAt?: string;
};

export async function buildMarketplaceListEntries(opts: {
  config: MarketplaceRegistryConfig;
  fetchImpl?: FetchLike;
}): Promise<MarketplaceListEntry[]> {
  const sources = await listConfiguredMarketplaces(opts.config);
  const { marketplaces, failures } = await fetchMarketplaceSources(sources, opts.fetchImpl);
  const documentsById = new Map(marketplaces.map((entry) => [entry.source.id, entry.document]));
  const errorsById = new Map(failures.map((entry) => [entry.source.id, entry.error]));

  return sources.map((source) => {
    const document = documentsById.get(source.id);
    const fetchError = errorsById.get(source.id);
    return {
      id: source.id,
      repo: source.repo,
      ref: source.ref,
      url: source.url,
      marketplacePath: source.marketplacePath,
      builtIn: source.builtIn,
      ...(document
        ? {
            displayName: document.displayName ?? document.name,
            pluginCount: document.plugins.length,
            skillCount: document.skills.length,
          }
        : {}),
      ...(!document && fetchError !== undefined ? { fetchError } : {}),
      ...(source.addedAt ? { addedAt: source.addedAt } : {}),
    };
  });
}

export const __internal = {
  setDefaultFetchImplForTests(fetchImpl?: FetchLike) {
    registryInternals.defaultFetchImpl = fetchImpl;
  },
  resetForTests() {
    registryInternals.defaultFetchImpl = undefined;
  },
};
