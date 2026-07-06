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
  if (!input) return false;
  const normalized = normalizeInstallSourceInput(input);
  return (
    normalized === BUILT_IN_MARKETPLACE_URL || normalized.startsWith(`${BUILT_IN_MARKETPLACE_URL}/`)
  );
}

export type PluginMarketplaceInstallMetadata = NonNullable<PluginInstallMetadata["marketplace"]>;

export type RemotePluginMarketplaceOptions = {
  fetchImpl?: FetchLike;
  repo?: string;
  ref?: string;
  marketplacePath?: string;
};

function normalizeInstallSourceInput(input: string): string {
  return input.trim().replace(/\/+$/g, "");
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

function buildMarketplaceInstallMetadata(
  marketplace: ParsedMarketplaceDocument,
  plugin: ParsedMarketplaceDocument["plugins"][number],
): PluginMarketplaceInstallMetadata | null {
  if (!plugin.sourceInput) {
    return null;
  }
  return {
    ...buildMarketplaceCatalogMetadata({
      name: marketplace.name,
      ...(marketplace.displayName ? { displayName: marketplace.displayName } : {}),
      category: plugin.category,
      installationPolicy: plugin.installationPolicy,
      authenticationPolicy: plugin.authenticationPolicy,
      sourceHash: plugin.sourceHash,
    }),
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
  for (const plugin of marketplace.plugins) {
    if (!plugin.sourceInput) {
      continue;
    }
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

export function buildRemoteMarketplaceCatalogEntry(opts: {
  marketplace: ParsedMarketplaceDocument;
  plugin: ParsedMarketplaceDocument["plugins"][number];
}): MarketplacePluginCatalogEntry | null {
  if (!opts.plugin.sourceInput) {
    return null;
  }
  const displayName = opts.plugin.displayName ?? opts.plugin.name;
  return {
    id: opts.plugin.name,
    name: opts.plugin.name,
    displayName,
    description: `Available from ${opts.marketplace.displayName ?? opts.marketplace.name}.`,
    scope: "user",
    discoveryKind: "marketplace",
    installed: false,
    enabled: false,
    interface: {
      displayName,
      shortDescription: opts.plugin.category,
      ...(opts.plugin.icon ? { logo: opts.plugin.icon } : {}),
      ...(opts.plugin.brandColor ? { brandColor: opts.plugin.brandColor } : {}),
    },
    marketplace: buildMarketplaceCatalogMetadata({
      name: opts.marketplace.name,
      ...(opts.marketplace.displayName ? { displayName: opts.marketplace.displayName } : {}),
      category: opts.plugin.category,
      installationPolicy: opts.plugin.installationPolicy,
      authenticationPolicy: opts.plugin.authenticationPolicy,
      sourceHash: opts.plugin.sourceHash,
    }),
    installSource: opts.plugin.sourceInput,
    warnings: [],
  };
}

export function buildRemoteMarketplaceSkillCatalogEntry(opts: {
  marketplace: ParsedMarketplaceDocument;
  skill: ParsedMarketplaceDocument["skills"][number];
}): MarketplaceSkillCatalogEntry | null {
  if (!opts.skill.sourceInput) {
    return null;
  }
  const displayName = opts.skill.displayName ?? opts.skill.name;
  return {
    id: opts.skill.name,
    name: opts.skill.name,
    displayName,
    description: `Available from ${opts.marketplace.displayName ?? opts.marketplace.name}.`,
    category: opts.skill.category,
    scope: "user",
    discoveryKind: "marketplace",
    installed: false,
    enabled: false,
    interface: {
      displayName,
      shortDescription: opts.skill.category,
      ...(opts.skill.icon ? { iconSmall: opts.skill.icon, iconLarge: opts.skill.icon } : {}),
    },
    marketplace: buildMarketplaceCatalogMetadata({
      name: opts.marketplace.name,
      ...(opts.marketplace.displayName ? { displayName: opts.marketplace.displayName } : {}),
      category: opts.skill.category,
      installationPolicy: opts.skill.installationPolicy,
      authenticationPolicy: opts.skill.authenticationPolicy,
      sourceHash: opts.skill.sourceHash,
    }),
    installSource: opts.skill.sourceInput,
    warnings: [],
  };
}

export async function fetchRemotePluginMarketplace(
  opts: RemotePluginMarketplaceOptions = {},
): Promise<ParsedMarketplaceDocument> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const repo = opts.repo ?? BUILT_IN_MARKETPLACE_REPO;
  const ref = opts.ref ?? BUILT_IN_MARKETPLACE_REF;
  const marketplacePath = opts.marketplacePath ?? BUILT_IN_MARKETPLACE_PATH;
  const raw = await fetchMarketplaceJsonText({
    fetchImpl,
    repo,
    ref,
    marketplacePath,
  });
  const marketplace = parseRemotePluginMarketplace(raw, {
    marketplacePath: `https://github.com/${repo}/blob/${ref}/${marketplacePath}`,
    repo,
    ref,
  });
  return marketplace;
}

export async function fetchMarketplaceInstallMetadataBySourceInput(opts: {
  config: MarketplaceRegistryConfig;
  input: string;
  fetchImpl?: FetchLike;
}): Promise<Map<string, PluginMarketplaceInstallMetadata>> {
  const { marketplaces } = await fetchConfiguredMarketplaces({
    config: opts.config,
    fetchImpl: opts.fetchImpl,
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
