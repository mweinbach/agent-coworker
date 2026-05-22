import {
  APPLE_FOUNDATION_TITLE_MODEL,
  APPLE_TITLE_RANDOM_TOP_P,
  APPLE_TITLE_TEMPERATURE,
  generateAppleFoundationTitle,
  isAppleSiliconMac,
  loadAppleFoundationModelsModule,
} from "./appleFoundationTitle";
import { heuristicTitleFromQuery } from "./heuristicTitle";
import { generateRemoteModelTitle } from "./remoteModelTitle";
import { collapseWhitespace, DEFAULT_SESSION_TITLE, type SessionTitleResult } from "./shared";

export { heuristicTitleFromQuery } from "./heuristicTitle";
export {
  DEFAULT_SESSION_TITLE,
  type SessionTitleResult,
  type SessionTitleSource,
} from "./shared";

type SessionTitleDeps = {
  createRuntime: typeof import("../../runtime").createRuntime;
  defaultModelForProvider: typeof import("../../providers/catalog").defaultModelForProvider;
  loadAppleFoundationModelsModule: typeof loadAppleFoundationModelsModule;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
};

export function createSessionTitleGenerator(overrides: Partial<SessionTitleDeps> = {}) {
  let lazyDepsPromise: Promise<SessionTitleDeps> | null = null;

  const getDeps = async (): Promise<SessionTitleDeps> => {
    if (overrides.createRuntime && overrides.defaultModelForProvider) {
      return {
        createRuntime: overrides.createRuntime,
        defaultModelForProvider: overrides.defaultModelForProvider,
        loadAppleFoundationModelsModule:
          overrides.loadAppleFoundationModelsModule ?? loadAppleFoundationModelsModule,
        platform: overrides.platform ?? process.platform,
        arch: overrides.arch ?? process.arch,
        env: overrides.env ?? process.env,
      };
    }

    if (!lazyDepsPromise) {
      lazyDepsPromise = Promise.all([
        import("../../runtime"),
        import("../../providers/catalog"),
      ]).then(([runtime, catalog]) => ({
        createRuntime: overrides.createRuntime ?? runtime.createRuntime,
        defaultModelForProvider:
          overrides.defaultModelForProvider ?? catalog.defaultModelForProvider,
        loadAppleFoundationModelsModule:
          overrides.loadAppleFoundationModelsModule ?? loadAppleFoundationModelsModule,
        platform: overrides.platform ?? process.platform,
        arch: overrides.arch ?? process.arch,
        env: overrides.env ?? process.env,
      }));
    }

    return await lazyDepsPromise;
  };

  return async function generateSessionTitle(opts: {
    config: import("../../types").AgentConfig;
    query: string;
  }): Promise<SessionTitleResult> {
    const query = collapseWhitespace(opts.query);
    if (!query) {
      return {
        title: DEFAULT_SESSION_TITLE,
        source: "default",
        model: null,
      };
    }

    const deps = await getDeps();
    const appleTitle = await generateAppleFoundationTitle(query, deps);
    if (appleTitle.status === "generated") {
      return {
        title: appleTitle.title,
        source: "model",
        model: APPLE_FOUNDATION_TITLE_MODEL,
      };
    }
    if (appleTitle.status === "failed") {
      return {
        title: heuristicTitleFromQuery(query),
        source: "heuristic",
        model: null,
      };
    }

    const remoteTitle = await generateRemoteModelTitle({
      config: opts.config,
      query,
      deps,
    });
    if (remoteTitle) {
      return remoteTitle;
    }

    return {
      title: heuristicTitleFromQuery(query),
      source: "heuristic",
      model: null,
    };
  };
}

export const generateSessionTitle = createSessionTitleGenerator();

export const __internal = {
  APPLE_FOUNDATION_TITLE_MODEL,
  APPLE_TITLE_RANDOM_TOP_P,
  APPLE_TITLE_TEMPERATURE,
  generateAppleFoundationTitle,
  isAppleSiliconMac,
  loadAppleFoundationModelsModule,
};
