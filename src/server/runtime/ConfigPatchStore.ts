import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OpenAiCompatibleProviderOptionsByProvider } from "../../shared/openaiCompatibleOptions";
import {
  EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES,
  mergeEditableOpenAiCompatibleProviderOptions,
} from "../../shared/openaiCompatibleOptions";
import { type AgentConfig, defaultRuntimeNameForProvider } from "../../types";
import { writeTextFileAtomic } from "../../utils/atomicFile";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const errorWithCodeSchema = z
  .object({
    code: z.string().optional(),
  })
  .passthrough();

export type ProjectConfigPatch = Partial<
  Pick<
    AgentConfig,
    | "provider"
    | "model"
    | "preferredChildModel"
    | "childModelRoutingMode"
    | "preferredChildModelRef"
    | "allowedChildModelRefs"
    | "enableMcp"
    | "enableMemory"
    | "memoryRequireApproval"
    | "advancedMemory"
    | "memoryGenerationModel"
    | "skillImprovementEnabled"
    | "skillImprovementModel"
    | "skillImprovementScope"
    | "skillImprovementExcludedSkills"
    | "observabilityEnabled"
    | "backupsEnabled"
    | "toolOutputOverflowChars"
    | "userName"
    | "featureFlags"
  >
> & {
  userProfile?: Partial<NonNullable<AgentConfig["userProfile"]>>;
  clearMemoryGenerationModel?: boolean;
  clearSkillImprovementModel?: boolean;
  clearToolOutputOverflowChars?: boolean;
  providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
};

type PersistConfigPatchOptions = {
  globalConfigDir?: string;
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return jsonObjectSchema.safeParse(v).success;
}

export function isErrorWithCode(err: unknown, code: string): boolean {
  const parsed = errorWithCodeSchema.safeParse(err);
  return parsed.success && parsed.data.code === code;
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: T): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

export function mergeRuntimeProviderOptions(
  runtimeProviderOptions: unknown,
  configProviderOptions: unknown,
): AgentConfig["providerOptions"] | undefined {
  if (isPlainObject(runtimeProviderOptions) && isPlainObject(configProviderOptions)) {
    return deepMerge(
      runtimeProviderOptions as Record<string, unknown>,
      configProviderOptions as Record<string, unknown>,
    ) as AgentConfig["providerOptions"];
  }
  if (isPlainObject(configProviderOptions)) {
    return configProviderOptions as AgentConfig["providerOptions"];
  }
  if (isPlainObject(runtimeProviderOptions)) {
    return runtimeProviderOptions as AgentConfig["providerOptions"];
  }
  return undefined;
}

async function loadJsonObjectSafe(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in config file ${filePath}: ${String(error)}`);
    }
    const parsedObject = jsonObjectSchema.safeParse(parsedJson);
    if (!parsedObject.success) {
      throw new Error(`Config file must contain a JSON object: ${filePath}`);
    }
    return parsedObject.data;
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return {};
    if (error instanceof Error) throw error;
    throw new Error(`Failed to load config file ${filePath}: ${String(error)}`);
  }
}

async function persistConfigPatchFile(
  configDir: string,
  patch: ProjectConfigPatch,
  runtimeProviderOptions?: AgentConfig["providerOptions"],
): Promise<void> {
  const entries = Object.entries(patch).filter(
    ([key, value]) =>
      key !== "clearMemoryGenerationModel" &&
      key !== "clearSkillImprovementModel" &&
      key !== "clearToolOutputOverflowChars" &&
      value !== undefined,
  );
  const shouldClearMemoryGenerationModel = patch.clearMemoryGenerationModel === true;
  const shouldClearSkillImprovementModel = patch.clearSkillImprovementModel === true;
  const shouldClearToolOutputOverflowChars = patch.clearToolOutputOverflowChars === true;
  if (
    entries.length === 0 &&
    !shouldClearMemoryGenerationModel &&
    !shouldClearSkillImprovementModel &&
    !shouldClearToolOutputOverflowChars
  )
    return;
  const configPath = path.join(configDir, "config.json");
  const current = await loadJsonObjectSafe(configPath);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of entries) {
    if (key === "providerOptions") {
      const currentProviderOptions = isPlainObject(current[key]) ? { ...current[key] } : {};
      for (const provider of EDITABLE_PROVIDER_OPTIONS_PROVIDER_NAMES) {
        const sectionPatch = patch.providerOptions?.[provider];
        if (!sectionPatch) continue;

        const runtimeSection =
          isPlainObject(runtimeProviderOptions) && isPlainObject(runtimeProviderOptions[provider])
            ? { ...runtimeProviderOptions[provider] }
            : {};
        const currentSection = isPlainObject(currentProviderOptions[provider])
          ? { ...currentProviderOptions[provider] }
          : {};

        // Merge order (lowest -> highest priority): runtime, persisted config, incoming patch.
        currentProviderOptions[provider] = {
          ...runtimeSection,
          ...currentSection,
          ...sectionPatch,
        };
      }
      next[key] =
        Object.keys(currentProviderOptions).length > 0 ? currentProviderOptions : undefined;
      continue;
    }
    if (key === "userProfile" && isPlainObject(value)) {
      const currentUserProfile = isPlainObject(current.userProfile) ? current.userProfile : {};
      next[key] = {
        ...currentUserProfile,
        ...value,
      };
      continue;
    }
    if (key === "featureFlags" && isPlainObject(value)) {
      const currentFeatureFlags = isPlainObject(current.featureFlags)
        ? (current.featureFlags as Record<string, unknown>)
        : {};
      next[key] = {
        ...currentFeatureFlags,
        ...value,
      };
      continue;
    }
    next[key] = value;
  }
  if (shouldClearToolOutputOverflowChars) {
    delete next.toolOutputOverflowChars;
  }
  if (shouldClearMemoryGenerationModel) {
    delete next.memoryGenerationModel;
  }
  if (shouldClearSkillImprovementModel) {
    delete next.skillImprovementModel;
  }
  await fs.mkdir(configDir, { recursive: true });
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  await writeTextFileAtomic(configPath, payload);
}

export async function persistProjectConfigPatch(
  projectCoworkDir: string,
  patch: ProjectConfigPatch,
  runtimeProviderOptions?: AgentConfig["providerOptions"],
  opts: PersistConfigPatchOptions = {},
): Promise<void> {
  const projectPatch: ProjectConfigPatch = { ...patch };
  const globalPatch: ProjectConfigPatch = {};
  const globalConfigDir = opts.globalConfigDir?.trim();

  if (globalConfigDir) {
    if (patch.advancedMemory !== undefined) {
      globalPatch.advancedMemory = patch.advancedMemory;
      delete projectPatch.advancedMemory;
    }
    if (patch.memoryGenerationModel !== undefined) {
      globalPatch.memoryGenerationModel = patch.memoryGenerationModel;
      delete projectPatch.memoryGenerationModel;
    }
    if (patch.clearMemoryGenerationModel === true) {
      globalPatch.clearMemoryGenerationModel = true;
      delete projectPatch.clearMemoryGenerationModel;
    }
    if (patch.skillImprovementEnabled !== undefined) {
      globalPatch.skillImprovementEnabled = patch.skillImprovementEnabled;
      delete projectPatch.skillImprovementEnabled;
    }
    if (patch.skillImprovementModel !== undefined) {
      globalPatch.skillImprovementModel = patch.skillImprovementModel;
      delete projectPatch.skillImprovementModel;
    }
    if (patch.clearSkillImprovementModel === true) {
      globalPatch.clearSkillImprovementModel = true;
      delete projectPatch.clearSkillImprovementModel;
    }
    if (patch.skillImprovementScope !== undefined) {
      globalPatch.skillImprovementScope = patch.skillImprovementScope;
      delete projectPatch.skillImprovementScope;
    }
    if (patch.skillImprovementExcludedSkills !== undefined) {
      globalPatch.skillImprovementExcludedSkills = patch.skillImprovementExcludedSkills;
      delete projectPatch.skillImprovementExcludedSkills;
    }
  }

  await persistConfigPatchFile(projectCoworkDir, projectPatch, runtimeProviderOptions);
  if (globalConfigDir) {
    await persistConfigPatchFile(globalConfigDir, globalPatch, runtimeProviderOptions);
  }
}

export function mergeConfigPatch(config: AgentConfig, patch: ProjectConfigPatch): AgentConfig {
  const {
    clearMemoryGenerationModel: _clearMemoryGenerationModel,
    clearSkillImprovementModel: _clearSkillImprovementModel,
    clearToolOutputOverflowChars: _clearToolOutputOverflowChars,
    featureFlags: featureFlagsPatch,
    ...configPatchBase
  } = patch;
  const configPatch = {
    ...configPatchBase,
    ...(featureFlagsPatch !== undefined ? { featureFlags: featureFlagsPatch } : {}),
  };
  const next: AgentConfig = { ...config, ...configPatch };
  if (patch.provider !== undefined && patch.provider !== config.provider) {
    next.runtime = defaultRuntimeNameForProvider(patch.provider);
  }
  if (patch.toolOutputOverflowChars !== undefined) {
    next.projectConfigOverrides = {
      ...config.projectConfigOverrides,
      toolOutputOverflowChars: patch.toolOutputOverflowChars,
    };
  }
  if (patch.clearToolOutputOverflowChars) {
    const { toolOutputOverflowChars: _ignored, ...remainingOverrides } =
      config.projectConfigOverrides ?? {};
    next.toolOutputOverflowChars = config.inheritedToolOutputOverflowChars;
    next.projectConfigOverrides =
      Object.keys(remainingOverrides).length > 0 ? remainingOverrides : undefined;
  }
  if (patch.clearMemoryGenerationModel) {
    next.memoryGenerationModel = undefined;
  }
  if (patch.clearSkillImprovementModel) {
    next.skillImprovementModel = undefined;
  }
  if (patch.providerOptions !== undefined) {
    next.providerOptions = mergeEditableOpenAiCompatibleProviderOptions(
      config.providerOptions,
      patch.providerOptions,
    );
  }
  if (patch.userProfile !== undefined) {
    next.userProfile = {
      ...config.userProfile,
      ...patch.userProfile,
    };
  }
  return next;
}
