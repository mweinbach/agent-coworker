import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { writeJson } from "./metadata";

export const RECOVERY_DIRECTORY_PREFIX = ".restore-rollback-";

export async function workspaceRecoveryFailureReason(
  workingDirectory: string,
): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(workingDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const recoveryDirectories = entries
    .filter(
      (entry) =>
        entry.name.startsWith(RECOVERY_DIRECTORY_PREFIX) &&
        (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => path.join(workingDirectory, entry.name))
    .sort();
  if (recoveryDirectories.length === 0) return;
  return `Recovery required: a previous restore left retained files in ${recoveryDirectories.join(", ")}. Open the recovery folder and review or copy its files to a safe location (journaled recoveries store them in files/). Remove the recovery folder only after saving what you need, then retry. Further backup changes are blocked; no recovery is applied automatically.`;
}

export async function writeRecoveryJournal(
  directory: string,
  workingDirectory: string,
  entries: string[],
  phase: "moving" | "restoring" | "complete",
): Promise<void> {
  await writeJson(path.join(directory, "recovery.json"), {
    version: 1,
    kind: "workspace-restore-recovery",
    workingDirectory,
    entries,
    phase,
    updatedAt: new Date().toISOString(),
  });
}
