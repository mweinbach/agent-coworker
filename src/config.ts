import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { getAiCoworkerPaths } from "./connect";
import { isA2uiExperimentEnabled } from "./experimental/a2ui/flags";
import { isOpenAiNativeConnectorsExperimentEnabled } from "./experimental/openaiNativeConnectors/flags";
import { normalizeChildRoutingConfig } from "./models/childModelRouting";
import {
  getResolvedModelMetadataSync,
  isDynamicModelProvider,
  normalizeModelIdForProvider,
  resolveDefaultModelMetadata,
  resolveModelMetadata,
} from "./models/metadata";
import {
  defaultSupportedModel,
  describeModelProviderMismatch,
  getSupportedModel,
} from "./models/registry";
import {
  DEFAULT_SANDBOX_CONFIG,
  type SandboxConfig,
  type SandboxMode,
} from "./platform/sandbox/policy";
import { getModelForProvider, getProviderKeyCandidates } from "./providers";
import { DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS } from "./shared/toolOutputOverflow";
import { parseConnectionStoreJson } from "./store/connections";
import { isNetworkTelemetryGloballyDisabled } from "./telemetry/config";
import type {
  AgentConfig,
  CommandTemplateConfig,
  ProviderName,
  RuntimeName,
  WorkspaceFeatureFlagOverrides,
} from "./types";
import {
  normalizeRuntimeNameForProvider,
  resolveChildModelRoutingMode,
  resolveProviderName,
  resolveRuntimeName as resolveRuntimeNameFromValue,
} from "./types";
import { resolveAuthHomeDir } from "./utils/authHome";
import { getOneOffChatsRoot, isPathInsideOneOffChatsRoot } from "./utils/oneOffChats";
import { isPathInside } from "./utils/paths";

export { defaultModelForProvider } from "./providers";

export interface LoadConfigOptions {
  cwd?: string;
  homedir?: string;
  builtInDir?: string;
  env?: Record<string, string | undefined>;
}

const jsonObjectSchema = z.record(z.string(), z.unknown());
const stringSchema = z.string();
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const finiteNumberSchema = z.number().finite();
const booleanLikeSchema = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .transform((raw, ctx) => {
      const normalized = raw.toLowerCase();
      if (
        normalized === "1" ||
        normalized === "true" ||
        normalized === "yes" ||
        normalized === "y" ||
        normalized === "on"
      ) {
        return true;
      }
      if (
        normalized === "0" ||
        normalized === "false" ||
        normalized === "no" ||
        normalized === "n" ||
        normalized === "off"
      ) {
        return false;
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_boolean" });
      return z.NEVER;
    }),
]);
const numberLikeSchema = z.union([
  finiteNumberSchema,
  z
    .string()
    .trim()
    .min(1)
    .transform((raw, ctx) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_number" });
        return z.NEVER;
      }
      return parsed;
    }),
]);
const nonNegativeIntegerLikeSchema = numberLikeSchema
  .transform((value) => Math.floor(value))
  .refine((value) => value >= 0, { message: "invalid_non_negative_integer" });
const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return jsonObjectSchema.safeParse(v).success;
}

const SANDBOX_MODE_VALUES: readonly SandboxMode[] = [
  "auto",
  "read-only",
  "workspace-write",
  "danger-full-access",
];

/**
 * Resolve the effective sandbox configuration from the `AGENT_SANDBOX` env
 * override (mode) and the deep-merged config layers. Always returns a concrete
 * config; defaults to workspace-write with network enabled and fail-closed
 * backend enforcement.
 */
function resolveSandboxConfig(envMode: string | undefined, raw: unknown): SandboxConfig {
  const obj = isPlainObject(raw) ? raw : {};
  const trimmedEnv = envMode?.trim();
  const mode: SandboxMode = SANDBOX_MODE_VALUES.includes(trimmedEnv as SandboxMode)
    ? (trimmedEnv as SandboxMode)
    : SANDBOX_MODE_VALUES.includes(obj.mode as SandboxMode)
      ? (obj.mode as SandboxMode)
      : "workspace-write";
  return {
    mode,
    network: typeof obj.network === "boolean" ? obj.network : DEFAULT_SANDBOX_CONFIG.network,
    requireBackend:
      typeof obj.requireBackend === "boolean"
        ? obj.requireBackend
        : DEFAULT_SANDBOX_CONFIG.requireBackend,
  };
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

function mergeProviderOptionDefaults(
  provider: ProviderName,
  modelId: string,
  providerOptions: Record<string, any> | undefined,
): Record<string, any> | undefined {
  const defaults = getResolvedModelMetadataSync(provider, modelId, "model").providerOptionsDefaults;
  const current = isPlainObject(providerOptions)
    ? (deepMerge({}, providerOptions) as Record<string, any>)
    : undefined;
  const currentProviderOptions =
    current && isPlainObject(current[provider])
      ? (current[provider] as Record<string, unknown>)
      : undefined;
  const mergedProviderOptions = deepMerge(
    deepMerge({}, defaults as Record<string, unknown>),
    currentProviderOptions ?? {},
  );
  if (Object.keys(mergedProviderOptions).length === 0) {
    if (!current) return undefined;
    delete current[provider];
    return Object.keys(current).length > 0 ? current : undefined;
  }

  return {
    ...(current ?? {}),
    [provider]: mergedProviderOptions,
  };
}

async function resolveConfiguredModelMetadata(
  provider: ProviderName,
  modelId: string,
  source: string,
  providerOptions: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  home?: string,
) {
  if (isDynamicModelProvider(provider)) {
    return await resolveModelMetadata(provider, modelId, {
      allowPlaceholder: true,
      providerOptions,
      env,
      home,
      source,
      log: (line) => console.warn(`[config] ${line}`),
    });
  }
  const supported = getSupportedModel(provider, modelId);
  if (supported) return supported;
  const fallback = defaultSupportedModel(provider);
  const mismatchHint = describeModelProviderMismatch(provider, modelId);
  console.warn(
    `[config] Ignoring unsupported ${source} "${modelId}" for provider ${provider}; using "${fallback.id}".${mismatchHint ? ` ${mismatchHint}` : ""}`,
  );
  return fallback;
}

async function loadJsonSafe(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in config file ${filePath}: ${String(error)}`);
    }

    const result = jsonObjectSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Config file must contain a JSON object: ${filePath}`);
    }
    return result.data;
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return {};
    if (error instanceof Error) throw error;
    throw new Error(`Failed to load config file ${filePath}: ${String(error)}`);
  }
}

const commandTemplateSchema = z
  .object({
    template: z.string().trim().min(1),
    description: z.string().optional(),
    source: z.enum(["command", "mcp", "skill"]),
  })
  .strict();

const commandConfigSchema = z
  .record(z.string().trim().min(1), commandTemplateSchema)
  .transform((rawCommands) => {
    const commands: Record<string, CommandTemplateConfig> = {};
    for (const [name, command] of Object.entries(rawCommands)) {
      commands[name.trim()] = {
        template: command.template,
        source: command.source,
        ...(command.description !== undefined ? { description: command.description } : {}),
      };
    }
    return commands;
  });
const observabilityLayerSchema = z
  .object({
    baseUrl: nonEmptyTrimmedStringSchema.optional(),
    publicKey: nonEmptyTrimmedStringSchema.optional(),
    secretKey: nonEmptyTrimmedStringSchema.optional(),
    tracingEnvironment: nonEmptyTrimmedStringSchema.optional(),
    release: nonEmptyTrimmedStringSchema.optional(),
    recordInputs: booleanLikeSchema.optional(),
    recordOutputs: booleanLikeSchema.optional(),
  })
  .passthrough();
const harnessLayerSchema = z
  .object({
    reportOnly: booleanLikeSchema.optional(),
    strictMode: booleanLikeSchema.optional(),
  })
  .passthrough();
const modelSettingsLayerSchema = z
  .object({
    maxRetries: nonNegativeIntegerLikeSchema.optional(),
  })
  .passthrough();
const userProfileLayerSchema = z
  .object({
    instructions: z.string().optional(),
    work: z.string().optional(),
    details: z.string().optional(),
  })
  .passthrough();

function parseCommandConfig(raw: unknown): AgentConfig["command"] | undefined {
  if (raw === undefined) return undefined;

  const parsedRaw = commandConfigSchema.safeParse(raw);
  if (!parsedRaw.success) {
    throw new Error(
      `Invalid command config: ${parsedRaw.error.issues[0]?.message ?? "validation_failed"}`,
    );
  }

  if (Object.keys(parsedRaw.data).length === 0) return undefined;
  return parsedRaw.data;
}

function resolveBuiltInDir(env: Record<string, string | undefined> = process.env): string {
  const candidates: string[] = [];
  if (env.COWORK_BUILTIN_DIR) candidates.push(path.resolve(env.COWORK_BUILTIN_DIR));

  const here = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.resolve(here, ".."));

  // Bun-compiled binaries execute from bunfs virtual paths. In that mode,
  // colocated resources should be resolved relative to the binary on disk.
  candidates.push(path.dirname(process.execPath));

  for (const candidate of candidates) {
    if (fsSync.existsSync(path.join(candidate, "prompts", "system.md"))) return candidate;
  }

  return candidates[0] ?? path.resolve(here, "..");
}

function parseLayer<T>(schema: z.ZodType<T>, raw: unknown, fallback: T): T {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

function asProviderName(v: unknown): ProviderName | null {
  return resolveProviderName(v);
}

function asRuntimeName(v: unknown): RuntimeName | null {
  return resolveRuntimeNameFromValue(v);
}

function asString(v: unknown): string | undefined {
  const parsed = stringSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

function asTrimmedString(v: unknown): string | undefined {
  const parsed = stringSchema.safeParse(v);
  return parsed.success ? parsed.data.trim() : undefined;
}

function asBoolean(v: unknown): boolean | null {
  const parsed = booleanLikeSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

function normalizeWorkspaceFeatureFlagLayer(
  value: unknown,
): WorkspaceFeatureFlagOverrides | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const parsedA2ui = asBoolean(value.a2ui);
  const parsedOpenAiNativeConnectors = asBoolean(value.openAiNativeConnectors);
  if (parsedA2ui === null && parsedOpenAiNativeConnectors === null) {
    return undefined;
  }
  return {
    ...(parsedA2ui !== null ? { a2ui: parsedA2ui } : {}),
    ...(parsedOpenAiNativeConnectors !== null
      ? { openAiNativeConnectors: parsedOpenAiNativeConnectors }
      : {}),
  };
}

function asNonEmptyString(v: unknown): string | undefined {
  const parsed = nonEmptyTrimmedStringSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

function resolveDir(maybeRelative: unknown, baseDir: string): string {
  const parsed = stringSchema.safeParse(maybeRelative);
  if (!parsed.success || !parsed.data) return baseDir;
  const resolved = path.isAbsolute(parsed.data) ? parsed.data : path.resolve(baseDir, parsed.data);
  if (!isPathInside(baseDir, resolved)) {
    console.warn(
      `[config] Ignoring directory "${parsed.data}" — resolved path escapes workspace root; using default.`,
    );
    return baseDir;
  }
  return resolved;
}

function normalizeNonNegativeInt(v: unknown): number | undefined {
  const parsed = nonNegativeIntegerLikeSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

function normalizeNullableNonNegativeInt(v: unknown): number | null | undefined {
  if (v === null) return null;
  return normalizeNonNegativeInt(v);
}

function getSavedProviderApiKeyForHome(home: string, provider: ProviderName): string | undefined {
  const paths = getAiCoworkerPaths({ homedir: home });
  const keyCandidates = getProviderKeyCandidates(provider);

  let raw: string;
  try {
    raw = fsSync.readFileSync(paths.connectionsFile, "utf-8");
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return undefined;
    throw new Error(
      `Failed to read connection store at ${paths.connectionsFile}: ${String(error)}`,
    );
  }

  const parsedStore = parseConnectionStoreJson(raw, paths.connectionsFile);

  for (const candidate of keyCandidates) {
    const direct = parsedStore.services[candidate];
    if (direct?.mode === "api_key" && direct.apiKey) return direct.apiKey;
  }

  return undefined;
}

export function getSavedProviderApiKey(
  config: AgentConfig,
  provider: ProviderName,
): string | undefined {
  return getSavedProviderApiKeyForHome(resolveAuthHomeDir(config), provider);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AgentConfig> {
  const cwd = options.cwd ?? process.cwd();
  const homedir = options.homedir ?? os.homedir();
  const env = options.env ?? process.env;
  const builtInDir = options.builtInDir ?? resolveBuiltInDir(env);

  const projectCoworkDir = path.join(cwd, ".cowork");
  const workspaceAgentsDir = path.join(cwd, ".agents");
  const userAgentsDir = path.join(homedir, ".agents");
  const builtInConfigDir = path.join(builtInDir, "config");
  const coworkPaths = getAiCoworkerPaths({ homedir });
  const userCoworkDir = coworkPaths.rootDir;
  const oneOffChatsRoot = getOneOffChatsRoot(homedir);
  const projectMemoryCoworkDir = isPathInsideOneOffChatsRoot(cwd, homedir)
    ? path.join(oneOffChatsRoot, ".cowork")
    : projectCoworkDir;
  const projectMemoryDir = path.join(projectMemoryCoworkDir, "memory");
  const projectMemoryDbPath = path.join(projectMemoryCoworkDir, "memory.sqlite");
  const workspacePluginsDir = path.join(projectCoworkDir, "plugins");
  const userPluginsDir = path.join(userCoworkDir, "plugins");
  const userConfigDir = coworkPaths.configDir;

  const builtInDefaults = await loadJsonSafe(path.join(builtInConfigDir, "defaults.json"));
  const userConfig = await loadJsonSafe(path.join(userConfigDir, "config.json"));
  const projectConfig = await loadJsonSafe(path.join(projectCoworkDir, "config.json"));

  const inheritedMerged = deepMerge(builtInDefaults, userConfig);
  const merged = deepMerge(deepMerge(builtInDefaults, userConfig), projectConfig);

  const provider =
    asProviderName(env.AGENT_PROVIDER) ??
    asProviderName(projectConfig.provider) ??
    asProviderName(userConfig.provider) ??
    asProviderName(builtInDefaults.provider) ??
    "google";
  const rawRuntime =
    asRuntimeName(env.AGENT_RUNTIME) ??
    asRuntimeName(projectConfig.runtime) ??
    asRuntimeName(userConfig.runtime) ??
    asRuntimeName(builtInDefaults.runtime);
  const runtime = normalizeRuntimeNameForProvider(provider, rawRuntime);

  const workingDirectory = env.AGENT_WORKING_DIR || cwd;

  const sandbox = resolveSandboxConfig(
    env.AGENT_SANDBOX,
    (merged as Record<string, unknown>).sandbox,
  );

  const providerOptions = isPlainObject((merged as Record<string, unknown>).providerOptions)
    ? (deepMerge(
        {},
        (merged as Record<string, unknown>).providerOptions as Record<string, unknown>,
      ) as Record<string, unknown>)
    : undefined;

  const configuredModel =
    asNonEmptyString(env.AGENT_MODEL) ||
    asNonEmptyString(projectConfig.model) ||
    asNonEmptyString(userConfig.model) ||
    (asProviderName(builtInDefaults.provider) === provider &&
      asNonEmptyString(builtInDefaults.model));
  const supportedModel = configuredModel
    ? await resolveConfiguredModelMetadata(
        provider,
        configuredModel,
        "model",
        providerOptions,
        env,
        homedir,
      )
    : await resolveDefaultModelMetadata(provider, { providerOptions, env, home: homedir });

  const childModelRoutingMode =
    resolveChildModelRoutingMode(projectConfig.childModelRoutingMode) ||
    resolveChildModelRoutingMode(userConfig.childModelRoutingMode) ||
    resolveChildModelRoutingMode(builtInDefaults.childModelRoutingMode) ||
    "same-provider";
  const rawAllowedChildModelRefs =
    (Array.isArray(projectConfig.allowedChildModelRefs)
      ? projectConfig.allowedChildModelRefs
      : undefined) ||
    (Array.isArray(userConfig.allowedChildModelRefs)
      ? userConfig.allowedChildModelRefs
      : undefined) ||
    (Array.isArray(builtInDefaults.allowedChildModelRefs)
      ? builtInDefaults.allowedChildModelRefs
      : undefined);
  const preferredChildModelRef =
    asNonEmptyString(projectConfig.preferredChildModelRef) ||
    asNonEmptyString(userConfig.preferredChildModelRef) ||
    asNonEmptyString(builtInDefaults.preferredChildModelRef) ||
    asNonEmptyString(projectConfig.preferredChildModel) ||
    asNonEmptyString(userConfig.preferredChildModel) ||
    asNonEmptyString(builtInDefaults.preferredChildModel) ||
    asNonEmptyString(projectConfig.subAgentModel) ||
    asNonEmptyString(userConfig.subAgentModel) ||
    asNonEmptyString(builtInDefaults.subAgentModel) ||
    supportedModel.id;
  let normalizedChildRouting = {
    childModelRoutingMode,
    preferredChildModel: supportedModel.id,
    preferredChildModelRef: `${provider}:${supportedModel.id}`,
    allowedChildModelRefs: [] as string[],
  };
  try {
    normalizedChildRouting = normalizeChildRoutingConfig({
      provider,
      model: supportedModel.id,
      childModelRoutingMode,
      preferredChildModelRef,
      allowedChildModelRefs: rawAllowedChildModelRefs?.filter(
        (value): value is string => typeof value === "string",
      ),
      source: "config",
    });
  } catch (error) {
    console.warn(`[config] Ignoring invalid child model routing config: ${String(error)}`);
  }

  const parsedToolOutputOverflowChars = normalizeNullableNonNegativeInt(
    (merged as Record<string, unknown>).toolOutputOverflowChars,
  );
  const inheritedToolOutputOverflowCharsRaw = normalizeNullableNonNegativeInt(
    (inheritedMerged as Record<string, unknown>).toolOutputOverflowChars,
  );
  const projectToolOutputOverflowChars = normalizeNullableNonNegativeInt(
    projectConfig.toolOutputOverflowChars,
  );
  const inheritedToolOutputOverflowChars =
    inheritedToolOutputOverflowCharsRaw === undefined
      ? DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS
      : inheritedToolOutputOverflowCharsRaw;
  const toolOutputOverflowChars =
    parsedToolOutputOverflowChars === undefined
      ? DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS
      : parsedToolOutputOverflowChars;

  // Persistent, user-visible directories should be relative to the project (cwd) by default,
  // not the (potentially temporary) workingDirectory.
  const outputDirRaw =
    env.AGENT_OUTPUT_DIR ||
    projectConfig.outputDirectory ||
    userConfig.outputDirectory ||
    builtInDefaults.outputDirectory ||
    undefined;
  const outputDirectory = outputDirRaw ? resolveDir(outputDirRaw, cwd) : undefined;

  const uploadsDirRaw =
    env.AGENT_UPLOADS_DIR ||
    projectConfig.uploadsDirectory ||
    userConfig.uploadsDirectory ||
    builtInDefaults.uploadsDirectory ||
    undefined;
  const uploadsDirectory = uploadsDirRaw ? resolveDir(uploadsDirRaw, cwd) : undefined;

  const userName =
    asTrimmedString(env.AGENT_USER_NAME) ??
    asTrimmedString((merged as Record<string, unknown>).userName) ??
    "";
  const mergedUserProfile = parseLayer(
    userProfileLayerSchema,
    (merged as Record<string, unknown>).userProfile,
    {},
  );
  const userProfile = {
    instructions: asString(mergedUserProfile.instructions) ?? "",
    work: asString(mergedUserProfile.work) ?? "",
    details: asString(mergedUserProfile.details) ?? "",
  };
  const mergedFeatureFlagsLayer = isPlainObject((merged as Record<string, unknown>).featureFlags)
    ? ((merged as Record<string, unknown>).featureFlags as Record<string, unknown>)
    : undefined;
  const workspaceFeatureFlagOverrides = normalizeWorkspaceFeatureFlagLayer(
    mergedFeatureFlagsLayer?.workspace,
  );
  const legacyA2uiOverride =
    asBoolean(env.AGENT_ENABLE_A2UI) ??
    asBoolean(projectConfig.enableA2ui) ??
    asBoolean(userConfig.enableA2ui);
  const resolvedWorkspaceA2ui =
    workspaceFeatureFlagOverrides?.a2ui !== undefined
      ? workspaceFeatureFlagOverrides.a2ui
      : legacyA2uiOverride !== null
        ? legacyA2uiOverride
        : undefined;
  const knowledgeCutoff = supportedModel.knowledgeCutoff;

  const enableMcp =
    asBoolean(env.AGENT_ENABLE_MCP) ??
    asBoolean(projectConfig.enableMcp) ??
    asBoolean(userConfig.enableMcp) ??
    asBoolean(builtInDefaults.enableMcp) ??
    true;

  // Trust to AUTO-START a workspace's own stdio MCP servers must never be
  // grantable by the workspace itself, so this deliberately omits the
  // attacker-controlled `projectConfig` layer (.cowork/config.json). Resolve it
  // only from env + user (~/.cowork) + built-in defaults, defaulting to false so
  // a freshly opened/malicious workspace never launches local commands on its own.
  const trustWorkspaceMcp =
    asBoolean(env.AGENT_TRUST_WORKSPACE_MCP) ??
    asBoolean(userConfig.trustWorkspaceMcp) ??
    asBoolean(builtInDefaults.trustWorkspaceMcp) ??
    false;

  const enableMemory =
    asBoolean(env.AGENT_ENABLE_MEMORY) ??
    asBoolean(projectConfig.enableMemory) ??
    asBoolean(userConfig.enableMemory) ??
    asBoolean(builtInDefaults.enableMemory) ??
    true;

  const memoryRequireApproval =
    asBoolean(env.AGENT_MEMORY_REQUIRE_APPROVAL) ??
    asBoolean(projectConfig.memoryRequireApproval) ??
    asBoolean(userConfig.memoryRequireApproval) ??
    asBoolean(builtInDefaults.memoryRequireApproval) ??
    false;

  const advancedMemory =
    asBoolean(env.AGENT_ADVANCED_MEMORY) ??
    asBoolean(userConfig.advancedMemory) ??
    asBoolean(builtInDefaults.advancedMemory) ??
    false;

  // Optional global override for the headless memory-generation agent's model.
  // When unset the generator falls back to the provider-aware
  // `preferredChildModel`.
  const memoryGenerationModel =
    asNonEmptyString(env.AGENT_MEMORY_MODEL) ||
    asNonEmptyString(userConfig.memoryGenerationModel) ||
    asNonEmptyString(builtInDefaults.memoryGenerationModel) ||
    undefined;

  const includeRawChunks =
    asBoolean(env.AGENT_INCLUDE_RAW_CHUNKS) ??
    asBoolean(projectConfig.includeRawChunks) ??
    asBoolean(userConfig.includeRawChunks) ??
    asBoolean(builtInDefaults.includeRawChunks) ??
    true;

  const a2uiExperimentEnabled = isA2uiExperimentEnabled(env);
  const enableA2ui = a2uiExperimentEnabled ? (resolvedWorkspaceA2ui ?? false) : undefined;
  const openAiNativeConnectorsExperimentEnabled = isOpenAiNativeConnectorsExperimentEnabled(env);

  const backupsEnabled =
    asBoolean(env.AGENT_BACKUPS_ENABLED) ??
    asBoolean(projectConfig.backupsEnabled) ??
    asBoolean(userConfig.backupsEnabled) ??
    asBoolean(builtInDefaults.backupsEnabled) ??
    false;

  const mergedObservability = parseLayer(observabilityLayerSchema, merged.observability, {});
  const networkTelemetryDisabled = isNetworkTelemetryGloballyDisabled(env);
  const requestedObservabilityEnabled =
    asBoolean(env.AGENT_OBSERVABILITY_ENABLED) ??
    asBoolean(projectConfig.observabilityEnabled) ??
    asBoolean(userConfig.observabilityEnabled) ??
    asBoolean(builtInDefaults.observabilityEnabled) ??
    false;
  const observabilityEnabled = networkTelemetryDisabled ? false : requestedObservabilityEnabled;
  const observabilityRecordPayloads = asBoolean(env.AGENT_OBSERVABILITY_RECORD_PAYLOADS);
  const observabilityRecordInputs = networkTelemetryDisabled
    ? false
    : (asBoolean(env.AGENT_OBSERVABILITY_RECORD_INPUTS) ??
      observabilityRecordPayloads ??
      asBoolean(mergedObservability.recordInputs) ??
      false);
  const observabilityRecordOutputs = networkTelemetryDisabled
    ? false
    : (asBoolean(env.AGENT_OBSERVABILITY_RECORD_OUTPUTS) ??
      observabilityRecordPayloads ??
      asBoolean(mergedObservability.recordOutputs) ??
      false);
  const langfuseBaseUrl = (
    env.LANGFUSE_BASE_URL ||
    mergedObservability.baseUrl ||
    "https://cloud.langfuse.com"
  ).replace(/\/+$/, "");
  const langfusePublicKey = networkTelemetryDisabled
    ? undefined
    : env.LANGFUSE_PUBLIC_KEY || mergedObservability.publicKey;
  const langfuseSecretKey = networkTelemetryDisabled
    ? undefined
    : env.LANGFUSE_SECRET_KEY || mergedObservability.secretKey;
  const langfuseTracingEnvironment = networkTelemetryDisabled
    ? undefined
    : env.LANGFUSE_TRACING_ENVIRONMENT || mergedObservability.tracingEnvironment;
  const langfuseRelease = networkTelemetryDisabled
    ? undefined
    : env.LANGFUSE_RELEASE || mergedObservability.release;

  const observability: AgentConfig["observability"] = {
    provider: "langfuse",
    baseUrl: langfuseBaseUrl,
    otelEndpoint: `${langfuseBaseUrl}/api/public/otel/v1/traces`,
    ...(langfusePublicKey ? { publicKey: langfusePublicKey } : {}),
    ...(langfuseSecretKey ? { secretKey: langfuseSecretKey } : {}),
    ...(langfuseTracingEnvironment ? { tracingEnvironment: langfuseTracingEnvironment } : {}),
    ...(langfuseRelease ? { release: langfuseRelease } : {}),
    recordInputs: observabilityRecordInputs,
    recordOutputs: observabilityRecordOutputs,
  };

  const mergedHarness = parseLayer(harnessLayerSchema, merged.harness, {});
  const harness = {
    reportOnly: asBoolean(env.AGENT_HARNESS_REPORT_ONLY) ?? mergedHarness.reportOnly ?? true,
    strictMode: asBoolean(env.AGENT_HARNESS_STRICT_MODE) ?? mergedHarness.strictMode ?? false,
  };

  const command = parseCommandConfig((merged as Record<string, unknown>).command);
  const disableBuiltInSkills = asBoolean(env.COWORK_DISABLE_BUILTIN_SKILLS) ?? false;

  const normalizedProviderOptions = mergeProviderOptionDefaults(
    provider,
    supportedModel.id,
    providerOptions as Record<string, any> | undefined,
  );

  const mergedModelSettings = parseLayer(
    modelSettingsLayerSchema,
    (merged as Record<string, unknown>).modelSettings,
    {},
  );
  const maxRetries =
    normalizeNonNegativeInt(env.AGENT_MODEL_MAX_RETRIES) ?? mergedModelSettings.maxRetries;
  const normalizedModelSettings: AgentConfig["modelSettings"] =
    typeof maxRetries === "number" ? { maxRetries } : undefined;

  return {
    provider,
    runtime,
    sandbox,
    model: supportedModel.id,
    preferredChildModel: normalizedChildRouting.preferredChildModel,
    childModelRoutingMode: normalizedChildRouting.childModelRoutingMode,
    preferredChildModelRef: normalizedChildRouting.preferredChildModelRef,
    allowedChildModelRefs: normalizedChildRouting.allowedChildModelRefs,
    toolOutputOverflowChars,
    inheritedToolOutputOverflowChars,
    ...(projectToolOutputOverflowChars !== undefined
      ? {
          projectConfigOverrides: {
            toolOutputOverflowChars: projectToolOutputOverflowChars,
          },
        }
      : {}),
    workingDirectory,
    outputDirectory,
    uploadsDirectory,
    userName,
    userProfile,
    knowledgeCutoff,

    projectCoworkDir,
    projectMemoryDir,
    projectMemoryDbPath,
    memoriesDir: coworkPaths.memoriesDir,
    userCoworkDir,
    workspaceAgentsDir,
    userAgentsDir,
    workspacePluginsDir,
    userPluginsDir,
    builtInDir,
    builtInConfigDir,

    skillsDirs: [
      path.join(projectCoworkDir, "skills"),
      coworkPaths.skillsDir,
      ...(disableBuiltInSkills ? [] : [path.join(builtInDir, "skills")]),
    ],
    memoryDirs: [projectMemoryDir, path.join(userCoworkDir, "memory")],
    configDirs: [projectCoworkDir, userConfigDir, builtInConfigDir],

    enableMcp,
    trustWorkspaceMcp,
    enableMemory,
    memoryRequireApproval,
    advancedMemory,
    ...(memoryGenerationModel ? { memoryGenerationModel } : {}),
    includeRawChunks,
    experimentalFeatures: {
      a2ui: a2uiExperimentEnabled,
      openAiNativeConnectors: openAiNativeConnectorsExperimentEnabled,
    },
    ...(enableA2ui !== undefined ? { enableA2ui } : {}),
    backupsEnabled,
    observabilityEnabled,
    observability,
    harness,
    command,
    ...(a2uiExperimentEnabled && resolvedWorkspaceA2ui !== undefined
      ? {
          featureFlags: {
            workspace: {
              a2ui: resolvedWorkspaceA2ui,
            },
          },
        }
      : {}),
    ...(normalizedProviderOptions ? { providerOptions: normalizedProviderOptions } : {}),
    ...(normalizedModelSettings ? { modelSettings: normalizedModelSettings } : {}),
  };
}

export function getModel(config: AgentConfig, id?: string) {
  const modelId = id || config.model;
  const normalizedModelId = normalizeModelIdForProvider(
    config.provider,
    modelId,
    id ? "model override" : "model",
  );
  const savedKey = getSavedProviderApiKey(config, config.provider);
  return getModelForProvider(config, normalizedModelId, savedKey);
}
