import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAiCoworkerPaths } from "./connect";
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveBuiltInDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function asProviderName(v: unknown): ProviderName | null {
  return resolveProviderName(v);
}

function asBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "y" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n" || s === "off") return false;
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || !v.trim()) return null;
  const parsed = Number(v);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function resolveDir(maybeRelative: unknown, baseDir: string): string {
  if (typeof maybeRelative !== "string" || !maybeRelative) return baseDir;
  if (path.isAbsolute(maybeRelative)) return maybeRelative;
  return path.join(baseDir, maybeRelative);
}

function parseCommandConfig(raw: unknown): AgentConfig["command"] | undefined {
  if (!isPlainObject(raw)) return undefined;
  const commands: Record<string, CommandTemplateConfig> = {};

  for (const [nameRaw, value] of Object.entries(raw)) {
    const name = nameRaw.trim();
    if (!name || !isPlainObject(value)) continue;

    const template = typeof value.template === "string" ? value.template : "";
    if (!template.trim()) continue;

    const description = typeof value.description === "string" ? value.description : undefined;
    const source =
      value.source === "command" || value.source === "mcp" || value.source === "skill"
        ? value.source
        : "command";

    commands[name] = {
      description,
      source,
      template,
    };
  }

  if (Object.keys(commands).length === 0) return undefined;
  return commands;
}

function normalizePositiveInt(v: unknown): number | undefined {
  const n = asNumber(v);
  if (n === null) return undefined;
  const i = Math.floor(n);
  if (!Number.isFinite(i) || i <= 0) return undefined;
  return i;
}

function normalizeNonNegativeInt(v: unknown): number | undefined {
  const n = asNumber(v);
  if (n === null) return undefined;
  const i = Math.floor(n);
  if (!Number.isFinite(i) || i < 0) return undefined;
  return i;
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
  const legacyConnectionsPath = path.join(home, ".ai-coworker", "config", "connections.json");

  const keyCandidates = getProviderKeyCandidates(provider);

  const connectionFiles = [paths.connectionsFile, legacyConnectionsPath];
  for (const connectionsPath of connectionFiles) {
    try {
      const raw = fsSync.readFileSync(connectionsPath, "utf-8");
      const parsed = JSON.parse(raw) as any;

      for (const candidate of keyCandidates) {
        const direct = parsed?.services?.[candidate];
        const directKey =
          typeof direct?.apiKey === "string" && direct.apiKey.trim() ? direct.apiKey.trim() : "";
        if (directKey) return directKey;
      }

      // Backward-compatible fallback for any simpler shape like { apiKeys: { openai: "..." } }.
      for (const candidate of keyCandidates) {
        const legacy = parsed?.apiKeys?.[candidate];
        if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
      }
    } catch {
      // continue to fallback file (or default to env below)
    }
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
    env.AGENT_MODEL ||
    (typeof projectConfig.model === "string" && projectConfig.model) ||
    (typeof userConfig.model === "string" && userConfig.model) ||
    (typeof builtInDefaults.model === "string" &&
      builtInDefaults.model &&
      asProviderName(builtInDefaults.provider) === provider &&
      builtInDefaults.model) ||
    defaultModelForProvider(provider);

  const subAgentModel =
    (typeof projectConfig.subAgentModel === "string" && projectConfig.subAgentModel) ||
    (typeof userConfig.subAgentModel === "string" && userConfig.subAgentModel) ||
    (typeof builtInDefaults.subAgentModel === "string" && builtInDefaults.subAgentModel) ||
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
    env.AGENT_USER_NAME ||
    (typeof projectConfig.userName === "string" && projectConfig.userName) ||
    (typeof userConfig.userName === "string" && userConfig.userName) ||
    (typeof builtInDefaults.userName === "string" ? builtInDefaults.userName : "");
  const knowledgeCutoff =
    (typeof projectConfig.knowledgeCutoff === "string" && projectConfig.knowledgeCutoff) ||
    (typeof userConfig.knowledgeCutoff === "string" && userConfig.knowledgeCutoff) ||
    (typeof builtInDefaults.knowledgeCutoff === "string" && builtInDefaults.knowledgeCutoff) ||
    "unknown";

  const enableMcp =
    asBoolean(env.AGENT_ENABLE_MCP) ??
    asBoolean(projectConfig.enableMcp) ??
    asBoolean(userConfig.enableMcp) ??
    asBoolean(builtInDefaults.enableMcp) ??
    true;

  const mergedObservability = isPlainObject(merged.observability) ? merged.observability : {};
  const observabilityEnabled =
    asBoolean(env.AGENT_OBSERVABILITY_ENABLED) ??
    asBoolean(projectConfig.observabilityEnabled) ??
    asBoolean(userConfig.observabilityEnabled) ??
    asBoolean(builtInDefaults.observabilityEnabled) ??
    true;
  const langfuseBaseUrl = (
    env.LANGFUSE_BASE_URL ||
    asNonEmptyString(mergedObservability["baseUrl"]) ||
    "https://cloud.langfuse.com"
  ).replace(/\/+$/, "");
  const langfusePublicKey = env.LANGFUSE_PUBLIC_KEY || asNonEmptyString(mergedObservability["publicKey"]);
  const langfuseSecretKey = env.LANGFUSE_SECRET_KEY || asNonEmptyString(mergedObservability["secretKey"]);
  const langfuseTracingEnvironment =
    env.LANGFUSE_TRACING_ENVIRONMENT || asNonEmptyString(mergedObservability["tracingEnvironment"]);
  const langfuseRelease = env.LANGFUSE_RELEASE || asNonEmptyString(mergedObservability["release"]);

  const observability: AgentConfig["observability"] = {
    provider: "langfuse",
    baseUrl: langfuseBaseUrl,
    otelEndpoint: `${langfuseBaseUrl}/api/public/otel/v1/traces`,
    ...(langfusePublicKey ? { publicKey: langfusePublicKey } : {}),
    ...(langfuseSecretKey ? { secretKey: langfuseSecretKey } : {}),
    ...(langfuseTracingEnvironment ? { tracingEnvironment: langfuseTracingEnvironment } : {}),
    ...(langfuseRelease ? { release: langfuseRelease } : {}),
  };

  const mergedHarness = isPlainObject(merged.harness) ? merged.harness : {};
  const harness = {
    reportOnly:
      asBoolean(env.AGENT_HARNESS_REPORT_ONLY) ??
      asBoolean(mergedHarness["reportOnly"]) ??
      true,
    strictMode:
      asBoolean(env.AGENT_HARNESS_STRICT_MODE) ??
      asBoolean(mergedHarness["strictMode"]) ??
      false,
  };

  const command = parseCommandConfig((merged as Record<string, unknown>).command);
  const providerOptions = isPlainObject((merged as Record<string, unknown>).providerOptions)
    ? (deepMerge({}, (merged as Record<string, unknown>).providerOptions as Record<string, unknown>) as Record<string, any>)
    : undefined;

  const mergedModelSettings = isPlainObject((merged as Record<string, unknown>).modelSettings)
    ? ((merged as Record<string, unknown>).modelSettings as Record<string, unknown>)
    : {};

  const modelSettings: AgentConfig["modelSettings"] = {
    ...(normalizeNonNegativeInt(env.AGENT_MODEL_MAX_RETRIES) !== undefined
      ? { maxRetries: normalizeNonNegativeInt(env.AGENT_MODEL_MAX_RETRIES) }
      : normalizeNonNegativeInt(mergedModelSettings.maxRetries) !== undefined
        ? { maxRetries: normalizeNonNegativeInt(mergedModelSettings.maxRetries) }
        : {}),
  };
  const normalizedModelSettings: AgentConfig["modelSettings"] =
    typeof modelSettings.maxRetries === "number"
      ? {
          ...(typeof modelSettings.maxRetries === "number" ? { maxRetries: modelSettings.maxRetries } : {}),
        }
      : undefined;

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
