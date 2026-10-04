import { fetchWithGitHubAuth } from "../extensions/github";
import { type FetchLike, fetchGitHubTextFile } from "../extensions/source";
import type {
  MarketplacePluginCatalogEntry,
  MarketplaceSkillCatalogEntry,
  PluginMarketplaceMetadata,
} from "../types";
import type { PluginInstallMetadata } from "./manifest";
import { type ParsedMarketplaceDocument, parseRemotePluginMarketplace } from "./marketplace";
import { fetchConfiguredMarketplaces, type MarketplaceRegistryConfig } from "./marketplaceRegistry";

export const BUILT_IN_MARKETPLACE_REPO = "mweinbach/cowork-skills-plugins";
const BUILT_IN_MARKETPLACE_REF = "main";
const BUILT_IN_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";
const BUILT_IN_MARKETPLACE_URL = `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/${BUILT_IN_MARKETPLACE_REF}`;
export const DEFAULT_MARKETPLACE_PLUGIN_IDS = ["workspace-tools"] as const;
const DEFAULT_MARKETPLACE_PLUGIN_LEGACY_TOMBSTONES: Record<string, readonly string[]> = {
  "workspace-tools": ["documents", "pdf", "presentations", "spreadsheets"],
};

export function canonicalDefaultMarketplacePluginIdForTombstone(
  pluginId: string,
): (typeof DEFAULT_MARKETPLACE_PLUGIN_IDS)[number] | null {
  const normalizedId = pluginId.trim();
  for (const defaultPluginId of DEFAULT_MARKETPLACE_PLUGIN_IDS) {
    if (normalizedId === defaultPluginId) {
      return defaultPluginId;
    }
    if (
      (DEFAULT_MARKETPLACE_PLUGIN_LEGACY_TOMBSTONES[defaultPluginId] ?? []).includes(normalizedId)
    ) {
      return defaultPluginId;
    }
  }
  return null;
}

export function isBuiltInMarketplaceSourceInput(input: string | undefined): boolean {
  const normalized = normalizeInstallSourceInput(input);
  return (
    normalized !== null &&
    (normalized === BUILT_IN_MARKETPLACE_URL ||
      normalized.startsWith(`${BUILT_IN_MARKETPLACE_URL}/`))
  );
}

export type PluginMarketplaceInstallMetadata = NonNullable<PluginInstallMetadata["marketplace"]>;

export type RemotePluginMarketplaceOptions = {
  fetchImpl?: FetchLike;
  repo?: string;
  ref?: string;
  marketplacePath?: string;
  /**
   * Commit to download the manifest bytes from when it should differ from
   * `ref` (e.g. an install pinned to one commit). Plugin sourceInputs are
   * still built against `ref` so they keep matching install metadata and
   * inputs recorded from branch URLs.
   */
  contentRef?: string;
};

export function normalizeInstallSourceInput(input: string | null | undefined): string | null {
  const normalized = input?.trim().replace(/\/+$/g, "") ?? "";
  return normalized.length > 0 ? normalized : null;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function fetchRawGitHubTextFile(opts: {
  fetchImpl: FetchLike;
  repo: string;
  ref: string;
  githubPath: string;
}): Promise<string> {
  const rawUrl = `https://raw.githubusercontent.com/${opts.repo}/${encodeURIComponent(opts.ref)}/${opts.githubPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  const response = await fetchWithGitHubAuth(opts.fetchImpl, rawUrl);
  if (!response.ok) {
    const body = (await readResponseText(response)).trim();
    throw new Error(
      `Failed to fetch ${rawUrl}: ${body || `${response.status} ${response.statusText}`}`,
    );
  }
  return await response.text();
}

async function fetchMarketplaceJsonText(opts: {
  fetchImpl: FetchLike;
  repo: string;
  ref: string;
  marketplacePath: string;
}): Promise<string> {
  try {
    return await fetchGitHubTextFile({
      fetchImpl: opts.fetchImpl,
      repo: opts.repo,
      ref: opts.ref,
      githubPath: opts.marketplacePath,
    });
  } catch (contentsError) {
    const message = contentsError instanceof Error ? contentsError.message : String(contentsError);
    if (!message.startsWith("Failed to fetch ")) {
      throw contentsError;
    }
    try {
      return await fetchRawGitHubTextFile({
        fetchImpl: opts.fetchImpl,
        repo: opts.repo,
        ref: opts.ref,
        githubPath: opts.marketplacePath,
      });
    } catch (rawError) {
      throw new Error(
        `Failed to fetch remote marketplace: ${message}; raw fallback failed: ${rawError instanceof Error ? rawError.message : String(rawError)}`,
      );
    }
  }
}

export function buildMarketplaceCatalogMetadata(input: {
  name: string;
  displayName?: string;
  category?: string;
  installationPolicy?: string;
  authenticationPolicy?: string;
  sourceHash?: string;
}): PluginMarketplaceMetadata {
  return {
    name: input.name,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.installationPolicy ? { installationPolicy: input.installationPolicy } : {}),
    ...(input.authenticationPolicy ? { authenticationPolicy: input.authenticationPolicy } : {}),
    ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
  };
}

function buildMarketplaceEntryMetadata(
  marketplace: ParsedMarketplaceDocument,
  entry: ParsedMarketplaceDocument["plugins"][number] | ParsedMarketplaceDocument["skills"][number],
): PluginMarketplaceMetadata {
  return buildMarketplaceCatalogMetadata({
    name: marketplace.name,
    ...(marketplace.displayName ? { displayName: marketplace.displayName } : {}),
    category: entry.category,
    installationPolicy: entry.installationPolicy,
    authenticationPolicy: entry.authenticationPolicy,
    sourceHash: entry.sourceHash,
  });
}

function buildMarketplaceInstallMetadata(
  marketplace: ParsedMarketplaceDocument,
  plugin: ParsedMarketplaceDocument["plugins"][number],
): PluginMarketplaceInstallMetadata | null {
  if (!plugin.sourceInput) {
    return null;
  }
  return {
    ...buildMarketplaceEntryMetadata(marketplace, plugin),
    sourceInput: plugin.sourceInput,
  };
}

export function buildMarketplaceInstallMetadataByPluginId(
  marketplace: ParsedMarketplaceDocument,
  pluginIds?: ReadonlySet<string>,
): Map<string, PluginMarketplaceInstallMetadata> {
  const metadataByPluginId = new Map<string, PluginMarketplaceInstallMetadata>();
  for (const plugin of marketplace.plugins) {
    if (pluginIds && !pluginIds.has(plugin.name)) {
      continue;
    }
    const metadata = buildMarketplaceInstallMetadata(marketplace, plugin);
    if (metadata) {
      metadataByPluginId.set(plugin.name, metadata);
    }
  }
  return metadataByPluginId;
}

function buildMarketplaceInstallMetadataBySourceInput(
  marketplace: ParsedMarketplaceDocument,
  input: string,
): Map<string, PluginMarketplaceInstallMetadata> {
  const normalizedInput = normalizeInstallSourceInput(input);
  const metadataByPluginId = new Map<string, PluginMarketplaceInstallMetadata>();
  if (!normalizedInput) return metadataByPluginId;
  for (const plugin of marketplace.plugins) {
    if (normalizeInstallSourceInput(plugin.sourceInput) !== normalizedInput) {
      continue;
    }
    const metadata = buildMarketplaceInstallMetadata(marketplace, plugin);
    if (metadata) {
      metadataByPluginId.set(plugin.name, metadata);
    }
  }
  return metadataByPluginId;
}

function buildBaseRemoteMarketplaceEntry(
  marketplace: ParsedMarketplaceDocument,
  entry: ParsedMarketplaceDocument["plugins"][number] | ParsedMarketplaceDocument["skills"][number],
) {
  if (!entry.sourceInput) return null;
  const displayName = entry.displayName ?? entry.name;
  return {
    id: entry.name,
    name: entry.name,
    displayName,
    description: `Available from ${marketplace.displayName ?? marketplace.name}.`,
    scope: "user" as const,
    discoveryKind: "marketplace" as const,
    installed: false as const,
    enabled: false as const,
    marketplace: buildMarketplaceEntryMetadata(marketplace, entry),
    installSource: entry.sourceInput,
    warnings: [] as string[],
  };
}

export function buildRemoteMarketplaceCatalogEntry(opts: {
  marketplace: ParsedMarketplaceDocument;
  plugin: ParsedMarketplaceDocument["plugins"][number];
}): MarketplacePluginCatalogEntry | null {
  const base = buildBaseRemoteMarketplaceEntry(opts.marketplace, opts.plugin);
  if (!base) return null;
  return {
    ...base,
    interface: {
      displayName: base.displayName,
      shortDescription: opts.plugin.category,
      ...(opts.plugin.icon ? { logo: opts.plugin.icon } : {}),
      ...(opts.plugin.brandColor ? { brandColor: opts.plugin.brandColor } : {}),
    },
  };
}

export function buildRemoteMarketplaceSkillCatalogEntry(opts: {
  marketplace: ParsedMarketplaceDocument;
  skill: ParsedMarketplaceDocument["skills"][number];
}): MarketplaceSkillCatalogEntry | null {
  const base = buildBaseRemoteMarketplaceEntry(opts.marketplace, opts.skill);
  if (!base) return null;
  return {
    ...base,
    category: opts.skill.category,
    interface: {
      displayName: base.displayName,
      shortDescription: opts.skill.category,
      ...(opts.skill.icon ? { iconSmall: opts.skill.icon, iconLarge: opts.skill.icon } : {}),
    },
  };
}

export async function fetchRemotePluginMarketplace(
  opts: RemotePluginMarketplaceOptions = {},
): Promise<ParsedMarketplaceDocument> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const repo = opts.repo ?? BUILT_IN_MARKETPLACE_REPO;
  const ref = opts.ref ?? BUILT_IN_MARKETPLACE_REF;
  const contentRef = opts.contentRef ?? ref;
  const marketplacePath = opts.marketplacePath ?? BUILT_IN_MARKETPLACE_PATH;
  const raw = await fetchMarketplaceJsonText({
    fetchImpl,
    repo,
    ref: contentRef,
    marketplacePath,
  });
  const marketplace = parseRemotePluginMarketplace(raw, {
    marketplacePath: `https://github.com/${repo}/blob/${contentRef}/${marketplacePath}`,
    repo,
    ref,
  });
  return marketplace;
}

export async function fetchMarketplaceInstallMetadataBySourceInput(opts: {
  config: MarketplaceRegistryConfig;
  input: string;
  fetchImpl?: FetchLike;
  /** Per-marketplace-id commit override for the manifest download. */
  contentRefOverridesById?: ReadonlyMap<string, string>;
}): Promise<Map<string, PluginMarketplaceInstallMetadata>> {
  const { marketplaces } = await fetchConfiguredMarketplaces({
    config: opts.config,
    fetchImpl: opts.fetchImpl,
    contentRefOverridesById: opts.contentRefOverridesById,
  });
  const metadataByPluginId = new Map<string, PluginMarketplaceInstallMetadata>();
  for (const { document } of marketplaces) {
    for (const [pluginId, metadata] of buildMarketplaceInstallMetadataBySourceInput(
      document,
      opts.input,
    )) {
      // Earlier marketplaces (built-in first) win on plugin-id collisions.
      if (!metadataByPluginId.has(pluginId)) {
        metadataByPluginId.set(pluginId, metadata);
      }
    }
  }
  return metadataByPluginId;
}
