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
    let snapshot: PersistedSessionSnapshot;
    try {
      const parsedJson = JSON.parse(raw);
      snapshot = parsePersistedSessionSnapshot(parsedJson);
    } catch {
      continue;
    }

    opts.importSnapshot(snapshot);
  }
}
