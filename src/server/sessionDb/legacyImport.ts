import fs from "node:fs/promises";
import path from "node:path";

import { parsePersistedSessionSnapshot, type PersistedSessionSnapshot } from "../sessionStore";

type ImportLegacySnapshotsOptions = {
  sessionsDir: string;
  importSnapshot: (snapshot: PersistedSessionSnapshot) => void;
};

export async function importLegacySnapshots(opts: ImportLegacySnapshotsOptions): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(opts.sessionsDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(opts.sessionsDir, entry);
    const raw = await fs.readFile(filePath, "utf-8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in legacy session snapshot ${filePath}: ${String(error)}`);
    }
    const snapshot = parsePersistedSessionSnapshot(parsedJson);
    opts.importSnapshot(snapshot);
  }
}
