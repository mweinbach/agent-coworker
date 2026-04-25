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
    | "enableA2ui"
    | "enableMemory"
    | "memoryRequireApproval"
    | "observabilityEnabled"
    | "backupsEnabled"
    | "toolOutputOverflowChars"
    | "userName"
    | "featureFlags"
  >
> & {
  userProfile?: Partial<NonNullable<AgentConfig["userProfile"]>>;
  clearToolOutputOverflowChars?: boolean;
  providerOptions?: OpenAiCompatibleProviderOptionsByProvider;
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return jsonObjectSchema.safeParse(v).success;
}

export function isErrorWithCode(err: unknown, code: string): boolean {
  const parsed = errorWithCodeSchema.safeParse(err);
  return parsed.success && parsed.data.code === code;
}

export function deepMerge<T extends Record<string, unknown>>(base: T, override: T): T {
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

export function readWorkspaceA2uiFlag(value: unknown): boolean | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return typeof value.a2ui === "boolean" ? value.a2ui : undefined;
}

export function withWorkspaceA2uiFeatureFlags(
  featureFlags: AgentConfig["featureFlags"] | undefined,
  a2ui: boolean,
): AgentConfig["featureFlags"] {
  return {
    ...featureFlags,
    workspace: { a2ui },
  };
}

export function resolveWorkspaceA2ui(
  config: Pick<AgentConfig, "featureFlags" | "enableA2ui">,
): boolean {
  const workspaceFlag = config.featureFlags?.workspace?.a2ui;
  return typeof workspaceFlag === "boolean" ? workspaceFlag : (config.enableA2ui ?? false);
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

export async function persistProjectConfigPatch(
  projectAgentDir: string,
  patch: ProjectConfigPatch,
  runtimeProviderOptions?: AgentConfig["providerOptions"],
): Promise<void> {
  const entries = Object.entries(patch).filter(
    ([key, value]) => key !== "clearToolOutputOverflowChars" && value !== undefined,
  );
  const shouldClearToolOutputOverflowChars = patch.clearToolOutputOverflowChars === true;
  if (entries.length === 0 && !shouldClearToolOutputOverflowChars) return;
  const configPath = path.join(projectAgentDir, "config.json");
  const current = await loadJsonObjectSafe(configPath);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of entries) {
    if (key === "enableA2ui" && typeof value === "boolean") {
      const currentFeatureFlags = isPlainObject(current.featureFlags)
        ? (current.featureFlags as AgentConfig["featureFlags"])
        : undefined;
      next.featureFlags = withWorkspaceA2uiFeatureFlags(currentFeatureFlags, value);
      next.enableA2ui = value;
      continue;
    }
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
      const incomingFeatureFlags: Record<string, unknown> = value;
      const incomingA2ui = readWorkspaceA2uiFlag(incomingFeatureFlags.workspace);
      const currentA2ui = readWorkspaceA2uiFlag(currentFeatureFlags.workspace);
      const resolvedA2ui = incomingA2ui ?? currentA2ui;
      next[key] = {
        ...currentFeatureFlags,
        ...(resolvedA2ui !== undefined ? { workspace: { a2ui: resolvedA2ui } } : {}),
      };
      if (resolvedA2ui !== undefined) {
        next.enableA2ui = resolvedA2ui;
      }
      continue;
    }
    next[key] = value;
  }
  if (shouldClearToolOutputOverflowChars) {
    delete next.toolOutputOverflowChars;
  }
  await fs.mkdir(projectAgentDir, { recursive: true });
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  await writeTextFileAtomic(configPath, payload);
}

export function mergeConfigPatch(config: AgentConfig, patch: ProjectConfigPatch): AgentConfig {
  const {
    clearToolOutputOverflowChars: _clearToolOutputOverflowChars,
    enableA2ui: legacyEnableA2uiPatch,
    ...configPatch
  } = patch;
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
  const patchedWorkspaceA2ui = readWorkspaceA2uiFlag(patch.featureFlags?.workspace);
  const nextWorkspaceA2ui =
    legacyEnableA2uiPatch ??
    patchedWorkspaceA2ui ??
    config.featureFlags?.workspace?.a2ui ??
    config.enableA2ui;
  if (nextWorkspaceA2ui !== undefined) {
    next.featureFlags = withWorkspaceA2uiFeatureFlags(config.featureFlags, nextWorkspaceA2ui);
    next.enableA2ui = nextWorkspaceA2ui;
  }
  return next;
}
