import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getAiCoworkerPaths } from "../../connect";

type CliState = {
  version: 1;
  lastSessionByCwd: Record<string, string>;
};

const cliStateSchema = z.object({
  version: z.literal(1),
  lastSessionByCwd: z.record(z.string().trim().min(1), z.string().trim().min(1)),
}).strict();

function getCliStateFilePath(): string {
  const paths = getAiCoworkerPaths();
  return path.join(paths.rootDir, "state", "cli-state.json");
}

async function readCliState(): Promise<CliState> {
  const filePath = getCliStateFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsedRaw = JSON.parse(raw);
    const parsedState = cliStateSchema.safeParse(parsedRaw);
    if (!parsedState.success) {
      throw new Error(`Invalid CLI state schema: ${parsedState.error.issues[0]?.message ?? "validation_failed"}`);
    }

    const normalized: Record<string, string> = {};
    for (const [cwd, sessionId] of Object.entries(parsedState.data.lastSessionByCwd)) {
      normalized[path.resolve(cwd)] = sessionId;
    }
    return {
      version: 1,
      lastSessionByCwd: normalized,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { version: 1, lastSessionByCwd: {} };
    throw new Error(`Failed to read CLI state: ${String(error)}`);
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
