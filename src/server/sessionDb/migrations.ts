import type { Database } from "bun:sqlite";

import type { SessionDbRepository } from "./repository";

const BASE_SCHEMA_MIGRATION = 1;
const LEGACY_IMPORT_MIGRATION = 2;
const PROVIDER_STATE_MIGRATION = 3;
const SUBAGENT_METADATA_MIGRATION = 4;
const MODEL_STREAM_CHUNKS_MIGRATION = 5;

type BootstrapSessionDbOptions = {
  db: Database;
  busyTimeoutMs: number;
  repository: Pick<
    SessionDbRepository,
    | "createBaseSchema"
    | "markMigration"
    | "getAppliedMigrationVersions"
    | "addProviderStateColumn"
    | "addSubagentMetadataColumns"
    | "addModelStreamChunksTable"
  >;
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

  if (!appliedMigrations.has(PROVIDER_STATE_MIGRATION)) {
    opts.repository.addProviderStateColumn();
    opts.repository.markMigration(PROVIDER_STATE_MIGRATION);
  }

  if (!appliedMigrations.has(SUBAGENT_METADATA_MIGRATION)) {
    opts.repository.addSubagentMetadataColumns();
    opts.repository.markMigration(SUBAGENT_METADATA_MIGRATION);
  }

  if (!appliedMigrations.has(MODEL_STREAM_CHUNKS_MIGRATION)) {
    opts.repository.addModelStreamChunksTable();
    opts.repository.markMigration(MODEL_STREAM_CHUNKS_MIGRATION);
  }

  if (!appliedMigrations.has(LEGACY_IMPORT_MIGRATION)) {
    await opts.importLegacySnapshots();
    opts.repository.markMigration(LEGACY_IMPORT_MIGRATION);
  }
}
