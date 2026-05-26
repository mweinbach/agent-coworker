export interface RemoteMarketplaceConfig {
  id: string;
  repo: string;
  ref: string;
  marketplacePath: string;
  displayName?: string;
}

export const BUILT_IN_MARKETPLACES: readonly RemoteMarketplaceConfig[] = [
  {
    id: "cowork-personal",
    repo: "mweinbach/cowork-skills-plugins",
    ref: "main",
    marketplacePath: ".agents/plugins/marketplace.json",
    displayName: "Cowork Personal",
  },
] as const;
