import type { Database } from "bun:sqlite";

import type { SessionDbRepository } from "./repository";

const BASE_SCHEMA_MIGRATION = 1;
const LEGACY_IMPORT_MIGRATION = 2;
const PROVIDER_STATE_MIGRATION = 3;
const SUBAGENT_METADATA_MIGRATION = 4;
const MODEL_STREAM_CHUNKS_MIGRATION = 5;
const COST_TRACKER_MIGRATION = 6;
const BACKUPS_ENABLED_OVERRIDE_MIGRATION = 7;
const AGENT_REALIGNMENT_MIGRATION = 8;
const PROVIDER_OPTIONS_MIGRATION = 9;
const SESSION_SNAPSHOTS_MIGRATION = 10;
const THREAD_JOURNAL_MIGRATION = 11;
const AGENT_TASK_METADATA_MIGRATION = 12;
const RESEARCH_TABLE_MIGRATION = 13;
const RESEARCH_PLAN_COLUMNS_MIGRATION = 14;
const RESEARCH_WORKSPACE_COLUMN_MIGRATION = 15;
const AGENT_PROFILE_METADATA_MIGRATION = 16;
const LAST_MEMORY_GENERATED_INDEX_MIGRATION = 17;
const SANDBOX_CONFIG_MIGRATION = 18;
const TASK_MODE_MIGRATION = 19;
const TASK_ARTIFACT_VERSIONS_MIGRATION = 20;
const TASK_QUESTIONS_MIGRATION = 21;
const TASK_CREATION_MIGRATION = 22;
const TASK_REVIEW_STATE_MIGRATION = 23;

function sql(lines: readonly string[]): string {
  return lines.join(String.fromCharCode(10));
}

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
    | "addCostTrackerColumn"
    | "addBackupsEnabledOverrideColumn"
    | "addProviderOptionsColumn"
    | "addSandboxColumn"
    | "addSessionSnapshotsTable"
    | "addThreadJournalEventsTable"
    | "addAgentTaskMetadataColumns"
    | "addResearchTable"
    | "addResearchPlanColumns"
    | "addResearchWorkspaceColumn"
    | "addAgentProfileMetadataColumn"
    | "addLastMemoryGeneratedIndexColumn"
    | "addTaskModeTables"
    | "addTaskArtifactVersionTables"
    | "addTaskQuestionTables"
    | "addTaskCreationColumns"
    | "addTaskReviewTables"
  >;
  importLegacySnapshots: () => Promise<void>;
};

export async function bootstrapSessionDb(opts: BootstrapSessionDbOptions): Promise<void> {
  opts.db.exec("PRAGMA journal_mode=WAL;");
  opts.db.exec("PRAGMA synchronous=NORMAL;");
  opts.db.exec("PRAGMA foreign_keys=ON;");
  opts.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(opts.busyTimeoutMs))};`);

  opts.db.exec(
    sql([
      "CREATE TABLE IF NOT EXISTS schema_migrations (",
      "  version INTEGER PRIMARY KEY,",
      "  applied_at TEXT NOT NULL",
      ")",
    ]),
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

  if (!appliedMigrations.has(COST_TRACKER_MIGRATION)) {
    opts.repository.addCostTrackerColumn();
    opts.repository.markMigration(COST_TRACKER_MIGRATION);
  }

  if (!appliedMigrations.has(BACKUPS_ENABLED_OVERRIDE_MIGRATION)) {
    opts.repository.addBackupsEnabledOverrideColumn();
    opts.repository.markMigration(BACKUPS_ENABLED_OVERRIDE_MIGRATION);
  }

  if (!appliedMigrations.has(AGENT_REALIGNMENT_MIGRATION)) {
    opts.repository.addSubagentMetadataColumns();
    opts.repository.markMigration(AGENT_REALIGNMENT_MIGRATION);
  }

  if (!appliedMigrations.has(PROVIDER_OPTIONS_MIGRATION)) {
    opts.repository.addProviderOptionsColumn();
    opts.repository.markMigration(PROVIDER_OPTIONS_MIGRATION);
  }

  if (!appliedMigrations.has(SESSION_SNAPSHOTS_MIGRATION)) {
    opts.repository.addSessionSnapshotsTable();
    opts.repository.markMigration(SESSION_SNAPSHOTS_MIGRATION);
  }

  if (!appliedMigrations.has(THREAD_JOURNAL_MIGRATION)) {
    opts.repository.addThreadJournalEventsTable();
    opts.repository.markMigration(THREAD_JOURNAL_MIGRATION);
  }

  if (!appliedMigrations.has(AGENT_TASK_METADATA_MIGRATION)) {
    opts.repository.addAgentTaskMetadataColumns();
    opts.repository.markMigration(AGENT_TASK_METADATA_MIGRATION);
  }

  if (!appliedMigrations.has(RESEARCH_TABLE_MIGRATION)) {
    opts.repository.addResearchTable();
    opts.repository.markMigration(RESEARCH_TABLE_MIGRATION);
  }

  if (!appliedMigrations.has(RESEARCH_PLAN_COLUMNS_MIGRATION)) {
    opts.repository.addResearchPlanColumns();
    opts.repository.markMigration(RESEARCH_PLAN_COLUMNS_MIGRATION);
  }

  if (!appliedMigrations.has(RESEARCH_WORKSPACE_COLUMN_MIGRATION)) {
    opts.repository.addResearchWorkspaceColumn();
    opts.repository.markMigration(RESEARCH_WORKSPACE_COLUMN_MIGRATION);
  }

  if (!appliedMigrations.has(AGENT_PROFILE_METADATA_MIGRATION)) {
    opts.repository.addAgentProfileMetadataColumn();
    opts.repository.markMigration(AGENT_PROFILE_METADATA_MIGRATION);
  }

  if (!appliedMigrations.has(LAST_MEMORY_GENERATED_INDEX_MIGRATION)) {
    opts.repository.addLastMemoryGeneratedIndexColumn();
    opts.repository.markMigration(LAST_MEMORY_GENERATED_INDEX_MIGRATION);
  }

  if (!appliedMigrations.has(SANDBOX_CONFIG_MIGRATION)) {
    opts.repository.addSandboxColumn();
    opts.repository.markMigration(SANDBOX_CONFIG_MIGRATION);
  }

  if (!appliedMigrations.has(TASK_MODE_MIGRATION)) {
    opts.repository.addTaskModeTables();
    opts.repository.markMigration(TASK_MODE_MIGRATION);
  }

  if (!appliedMigrations.has(TASK_ARTIFACT_VERSIONS_MIGRATION)) {
    opts.repository.addTaskArtifactVersionTables();
    opts.repository.markMigration(TASK_ARTIFACT_VERSIONS_MIGRATION);
  }

  if (!appliedMigrations.has(TASK_QUESTIONS_MIGRATION)) {
    opts.repository.addTaskQuestionTables();
    opts.repository.markMigration(TASK_QUESTIONS_MIGRATION);
  }

  if (!appliedMigrations.has(TASK_CREATION_MIGRATION)) {
    opts.repository.addTaskCreationColumns();
    opts.repository.markMigration(TASK_CREATION_MIGRATION);
  }

  if (!appliedMigrations.has(TASK_REVIEW_STATE_MIGRATION)) {
    opts.repository.addTaskReviewTables();
    opts.repository.markMigration(TASK_REVIEW_STATE_MIGRATION);
  }

  if (!appliedMigrations.has(LEGACY_IMPORT_MIGRATION)) {
    await opts.importLegacySnapshots();
    opts.repository.markMigration(LEGACY_IMPORT_MIGRATION);
  }
}
