import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";

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
    case "openai":
      return "gpt-5.2";
    case "anthropic":
      // Keep this conservative; users can override via /model or config/env.
      return "claude-opus-4-6";
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
  if (v === "google" || v === "openai" || v === "anthropic") return v;
  return null;
}

function resolveDir(maybeRelative: unknown, baseDir: string): string {
  if (typeof maybeRelative !== "string" || !maybeRelative) return baseDir;
  if (path.isAbsolute(maybeRelative)) return maybeRelative;
  return path.join(baseDir, maybeRelative);
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
  };
}

export function getModel(config: AgentConfig, id?: string) {
  const modelId = id || config.model;
  switch (config.provider) {
    case "google":
      return google(modelId);
    case "openai":
      return openai(modelId);
    case "anthropic":
      return anthropic(modelId);
    default: {
      const _exhaustive: never = config.provider;
      return _exhaustive;
    }
  }
}
