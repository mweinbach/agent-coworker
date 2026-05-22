import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getAiCoworkerPaths, writeConnectionStore } from "../../src/connect";
import { createAskTool } from "../../src/tools/ask";
import { __internal as bashInternal, createBashTool } from "../../src/tools/bash";
import type { ToolContext } from "../../src/tools/context";
import { createEditTool } from "../../src/tools/edit";
import { createGlobTool } from "../../src/tools/glob";
import { createGrepTool } from "../../src/tools/grep";
import { createTools, listSessionToolNames } from "../../src/tools/index";
import { createMemoryTool } from "../../src/tools/memory";
import { createNotebookEditTool } from "../../src/tools/notebookEdit";
import { createReadTool } from "../../src/tools/read";
import { createSkillTool } from "../../src/tools/skill";
import { createTodoWriteTool, currentTodos, onTodoChange } from "../../src/tools/todoWrite";
import { createWebFetchTool, __internal as webFetchInternal } from "../../src/tools/webFetch";
import { createWebSearchTool } from "../../src/tools/webSearch";
import { createWriteTool } from "../../src/tools/write";
import type { AgentConfig } from "../../src/types";
import { __internal as webSafetyInternal } from "../../src/utils/webSafety";

export type { AgentConfig, ToolContext };
export {
  afterEach,
  bashInternal,
  beforeEach,
  createAskTool,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createMemoryTool,
  createNotebookEditTool,
  createReadTool,
  createSkillTool,
  createTodoWriteTool,
  createTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  currentTodos,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  mock,
  onTodoChange,
  os,
  path,
  test,
  webFetchInternal,
  webSafetyInternal,
  writeConnectionStore,
  z,
};

export async function withEnv<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[key];
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];

  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

export async function withAuthHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnv("HOME", homeDir, async () => await run());
}

export function makeConfig(dir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  const userCoworkDir = overrides.userCoworkDir ?? path.join(dir, ".agent-user");
  const authHomeDir = path.dirname(userCoworkDir);
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir,
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: overrides.skillsDirs ?? [path.join(authHomeDir, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

export function makeCtx(dir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: makeConfig(dir),
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    shellPolicy: "full",
    ...overrides,
  };
}

export async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-test-"));
}
