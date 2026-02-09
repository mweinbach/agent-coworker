import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentConfig } from "../../src/types";
export { DEFAULT_PROVIDER_OPTIONS } from "../../src/providers";

export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..");
}

export async function writeJson(p: string, obj: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf-8");
}

export async function withEnv(
  key: string,
  value: string | undefined,
  run: () => Promise<void> | void
) {
  const prev = process.env[key];
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];

  try {
    await run();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

export async function makeTmpDirs() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-provider-"));
  const cwd = path.join(tmp, "project");
  const home = path.join(tmp, "home");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { tmp, cwd, home };
}

export function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dir = os.tmpdir();
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    subAgentModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}
