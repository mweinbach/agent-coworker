import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { getAiCoworkerPaths } from "./connect";
import { parseConnectionStoreJson } from "./store/connections";
import { defaultModelForProvider, getModelForProvider, getProviderKeyCandidates } from "./providers";
import { resolveProviderName } from "./types";
import type { AgentConfig, CommandTemplateConfig, ProviderName } from "./types";

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

function parseCommandConfig(raw: unknown): AgentConfig["command"] | undefined {
  if (raw === undefined) return undefined;

  const parsedRaw = commandConfigSchema.safeParse(raw);
  if (!parsedRaw.success) {
    throw new Error(`Invalid command config: ${parsedRaw.error.issues[0]?.message ?? "validation_failed"}`);
  }

  if (Object.keys(parsedRaw.data).length === 0) return undefined;
  return parsedRaw.data;
}

function resolveBuiltInDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function parseLayer<T>(schema: z.ZodType<T>, raw: unknown, fallback: T): T {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

function asProviderName(v: unknown): ProviderName | null {
  return resolveProviderName(v);
}

function asString(v: unknown): string | undefined {
  const parsed = stringSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
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

function resolveUserHomeFromConfig(config: AgentConfig): string {
  if (typeof config.userAgentDir === "string" && config.userAgentDir) {
    return path.dirname(config.userAgentDir);
  }
  return os.homedir();
}

function readSavedApiKey(config: AgentConfig, provider: ProviderName): string | undefined {
  const home = resolveUserHomeFromConfig(config);
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

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AgentConfig> {
  const cwd = options.cwd ?? process.cwd();
  const homedir = options.homedir ?? os.homedir();
  const builtInDir = options.builtInDir ?? resolveBuiltInDir();
  const env = options.env ?? process.env;

  const projectAgentDir = path.join(cwd, ".agent");
  const userAgentDir = path.join(homedir, ".agent");
  const builtInConfigDir = path.join(builtInDir, "config");
  const coworkPaths = getAiCoworkerPaths({ homedir });

  const builtInDefaults = await loadJsonSafe(path.join(builtInConfigDir, "defaults.json"));
  const userConfig = await loadJsonSafe(path.join(userAgentDir, "config.json"));
  const projectConfig = await loadJsonSafe(path.join(projectAgentDir, "config.json"));

  const merged = deepMerge(deepMerge(builtInDefaults, userConfig), projectConfig);

  const provider =
    asProviderName(env.AGENT_PROVIDER) ??
    asProviderName(projectConfig.provider) ??
    asProviderName(userConfig.provider) ??
    asProviderName(builtInDefaults.provider) ??
    "google";

  const workingDirectory = env.AGENT_WORKING_DIR || cwd;

  const model =
    asNonEmptyString(env.AGENT_MODEL) ||
    asNonEmptyString(projectConfig.model) ||
    asNonEmptyString(userConfig.model) ||
    (asProviderName(builtInDefaults.provider) === provider && asNonEmptyString(builtInDefaults.model)) ||
    defaultModelForProvider(provider);

  const subAgentModel =
    asNonEmptyString(projectConfig.subAgentModel) ||
    asNonEmptyString(userConfig.subAgentModel) ||
    asNonEmptyString(builtInDefaults.subAgentModel) ||
    model;

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
    asNonEmptyString(env.AGENT_USER_NAME) ||
    asNonEmptyString(projectConfig.userName) ||
    asNonEmptyString(userConfig.userName) ||
    asString(builtInDefaults.userName) ||
    "";
  const knowledgeCutoff =
    asNonEmptyString(projectConfig.knowledgeCutoff) ||
    asNonEmptyString(userConfig.knowledgeCutoff) ||
    asNonEmptyString(builtInDefaults.knowledgeCutoff) ||
    "unknown";

  const enableMcp =
    asBoolean(env.AGENT_ENABLE_MCP) ??
    asBoolean(projectConfig.enableMcp) ??
    asBoolean(userConfig.enableMcp) ??
    asBoolean(builtInDefaults.enableMcp) ??
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
  const providerOptions = isPlainObject((merged as Record<string, unknown>).providerOptions)
    ? (deepMerge({}, (merged as Record<string, unknown>).providerOptions as Record<string, unknown>) as Record<string, any>)
    : undefined;

  const mergedModelSettings = parseLayer(modelSettingsLayerSchema, (merged as Record<string, unknown>).modelSettings, {});
  const maxRetries = normalizeNonNegativeInt(env.AGENT_MODEL_MAX_RETRIES) ?? mergedModelSettings.maxRetries;
  const normalizedModelSettings: AgentConfig["modelSettings"] =
    typeof maxRetries === "number" ? { maxRetries } : undefined;

  return {
    provider,
    model,
    subAgentModel,
    workingDirectory,
    outputDirectory,
    uploadsDirectory,
    userName,
    knowledgeCutoff,

    projectAgentDir,
    userAgentDir,
    builtInDir,
    builtInConfigDir,

    skillsDirs: [
      path.join(projectAgentDir, "skills"),
      // Global/shared skills live under ~/.cowork/skills.
      path.join(coworkPaths.rootDir, "skills"),
      path.join(userAgentDir, "skills"),
      path.join(builtInDir, "skills"),
    ],
    memoryDirs: [path.join(projectAgentDir, "memory"), path.join(userAgentDir, "memory")],
    configDirs: [projectAgentDir, userAgentDir, builtInConfigDir],

    enableMcp,
    observabilityEnabled,
    observability,
    harness,
    command,
    ...(providerOptions ? { providerOptions } : {}),
    ...(normalizedModelSettings ? { modelSettings: normalizedModelSettings } : {}),
  };
}

export function getModel(config: AgentConfig, id?: string) {
  const modelId = id || config.model;
  const savedKey = readSavedApiKey(config, config.provider);
  return getModelForProvider(config, modelId, savedKey);
}
