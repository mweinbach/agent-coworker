import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getAiCoworkerPaths } from "../../connect";

type CliState = {
  version: 1;
  lastSessionByCwd: Record<string, string>;
};

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();
const cliStateSchema = z.object({
  version: z.literal(1),
  lastSessionByCwd: z.record(nonEmptyTrimmedStringSchema, nonEmptyTrimmedStringSchema).transform((raw) => {
    const normalized: Record<string, string> = {};
    for (const [cwd, sessionId] of Object.entries(raw)) {
      normalized[path.resolve(cwd)] = sessionId;
    }
    return normalized;
  }),
}).strict();

function getCliStateFilePath(): string {
  const home = process.env.HOME?.trim();
  const paths = home ? getAiCoworkerPaths({ homedir: home }) : getAiCoworkerPaths();
  return path.join(paths.rootDir, "state", "cli-state.json");
}

async function readCliState(): Promise<CliState> {
  const filePath = getCliStateFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      return { version: 1, lastSessionByCwd: {} };
    }

    const parsedState = cliStateSchema.safeParse(parsedRaw);
    if (!parsedState.success) {
      return { version: 1, lastSessionByCwd: {} };
    }
    return parsedState.data;
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
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
  const sessionId = nonEmptyTrimmedStringSchema.safeParse(state.lastSessionByCwd[key]);
  return sessionId.success ? sessionId.data : null;
}

export async function setStoredSessionForCwd(cwd: string, sessionId: string): Promise<void> {
  const sid = nonEmptyTrimmedStringSchema.safeParse(sessionId);
  if (!sid.success) return;
  const state = await readCliState();
  state.lastSessionByCwd[path.resolve(cwd)] = sid.data;
  await persistCliState(state);
}
