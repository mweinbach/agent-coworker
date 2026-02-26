import type { Database } from "bun:sqlite";

import type { SessionDbRepository } from "./repository";

const BASE_SCHEMA_MIGRATION = 1;
const LEGACY_IMPORT_MIGRATION = 2;

type BootstrapSessionDbOptions = {
  db: Database;
  busyTimeoutMs: number;
  repository: Pick<SessionDbRepository, "createBaseSchema" | "markMigration" | "getAppliedMigrationVersions">;
  importLegacySnapshots: () => Promise<void>;
};

export async function bootstrapSessionDb(opts: BootstrapSessionDbOptions): Promise<void> {
  opts.db.exec("PRAGMA journal_mode=WAL;");
  opts.db.exec("PRAGMA synchronous=NORMAL;");
  opts.db.exec("PRAGMA foreign_keys=ON;");
  opts.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(opts.busyTimeoutMs))};`);

  opts.db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  const appliedMigrations = opts.repository.getAppliedMigrationVersions();

  if (!appliedMigrations.has(BASE_SCHEMA_MIGRATION)) {
    opts.repository.createBaseSchema();
    opts.repository.markMigration(BASE_SCHEMA_MIGRATION);
  }

  if (!appliedMigrations.has(LEGACY_IMPORT_MIGRATION)) {
    await opts.importLegacySnapshots();
    opts.repository.markMigration(LEGACY_IMPORT_MIGRATION);
  }
}
