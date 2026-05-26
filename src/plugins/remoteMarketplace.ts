import path from "node:path";

import {
  buildGitHubApiUrl,
  type FetchLike,
  fetchGitHubFile,
  githubHeaders,
} from "../skills/github";
import type { RemoteMarketplaceConfig } from "./builtInMarketplaces";
import { type ParsedMarketplaceDocument, parsePluginMarketplace } from "./marketplace";

export interface RemoteMarketplaceSnapshot {
  config: RemoteMarketplaceConfig;
  document: ParsedMarketplaceDocument;
  fetchedAt: string;
}

export interface RemoteMarketplaceFetchError {
  config: RemoteMarketplaceConfig;
  error: string;
}

interface ResolvedDownloadUrl {
  type: "file";
  download_url: string | null;
}

async function fetchContentsMetadata(
  fetchImpl: FetchLike,
  repo: string,
  ref: string,
  filePath: string,
): Promise<ResolvedDownloadUrl | null> {
  const url = buildGitHubApiUrl(repo, ref, filePath);
  const response = await fetchImpl(url, { headers: githubHeaders() });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as ResolvedDownloadUrl;
  if (payload.type !== "file" || !payload.download_url) {
    return null;
  }
  return payload;
}

export async function fetchRemoteMarketplace(
  config: RemoteMarketplaceConfig,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<RemoteMarketplaceSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const metadata = await fetchContentsMetadata(
    fetchImpl,
    config.repo,
    config.ref,
    config.marketplacePath,
  );
  if (!metadata?.download_url) {
    throw new Error(
      `Marketplace ${config.id}: failed to resolve download URL for ${config.repo}@${config.ref}/${config.marketplacePath}`,
    );
  }
  const bytes = await fetchGitHubFile(fetchImpl, metadata.download_url);
  const rawJson = bytes.toString("utf-8");

  // For remote marketplaces the marketplace.json sits inside a subfolder of the repo,
  // but plugin source paths are repo-root-relative. Use a synthetic repo-root as the
  // marketplaceRootDir so the parser's path resolution honors that convention.
  const syntheticRepoRoot = path.posix.join(
    `__remote__`,
    config.id,
    "root",
  );
  const syntheticMarketplacePath = path.posix.join(syntheticRepoRoot, config.marketplacePath);
  const document = parsePluginMarketplace(rawJson, syntheticMarketplacePath, syntheticRepoRoot);

  return {
    config,
    document,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchRemoteMarketplaces(
  configs: readonly RemoteMarketplaceConfig[],
  opts: { fetchImpl?: FetchLike } = {},
): Promise<{
  snapshots: RemoteMarketplaceSnapshot[];
  errors: RemoteMarketplaceFetchError[];
}> {
  const snapshots: RemoteMarketplaceSnapshot[] = [];
  const errors: RemoteMarketplaceFetchError[] = [];
  await Promise.all(
    configs.map(async (config) => {
      try {
        const snapshot = await fetchRemoteMarketplace(config, opts);
        snapshots.push(snapshot);
      } catch (error) {
        errors.push({
          config,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  return { snapshots, errors };
}

export function buildRemotePluginInstallUrl(
  config: RemoteMarketplaceConfig,
  pluginSourcePath: string,
): string {
  const subdir = pluginSourcePath.replace(/^\.\//, "").replace(/^\/+/, "");
  return `https://github.com/${config.repo}/tree/${config.ref}/${subdir}`;
}
