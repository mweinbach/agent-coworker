import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildTitlePrompt, sanitizeTitle } from "./shared";

export const PHI_SILICA_TITLE_MODEL = "PhiSilica";
export const PHI_SILICA_LAF_FEATURE_ID = "com.microsoft.windows.ai.languagemodel";
export const PHI_SILICA_TITLE_TEMPERATURE = 0.35;
export const PHI_SILICA_TITLE_TOP_P = 0.9;
export const PHI_SILICA_TITLE_ENABLED_ENV = "COWORK_PHI_SILICA_TITLE_ENABLED";
export const PHI_SILICA_SYSTEM_AI_MODELS_CAPABILITY_ENV =
  "COWORK_WINDOWS_AI_SYSTEM_AI_MODELS_CAPABILITY";

const WINDOWS_AI_READY_STATE_READY = 0;
const WINDOWS_AI_RESPONSE_STATUS_COMPLETE = 0;
const WINDOWS_AI_LAF_STATUS_AVAILABLE = 0;
const WINDOWS_AI_LAF_STATUS_AVAILABLE_WITHOUT_TOKEN = 1;

type WindowsAiFeatureReadyResult = {
  Status: number;
  ErrorDisplayText?: string;
};

type WindowsAiProgressPromise<T> = Promise<T> & {
  progress?: (
    callback: (error: Error | null, progress: string) => void,
  ) => WindowsAiProgressPromise<T>;
};

type WindowsAiLanguageModelResponseResult = {
  Text: string;
  Status: number;
};

type WindowsAiLanguageModel = {
  GenerateResponseAsync: (
    prompt: string,
    options?: WindowsAiLanguageModelOptions,
  ) => WindowsAiProgressPromise<WindowsAiLanguageModelResponseResult>;
  Close: () => void;
};

type WindowsAiLanguageModelConstructor = {
  CreateAsync: () => Promise<WindowsAiLanguageModel>;
  GetReadyState: () => number;
  EnsureReadyAsync?: () => WindowsAiProgressPromise<WindowsAiFeatureReadyResult>;
};

type WindowsAiLanguageModelOptions = {
  Temperature?: number;
  TopP?: number;
};

type WindowsAiLanguageModelOptionsConstructor = new () => WindowsAiLanguageModelOptions;

type WindowsAiLimitedAccessFeatureResult = {
  Status: number;
};

type WindowsAiLimitedAccessFeatures = {
  TryUnlockFeature: (
    featureId: string,
    token: string,
    developerSignature: string,
  ) => WindowsAiLimitedAccessFeatureResult;
};

export type WindowsAiElectronModule = {
  LanguageModel: WindowsAiLanguageModelConstructor;
  LanguageModelOptions?: WindowsAiLanguageModelOptionsConstructor;
  AIFeatureReadyState?: {
    Ready?: number;
    NotReady?: number;
    NotSupportedOnCurrentSystem?: number;
    DisabledByUser?: number;
  };
  AIFeatureReadyResultState?: {
    Success?: number;
    Failure?: number;
  };
  LanguageModelResponseStatus?: {
    Complete?: number;
    Error?: number;
  };
  LimitedAccessFeatureStatus?: {
    Available?: number;
    AvailableWithoutToken?: number;
    Unavailable?: number;
  };
  LimitedAccessFeatures?: WindowsAiLimitedAccessFeatures;
};

export type PhiSilicaTitleAttempt =
  | { status: "generated"; title: string }
  | { status: "unavailable" }
  | { status: "failed" };

export type PhiSilicaTitleDeps = {
  loadWindowsAiElectronModule: (env: NodeJS.ProcessEnv) => Promise<WindowsAiElectronModule>;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
};

function normalizeWindowsAiElectronModule(value: unknown): WindowsAiElectronModule {
  const module = value as { default?: unknown };
  return (module.default ?? value) as WindowsAiElectronModule;
}

export async function loadWindowsAiElectronModule(
  env: NodeJS.ProcessEnv,
): Promise<WindowsAiElectronModule> {
  const packagedAddonDir = env.COWORK_WINDOWS_AI_ELECTRON_DIR?.trim();
  if (packagedAddonDir) {
    const indexUrl = pathToFileURL(path.join(packagedAddonDir, "index.js")).href;
    return normalizeWindowsAiElectronModule(await import(indexUrl));
  }

  const packageName = "@microsoft/" + "windows-ai-electron";
  return normalizeWindowsAiElectronModule(await import(packageName));
}

export function isWindowsPhiSilicaCandidate(platform: NodeJS.Platform, arch: string): boolean {
  return platform === "win32" && (arch === "x64" || arch === "arm64");
}

function resolveReadyState(module: WindowsAiElectronModule): number {
  return module.LanguageModel.GetReadyState();
}

function isPhiSilicaReady(module: WindowsAiElectronModule): boolean {
  const readyState = resolveReadyState(module);
  const ready = module.AIFeatureReadyState?.Ready ?? WINDOWS_AI_READY_STATE_READY;
  return readyState === ready;
}

function resolveLafCredentials(env: NodeJS.ProcessEnv): {
  token: string;
  developerSignature: string;
} {
  return {
    token: env.COWORK_PHI_SILICA_LAF_TOKEN?.trim() ?? "",
    developerSignature:
      env.COWORK_PHI_SILICA_LAF_DEVELOPER_SIGNATURE?.trim() ??
      env.COWORK_PHI_SILICA_LAF_ATTESTATION?.trim() ??
      "",
  };
}

function isPhiSilicaGenerationConfigured(env: NodeJS.ProcessEnv): boolean {
  if (env[PHI_SILICA_TITLE_ENABLED_ENV] !== "1") {
    return false;
  }
  if (env[PHI_SILICA_SYSTEM_AI_MODELS_CAPABILITY_ENV] !== "1") {
    return false;
  }

  const { token, developerSignature } = resolveLafCredentials(env);
  return (
    (Boolean(token) && Boolean(developerSignature)) ||
    env.COWORK_PHI_SILICA_ALLOW_WITHOUT_LAF === "1"
  );
}

function unlockPhiSilicaGeneration(
  module: WindowsAiElectronModule,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!module.LimitedAccessFeatures) {
    return true;
  }

  const { token, developerSignature } = resolveLafCredentials(env);
  const result = module.LimitedAccessFeatures.TryUnlockFeature(
    PHI_SILICA_LAF_FEATURE_ID,
    token,
    developerSignature,
  );
  const available = module.LimitedAccessFeatureStatus?.Available ?? WINDOWS_AI_LAF_STATUS_AVAILABLE;
  const availableWithoutToken =
    module.LimitedAccessFeatureStatus?.AvailableWithoutToken ??
    WINDOWS_AI_LAF_STATUS_AVAILABLE_WITHOUT_TOKEN;
  return result.Status === available || result.Status === availableWithoutToken;
}

function buildPhiSilicaTitleOptions(
  module: WindowsAiElectronModule,
): WindowsAiLanguageModelOptions {
  const options = module.LanguageModelOptions ? new module.LanguageModelOptions() : {};
  options.Temperature = PHI_SILICA_TITLE_TEMPERATURE;
  options.TopP = PHI_SILICA_TITLE_TOP_P;
  return options;
}

export async function generatePhiSilicaTitle(
  query: string,
  deps: PhiSilicaTitleDeps,
): Promise<PhiSilicaTitleAttempt> {
  if (!isWindowsPhiSilicaCandidate(deps.platform, deps.arch)) {
    return { status: "unavailable" };
  }
  // The native Windows AI API can terminate the host when called without the
  // packaged app identity and systemAIModels capability that Phi Silica requires.
  if (!isPhiSilicaGenerationConfigured(deps.env)) {
    return { status: "unavailable" };
  }

  let windowsAiModule: WindowsAiElectronModule;
  try {
    windowsAiModule = await deps.loadWindowsAiElectronModule(deps.env);
  } catch {
    return { status: "unavailable" };
  }

  try {
    if (!isPhiSilicaReady(windowsAiModule)) {
      return { status: "unavailable" };
    }
  } catch {
    return { status: "unavailable" };
  }

  try {
    if (!unlockPhiSilicaGeneration(windowsAiModule, deps.env)) {
      return { status: "unavailable" };
    }
  } catch {
    return { status: "unavailable" };
  }

  let model: WindowsAiLanguageModel | null = null;
  try {
    model = await windowsAiModule.LanguageModel.CreateAsync();
    const result = await model.GenerateResponseAsync(
      buildTitlePrompt(query),
      buildPhiSilicaTitleOptions(windowsAiModule),
    );
    const complete =
      windowsAiModule.LanguageModelResponseStatus?.Complete ?? WINDOWS_AI_RESPONSE_STATUS_COMPLETE;
    if (result.Status !== complete) {
      return { status: "failed" };
    }

    const title = sanitizeTitle(result.Text);
    return title ? { status: "generated", title } : { status: "failed" };
  } catch {
    return { status: "failed" };
  } finally {
    model?.Close();
  }
}

export const __internal = {
  isPhiSilicaReady,
  isPhiSilicaGenerationConfigured,
  unlockPhiSilicaGeneration,
};
