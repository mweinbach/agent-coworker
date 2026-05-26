import {
  BUILT_IN_MARKETPLACE_PATH,
  BUILT_IN_MARKETPLACE_REF,
  BUILT_IN_MARKETPLACE_REPO,
  type FetchLike,
  fetchGitHubTextFile,
} from "../extensions/source";
import { type ParsedMarketplaceDocument, parseRemotePluginMarketplace } from "./marketplace";

export type RemotePluginMarketplaceOptions = {
  fetchImpl?: FetchLike;
  repo?: string;
  ref?: string;
  marketplacePath?: string;
};

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
