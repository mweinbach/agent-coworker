import { type FetchLike, fetchGitHubTextFile } from "../extensions/source";
import type { MarketplacePluginCatalogEntry, PluginMarketplaceMetadata } from "../types";
import type { PluginInstallMetadata } from "./manifest";
import { type ParsedMarketplaceDocument, parseRemotePluginMarketplace } from "./marketplace";

export const BUILT_IN_MARKETPLACE_REPO = "mweinbach/cowork-skills-plugins";
export const BUILT_IN_MARKETPLACE_REF = "main";
export const BUILT_IN_MARKETPLACE_PATH = ".agents/plugins/marketplace.json";
export const BUILT_IN_MARKETPLACE_URL = `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/${BUILT_IN_MARKETPLACE_REF}`;
export const DEFAULT_MARKETPLACE_PLUGIN_IDS = ["workspace-tools"] as const;
export const DEFAULT_MARKETPLACE_PLUGIN_LEGACY_TOMBSTONES: Record<string, readonly string[]> = {
  "workspace-tools": ["documents", "presentations", "spreadsheets"],
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

export function buildMarketplaceCatalogMetadata(input: {
  name: string;
  displayName?: string;
  category?: string;
  installationPolicy?: string;
  authenticationPolicy?: string;
}): PluginMarketplaceMetadata {
  return {
    name: input.name,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.installationPolicy ? { installationPolicy: input.installationPolicy } : {}),
    ...(input.authenticationPolicy ? { authenticationPolicy: input.authenticationPolicy } : {}),
  };
}

export function buildMarketplaceInstallMetadata(
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

export function buildMarketplaceInstallMetadataBySourceInput(
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
    },
    marketplace: buildMarketplaceCatalogMetadata({
      name: opts.marketplace.name,
      ...(opts.marketplace.displayName ? { displayName: opts.marketplace.displayName } : {}),
      category: opts.plugin.category,
      installationPolicy: opts.plugin.installationPolicy,
      authenticationPolicy: opts.plugin.authenticationPolicy,
    }),
    installSource: opts.plugin.sourceInput,
    warnings: [],
  };
}

export async function fetchRemotePluginMarketplace(
  opts: RemotePluginMarketplaceOptions = {},
): Promise<ParsedMarketplaceDocument> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const repo = opts.repo ?? BUILT_IN_MARKETPLACE_REPO;
  const ref = opts.ref ?? BUILT_IN_MARKETPLACE_REF;
  const marketplacePath = opts.marketplacePath ?? BUILT_IN_MARKETPLACE_PATH;
  const raw = await fetchGitHubTextFile({
    fetchImpl,
    repo,
    ref,
    githubPath: marketplacePath,
  });
  return parseRemotePluginMarketplace(raw, {
    marketplacePath: `https://github.com/${repo}/blob/${ref}/${marketplacePath}`,
    repo,
    ref,
  });
}

export async function fetchMarketplaceInstallMetadataBySourceInput(opts: {
  input: string;
  fetchImpl?: FetchLike;
}): Promise<Map<string, PluginMarketplaceInstallMetadata>> {
  const marketplace = await fetchRemotePluginMarketplace({ fetchImpl: opts.fetchImpl });
  return buildMarketplaceInstallMetadataBySourceInput(marketplace, opts.input);
}
