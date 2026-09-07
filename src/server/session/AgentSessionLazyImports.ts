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

const loadConnectModule = (): Promise<typeof import("../../connect")> =>
  (connectModulePromise ??= import("../../connect"));

const loadPromptModule = (): Promise<typeof import("../../prompt")> =>
  (promptModulePromise ??= import("../../prompt"));

const loadProviderCatalogModule = (): Promise<typeof import("../../providers/connectionCatalog")> =>
  (providerCatalogModulePromise ??= import("../../providers/connectionCatalog"));

const loadProviderStatusModule = (): Promise<typeof import("../../providerStatus")> =>
  (providerStatusModulePromise ??= import("../../providerStatus"));

const loadAgentModule = (): Promise<typeof import("../../agent")> =>
  (agentModulePromise ??= import("../../agent"));

const loadSessionTitleServiceModule = (): Promise<typeof import("../sessionTitleService")> =>
  (sessionTitleServiceModulePromise ??= import("../sessionTitleService"));

export const lazyConnectProvider: typeof connectModelProvider = async (...args) =>
  await (await loadConnectModule()).connectProvider(...args);

export const lazyLoadSystemPromptWithSkills: typeof loadSystemPromptWithSkills = async (...args) =>
  await (await loadPromptModule()).loadSystemPromptWithSkills(...args);

export const lazyGetProviderCatalog: typeof getProviderCatalog = async (...args) =>
  await (await loadProviderCatalogModule()).getProviderCatalog(...args);

export const lazyGetProviderStatuses: typeof getProviderStatuses = async (...args) =>
  await (await loadProviderStatusModule()).getProviderStatuses(...args);

export const lazyRunTurn: typeof runTurn = async (...args) =>
  await (await loadAgentModule()).runTurn(...args);

/**
 * Kick off the heavy lazy module imports used by the first turn so a brand-new
 * session does not pay module-load cost on its first user message.
 */
export const warmLazyTurnModules = (): void => {
  void loadAgentModule().catch(() => undefined);
  void loadPromptModule().catch(() => undefined);
};

export const lazyGenerateSessionTitle: typeof generateSessionTitle = async (...args) =>
  await (await loadSessionTitleServiceModule()).generateSessionTitle(...args);
