import fs from "node:fs/promises";
import path from "node:path";

import { getAiCoworkerPaths } from "../../connect";

type CliState = {
  version: 1;
  lastSessionByCwd: Record<string, string>;
};

function getCliStateFilePath(): string {
  const paths = getAiCoworkerPaths();
  return path.join(paths.rootDir, "state", "cli-state.json");
}

async function readCliState(): Promise<CliState> {
  const filePath = getCliStateFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const map = typeof parsed.lastSessionByCwd === "object" && parsed.lastSessionByCwd
      ? parsed.lastSessionByCwd as Record<string, unknown>
      : {};
    const normalized: Record<string, string> = {};
    for (const [cwd, sessionId] of Object.entries(map)) {
      if (typeof cwd !== "string" || !cwd.trim()) continue;
      if (typeof sessionId !== "string" || !sessionId.trim()) continue;
      normalized[path.resolve(cwd)] = sessionId.trim();
    }
    return {
      version: 1,
      lastSessionByCwd: normalized,
    };
  } catch {
    return { version: 1, lastSessionByCwd: {} };
  }
}

async function persistCliState(state: CliState): Promise<void> {
  const filePath = getCliStateFilePath();
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, payload, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

export async function getStoredSessionForCwd(cwd: string): Promise<string | null> {
  const state = await readCliState();
  const key = path.resolve(cwd);
  const sessionId = state.lastSessionByCwd[key];
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

export async function setStoredSessionForCwd(cwd: string, sessionId: string): Promise<void> {
  const sid = sessionId.trim();
  if (!sid) return;
  const state = await readCliState();
  state.lastSessionByCwd[path.resolve(cwd)] = sid;
  await persistCliState(state);
}
