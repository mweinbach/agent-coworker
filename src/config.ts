import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { getAiCoworkerPaths } from "./connect";
import { parseConnectionStoreJson } from "./store/connections";
import { getModelForProvider, getProviderKeyCandidates } from "./providers";
import { DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS } from "./shared/toolOutputOverflow";
import {
  normalizeRuntimeNameForProvider,
  resolveChildModelRoutingMode,
  resolveProviderName,
  resolveRuntimeName as resolveRuntimeNameFromValue,
} from "./types";
import type { AgentConfig, CommandTemplateConfig, ProviderName, RuntimeName } from "./types";
import { resolveAuthHomeDir } from "./utils/authHome";
import { defaultSupportedModel, getSupportedModel } from "./models/registry";
import { normalizeChildRoutingConfig } from "./models/childModelRouting";
import {
  getResolvedModelMetadataSync,
  isDynamicModelProvider,
  normalizeModelIdForProvider,
  resolveDefaultModelMetadata,
  resolveModelMetadata,
} from "./models/metadata";

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
  z.string().trim().transform((raw, ctx) => {
    const normalized = raw.toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y" || normalized === "on") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "n" || normalized === "off") {
      return false;
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_boolean" });
    return z.NEVER;
  }),
]);
const numberLikeSchema = z.union([
  finiteNumberSchema,
  z.string().trim().min(1).transform((raw, ctx) => {
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
  const current = isPlainObject(providerOptions) ? deepMerge({}, providerOptions) as Record<string, any> : undefined;
  const currentProviderOptions =
    current && isPlainObject(current[provider]) ? current[provider] as Record<string, unknown> : undefined;
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
) {
  if (isDynamicModelProvider(provider)) {
    return await resolveModelMetadata(provider, modelId, {
      allowPlaceholder: provider === "lmstudio",
      providerOptions,
      env,
      source,
      log: (line) => console.warn(`[config] ${line}`),
    });
  }
  const supported = getSupportedModel(provider, modelId);
  if (supported) return supported;
  const fallback = defaultSupportedModel(provider);
  console.warn(
    `[config] Ignoring unsupported ${source} "${modelId}" for provider ${provider}; using "${fallback.id}".`
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

const commandTemplateSchema = z.object({
  template: z.string().trim().min(1),
  description: z.string().optional(),
  source: z.enum(["command", "mcp", "skill"]),
}).strict();

const commandConfigSchema = z.record(z.string().trim().min(1), commandTemplateSchema).transform((rawCommands) => {
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
const observabilityLayerSchema = z.object({
  baseUrl: nonEmptyTrimmedStringSchema.optional(),
  publicKey: nonEmptyTrimmedStringSchema.optional(),
  secretKey: nonEmptyTrimmedStringSchema.optional(),
  tracingEnvironment: nonEmptyTrimmedStringSchema.optional(),
  release: nonEmptyTrimmedStringSchema.optional(),
}).passthrough();
const harnessLayerSchema = z.object({
  reportOnly: booleanLikeSchema.optional(),
  strictMode: booleanLikeSchema.optional(),
}).passthrough();
const modelSettingsLayerSchema = z.object({
  maxRetries: nonNegativeIntegerLikeSchema.optional(),
}).passthrough();
const userProfileLayerSchema = z.object({
  instructions: z.string().optional(),
  work: z.string().optional(),
  details: z.string().optional(),
}).passthrough();

function parseCommandConfig(raw: unknown): AgentConfig["command"] | undefined {
  if (raw === undefined) return undefined;

  const parsedRaw = commandConfigSchema.safeParse(raw);
  if (!parsedRaw.success) {
    throw new Error(`Invalid command config: ${parsedRaw.error.issues[0]?.message ?? "validation_failed"}`);
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

function asNonEmptyString(v: unknown): string | undefined {
  const parsed = nonEmptyTrimmedStringSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

function resolveDir(maybeRelative: unknown, baseDir: string): string {
  const parsed = stringSchema.safeParse(maybeRelative);
  if (!parsed.success || !parsed.data) return baseDir;
  if (path.isAbsolute(parsed.data)) return parsed.data;
  return path.join(baseDir, parsed.data);
}

function normalizeNonNegativeInt(v: unknown): number | undefined {
  const parsed = nonNegativeIntegerLikeSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

function normalizeNullableNonNegativeInt(v: unknown): number | null | undefined {
  if (v === null) return null;
  return normalizeNonNegativeInt(v);
}

export function getSavedProviderApiKeyForHome(home: string, provider: ProviderName): string | undefined {
  const paths = getAiCoworkerPaths({ homedir: home });
  const keyCandidates = getProviderKeyCandidates(provider);

  let raw: string;
  try {
    raw = fsSync.readFileSync(paths.connectionsFile, "utf-8");
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return undefined;
    throw new Error(`Failed to read connection store at ${paths.connectionsFile}: ${String(error)}`);
  }

  const parsedStore = parseConnectionStoreJson(raw, paths.connectionsFile);

  for (const candidate of keyCandidates) {
    const direct = parsedStore.services[candidate];
    if (direct?.mode === "api_key" && direct.apiKey) return direct.apiKey;
  }

  return undefined;
}

export function getSavedProviderApiKey(config: AgentConfig, provider: ProviderName): string | undefined {
  return getSavedProviderApiKeyForHome(resolveAuthHomeDir(config), provider);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AgentConfig> {
  const cwd = options.cwd ?? process.cwd();
  const homedir = options.homedir ?? os.homedir();
  const env = options.env ?? process.env;
  const builtInDir = options.builtInDir ?? resolveBuiltInDir(env);

  const projectAgentDir = path.join(cwd, ".agent");
  const userAgentDir = path.join(homedir, ".agent");
  const builtInConfigDir = path.join(builtInDir, "config");
  const coworkPaths = getAiCoworkerPaths({ homedir });

  const builtInDefaults = await loadJsonSafe(path.join(builtInConfigDir, "defaults.json"));
  const userConfig = await loadJsonSafe(path.join(userAgentDir, "config.json"));
  const projectConfig = await loadJsonSafe(path.join(projectAgentDir, "config.json"));

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
  const awsBedrockProxyBaseUrl =
    asNonEmptyString(env.AWS_BEDROCK_PROXY_BASE_URL) ||
    asNonEmptyString(env.OPENAI_PROXY_BASE_URL) ||
    asNonEmptyString(projectConfig.awsBedrockProxyBaseUrl) ||
    asNonEmptyString(projectConfig.openaiProxyBaseUrl) ||
    asNonEmptyString(userConfig.awsBedrockProxyBaseUrl) ||
    asNonEmptyString(userConfig.openaiProxyBaseUrl) ||
    asNonEmptyString(builtInDefaults.awsBedrockProxyBaseUrl) ||
    asNonEmptyString(builtInDefaults.openaiProxyBaseUrl);

  const providerOptions = isPlainObject((merged as Record<string, unknown>).providerOptions)
    ? (deepMerge({}, (merged as Record<string, unknown>).providerOptions as Record<string, unknown>) as Record<string, unknown>)
    : undefined;
  if (providerOptions) {
    const legacyAwsOptions = providerOptions["openai-proxy"];
    if (legacyAwsOptions !== undefined && providerOptions["aws-bedrock-proxy"] === undefined) {
      providerOptions["aws-bedrock-proxy"] = legacyAwsOptions;
    }
    delete providerOptions["openai-proxy"];
  }

  const configuredModel =
    asNonEmptyString(env.AGENT_MODEL) ||
    asNonEmptyString(projectConfig.model) ||
    asNonEmptyString(userConfig.model) ||
    (asProviderName(builtInDefaults.provider) === provider && asNonEmptyString(builtInDefaults.model));
  const supportedModel = configuredModel
    ? await resolveConfiguredModelMetadata(provider, configuredModel, "model", providerOptions, env)
    : await resolveDefaultModelMetadata(provider, { providerOptions, env });

  const childModelRoutingMode =
    resolveChildModelRoutingMode(projectConfig.childModelRoutingMode) ||
    resolveChildModelRoutingMode(userConfig.childModelRoutingMode) ||
    resolveChildModelRoutingMode(builtInDefaults.childModelRoutingMode) ||
    "same-provider";
  const rawAllowedChildModelRefs =
    (Array.isArray(projectConfig.allowedChildModelRefs) ? projectConfig.allowedChildModelRefs : undefined) ||
    (Array.isArray(userConfig.allowedChildModelRefs) ? userConfig.allowedChildModelRefs : undefined) ||
    (Array.isArray(builtInDefaults.allowedChildModelRefs) ? builtInDefaults.allowedChildModelRefs : undefined);
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
      allowedChildModelRefs: rawAllowedChildModelRefs?.filter((value): value is string => typeof value === "string"),
      source: "config",
    });
  } catch (error) {
    console.warn(`[config] Ignoring invalid child model routing config: ${String(error)}`);
  }

  const parsedToolOutputOverflowChars = normalizeNullableNonNegativeInt(
    (merged as Record<string, unknown>).toolOutputOverflowChars
  );
  const inheritedToolOutputOverflowCharsRaw = normalizeNullableNonNegativeInt(
    (inheritedMerged as Record<string, unknown>).toolOutputOverflowChars
  );
  const projectToolOutputOverflowChars = normalizeNullableNonNegativeInt(projectConfig.toolOutputOverflowChars);
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

  const userName = asTrimmedString(env.AGENT_USER_NAME) ?? asTrimmedString((merged as Record<string, unknown>).userName) ?? "";
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
  const knowledgeCutoff = supportedModel.knowledgeCutoff;

  const enableMcp =
    asBoolean(env.AGENT_ENABLE_MCP) ??
    asBoolean(projectConfig.enableMcp) ??
    asBoolean(userConfig.enableMcp) ??
    asBoolean(builtInDefaults.enableMcp) ??
    true;

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

  const includeRawChunks =
    asBoolean(env.AGENT_INCLUDE_RAW_CHUNKS) ??
    asBoolean(projectConfig.includeRawChunks) ??
    asBoolean(userConfig.includeRawChunks) ??
    asBoolean(builtInDefaults.includeRawChunks) ??
    true;

  const backupsEnabled =
    asBoolean(env.AGENT_BACKUPS_ENABLED) ??
    asBoolean(projectConfig.backupsEnabled) ??
    asBoolean(userConfig.backupsEnabled) ??
    asBoolean(builtInDefaults.backupsEnabled) ??
    true;

  const mergedObservability = parseLayer(observabilityLayerSchema, merged.observability, {});
  const observabilityEnabled =
    asBoolean(env.AGENT_OBSERVABILITY_ENABLED) ??
    asBoolean(projectConfig.observabilityEnabled) ??
    asBoolean(userConfig.observabilityEnabled) ??
    asBoolean(builtInDefaults.observabilityEnabled) ??
    true;
  const langfuseBaseUrl = (
    env.LANGFUSE_BASE_URL ||
    mergedObservability.baseUrl ||
    "https://cloud.langfuse.com"
  ).replace(/\/+$/, "");
  const langfusePublicKey = env.LANGFUSE_PUBLIC_KEY || mergedObservability.publicKey;
  const langfuseSecretKey = env.LANGFUSE_SECRET_KEY || mergedObservability.secretKey;
  const langfuseTracingEnvironment =
    env.LANGFUSE_TRACING_ENVIRONMENT || mergedObservability.tracingEnvironment;
  const langfuseRelease = env.LANGFUSE_RELEASE || mergedObservability.release;

  const observability: AgentConfig["observability"] = {
    provider: "langfuse",
    baseUrl: langfuseBaseUrl,
    otelEndpoint: `${langfuseBaseUrl}/api/public/otel/v1/traces`,
    ...(langfusePublicKey ? { publicKey: langfusePublicKey } : {}),
    ...(langfuseSecretKey ? { secretKey: langfuseSecretKey } : {}),
    ...(langfuseTracingEnvironment ? { tracingEnvironment: langfuseTracingEnvironment } : {}),
    ...(langfuseRelease ? { release: langfuseRelease } : {}),
  };

  const mergedHarness = parseLayer(harnessLayerSchema, merged.harness, {});
  const harness = {
    reportOnly:
      asBoolean(env.AGENT_HARNESS_REPORT_ONLY) ??
      mergedHarness.reportOnly ??
      true,
    strictMode:
      asBoolean(env.AGENT_HARNESS_STRICT_MODE) ??
      mergedHarness.strictMode ??
      false,
  };

  const command = parseCommandConfig((merged as Record<string, unknown>).command);
  const disableBuiltInSkills = asBoolean(env.COWORK_DISABLE_BUILTIN_SKILLS) ?? false;

  const normalizedProviderOptions = mergeProviderOptionDefaults(
    provider,
    supportedModel.id,
    providerOptions as Record<string, any> | undefined,
  );

  const mergedModelSettings = parseLayer(modelSettingsLayerSchema, (merged as Record<string, unknown>).modelSettings, {});
  const maxRetries = normalizeNonNegativeInt(env.AGENT_MODEL_MAX_RETRIES) ?? mergedModelSettings.maxRetries;
  const normalizedModelSettings: AgentConfig["modelSettings"] =
    typeof maxRetries === "number" ? { maxRetries } : undefined;

  return {
    provider,
    runtime,
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

    projectAgentDir,
    userAgentDir,
    builtInDir,
    builtInConfigDir,

    skillsDirs: [
      path.join(projectAgentDir, "skills"),
      coworkPaths.skillsDir,
      path.join(userAgentDir, "skills"),
      ...(disableBuiltInSkills ? [] : [path.join(builtInDir, "skills")]),
    ],
    memoryDirs: [path.join(projectAgentDir, "memory"), path.join(userAgentDir, "memory")],
    configDirs: [projectAgentDir, userAgentDir, builtInConfigDir],

    enableMcp,
    enableMemory,
    memoryRequireApproval,
    includeRawChunks,
    backupsEnabled,
    observabilityEnabled,
    observability,
    harness,
    command,
    ...(awsBedrockProxyBaseUrl ? { awsBedrockProxyBaseUrl, openaiProxyBaseUrl: awsBedrockProxyBaseUrl } : {}),
    ...(normalizedProviderOptions ? { providerOptions: normalizedProviderOptions } : {}),
    ...(normalizedModelSettings ? { modelSettings: normalizedModelSettings } : {}),
  };
}

export function getModel(config: AgentConfig, id?: string) {
  const modelId = id || config.model;
  const normalizedModelId = normalizeModelIdForProvider(config.provider, modelId, id ? "model override" : "model");
  const savedKey = getSavedProviderApiKey(config, config.provider);
  return getModelForProvider(config, normalizedModelId, savedKey);
}
