import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { claudeCode, createClaudeCode } from "ai-sdk-provider-claude-code";
import { codexCli, createCodexCli } from "ai-sdk-provider-codex-cli";
import { createGeminiProvider } from "ai-sdk-provider-gemini-cli";

import { isProviderName } from "./types";
import type { AgentConfig, ProviderName } from "./types";

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

export function defaultModelForProvider(provider: ProviderName): string {
  switch (provider) {
    case "google":
      return "gemini-3-flash-preview";
    case "gemini-cli":
      return "gemini-3-flash-preview";
    case "openai":
      return "gpt-5.2";
    case "codex-cli":
      return "gpt-5.2-codex";
    case "anthropic":
      // Keep this conservative; users can override via /model or config/env.
      return "claude-opus-4-6";
    case "claude-code":
      return "sonnet";
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
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
  if (isProviderName(v)) return v;
  return null;
}

function asBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "y" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n" || s === "off") return false;
  return null;
}

function resolveDir(maybeRelative: unknown, baseDir: string): string {
  if (typeof maybeRelative !== "string" || !maybeRelative) return baseDir;
  if (path.isAbsolute(maybeRelative)) return maybeRelative;
  return path.join(baseDir, maybeRelative);
}

function resolveUserHomeFromConfig(config: AgentConfig): string {
  if (typeof config.userAgentDir === "string" && config.userAgentDir) {
    return path.dirname(config.userAgentDir);
  }
  return os.homedir();
}

function readSavedApiKey(config: AgentConfig, provider: ProviderName): string | undefined {
  const home = resolveUserHomeFromConfig(config);
  const connectionsPath = path.join(home, ".ai-coworker", "config", "connections.json");

  const keyCandidates: readonly ProviderName[] =
    provider === "gemini-cli"
      ? [provider, "google"]
      : provider === "codex-cli"
        ? [provider, "openai"]
        : provider === "claude-code"
          ? [provider, "anthropic"]
          : [provider];

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
    // Missing/invalid file means no saved key; fall back to provider defaults (.env).
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
  const outputDirectory = resolveDir(
    env.AGENT_OUTPUT_DIR ||
      projectConfig.outputDirectory ||
      userConfig.outputDirectory ||
      builtInDefaults.outputDirectory ||
      "output",
    cwd
  );
  const uploadsDirectory = resolveDir(
    env.AGENT_UPLOADS_DIR ||
      projectConfig.uploadsDirectory ||
      userConfig.uploadsDirectory ||
      builtInDefaults.uploadsDirectory ||
      "uploads",
    cwd
  );

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
      path.join(userAgentDir, "skills"),
      path.join(builtInDir, "skills"),
    ],
    memoryDirs: [path.join(projectAgentDir, "memory"), path.join(userAgentDir, "memory")],
    configDirs: [projectAgentDir, userAgentDir, builtInConfigDir],

    enableMcp,
  };
}

export function getModel(config: AgentConfig, id?: string) {
  const modelId = id || config.model;
  const savedKey = readSavedApiKey(config, config.provider);

  switch (config.provider) {
    case "google": {
      const provider = savedKey ? createGoogleGenerativeAI({ apiKey: savedKey }) : google;
      return provider(modelId);
    }
    case "openai": {
      const provider = savedKey ? createOpenAI({ apiKey: savedKey }) : openai;
      return provider(modelId);
    }
    case "anthropic": {
      const provider = savedKey ? createAnthropic({ apiKey: savedKey }) : anthropic;
      return provider(modelId);
    }
    case "gemini-cli": {
      const envKey = savedKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const provider = envKey
        ? createGeminiProvider({
            authType: "api-key",
            apiKey: envKey,
          })
        : createGeminiProvider({
            authType: "oauth-personal",
          });
      return provider(modelId);
    }
    case "codex-cli": {
      const envKey = savedKey || process.env.OPENAI_API_KEY;
      const provider = envKey
        ? createCodexCli({
            defaultSettings: {
              env: {
                OPENAI_API_KEY: envKey,
              },
            },
          })
        : codexCli;
      return provider(modelId);
    }
    case "claude-code": {
      const envKey = savedKey || process.env.ANTHROPIC_API_KEY;
      const provider = envKey
        ? createClaudeCode({
            defaultSettings: {
              env: {
                ANTHROPIC_API_KEY: envKey,
              },
            },
          })
        : claudeCode;
      return provider(modelId);
    }
    default: {
      const _exhaustive: never = config.provider;
      return _exhaustive;
    }
  }
}
