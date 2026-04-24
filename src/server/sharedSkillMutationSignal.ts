import fs from "node:fs/promises";
import path from "node:path";

import { writeTextFileAtomic } from "../utils/atomicFile";

const SHARED_SKILL_MUTATION_SIGNAL_FILE = "shared-skill-mutation.json";

export type SharedSkillMutationSignal = {
  revision: string;
  pid: number;
  at: string;
};

export function resolveSharedSkillMutationSignalPath(userAgentDir: string): string {
  return path.join(userAgentDir, SHARED_SKILL_MUTATION_SIGNAL_FILE);
}

export async function readSharedSkillMutationSignal(
  signalPath: string,
): Promise<SharedSkillMutationSignal | null> {
  try {
    const raw = await fs.readFile(signalPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SharedSkillMutationSignal>;
    if (
      typeof parsed.revision !== "string" ||
      parsed.revision.trim().length === 0 ||
      typeof parsed.pid !== "number" ||
      !Number.isFinite(parsed.pid) ||
      typeof parsed.at !== "string" ||
      parsed.at.trim().length === 0
    ) {
      return null;
    }
    return {
      revision: parsed.revision,
      pid: parsed.pid,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

export async function writeSharedSkillMutationSignal(
  signalPath: string,
  signal: SharedSkillMutationSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(signalPath), { recursive: true });
  await writeTextFileAtomic(signalPath, `${JSON.stringify(signal, null, 2)}\n`);
}
