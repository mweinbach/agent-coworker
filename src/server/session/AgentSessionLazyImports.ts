import type { runTurn } from "../../agent";
import type { connectProvider as connectModelProvider } from "../../connect";
import type { loadSystemPromptWithSkills } from "../../prompt";
import type { getProviderStatuses } from "../../providerStatus";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import type { generateSessionTitle } from "../sessionTitleService";

let connectModulePromise: Promise<typeof import("../../connect")> | null = null;
let promptModulePromise: Promise<typeof import("../../prompt")> | null = null;
let providerCatalogModulePromise: Promise<
  typeof import("../../providers/connectionCatalog")
> | null = null;
let providerStatusModulePromise: Promise<typeof import("../../providerStatus")> | null = null;
let agentModulePromise: Promise<typeof import("../../agent")> | null = null;
let sessionTitleServiceModulePromise: Promise<typeof import("../sessionTitleService")> | null =
  null;

const loadConnectModule = async (): Promise<typeof import("../../connect")> => {
  connectModulePromise ??= import("../../connect");
  return await connectModulePromise;
};

const loadPromptModule = async (): Promise<typeof import("../../prompt")> => {
  promptModulePromise ??= import("../../prompt");
  return await promptModulePromise;
};

const loadProviderCatalogModule = async (): Promise<
  typeof import("../../providers/connectionCatalog")
> => {
  providerCatalogModulePromise ??= import("../../providers/connectionCatalog");
  return await providerCatalogModulePromise;
};

const loadProviderStatusModule = async (): Promise<typeof import("../../providerStatus")> => {
  providerStatusModulePromise ??= import("../../providerStatus");
  return await providerStatusModulePromise;
};

const loadAgentModule = async (): Promise<typeof import("../../agent")> => {
  agentModulePromise ??= import("../../agent");
  return await agentModulePromise;
};

const loadSessionTitleServiceModule = async (): Promise<
  typeof import("../sessionTitleService")
> => {
  sessionTitleServiceModulePromise ??= import("../sessionTitleService");
  return await sessionTitleServiceModulePromise;
};

export const lazyConnectProvider: typeof connectModelProvider = async (...args) =>
  await (await loadConnectModule()).connectProvider(...args);

export const lazyLoadSystemPromptWithSkills: typeof loadSystemPromptWithSkills = async (
  ...args
) => await (await loadPromptModule()).loadSystemPromptWithSkills(...args);

export const lazyGetProviderCatalog: typeof getProviderCatalog = async (...args) =>
  await (await loadProviderCatalogModule()).getProviderCatalog(...args);

export const lazyGetProviderStatuses: typeof getProviderStatuses = async (...args) =>
  await (await loadProviderStatusModule()).getProviderStatuses(...args);

export const lazyRunTurn: typeof runTurn = async (...args) =>
  await (await loadAgentModule()).runTurn(...args);

export const lazyGenerateSessionTitle: typeof generateSessionTitle = async (...args) =>
  await (await loadSessionTitleServiceModule()).generateSessionTitle(...args);
