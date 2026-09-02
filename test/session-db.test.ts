import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type PersistedSessionMutation, SessionDb } from "../src/server/sessionDb";
import type { AgentProfileSnapshot } from "../src/shared/agentProfiles";
import type { SessionSnapshot } from "../src/shared/sessionSnapshot";

async function makeTmpCoworkHome(prefix = "session-db-test-"): Promise<{
  rootDir: string;
  sessionsDir: string;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { rootDir, sessionsDir };
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: "s-1",
    title: "Session One",
    titleSource: "default",
    titleModel: null,
    provider: "google",
    model: "gemini-3-flash-preview",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: null,
    nickname: null,
    taskType: null,
    targetPaths: null,
    profile: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: "hello",
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:01.000Z",
    messageCount: 1,
    lastEventSeq: 1,
    feed: [
      {
        id: "item-1",
        kind: "message",
        role: "user",
        ts: "2026-03-19T00:00:00.000Z",
        text: "hello",
      },
    ],
    agents: [],
    workflowRuns: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
    ...overrides,
  };
}

function makeAgentProfileSnapshot(): AgentProfileSnapshot {
  return {
    id: "qa-reviewer",
    ref: "workspace:qa-reviewer",
    scope: "workspace",
    displayName: "QA Reviewer",
    description: "Checks completed work.",
    baseRole: "reviewer",
    prompt: "Report concrete defects only.",
    allowedBuiltInTools: ["read", "grep"],
    allowedMcpServers: ["github"],
    skillNames: ["code-review"],
    model: "gpt-5-mini",
    reasoningEffort: "high",
    defaultTaskType: "verify",
    defaultContextMode: "brief",
    resolvedAt: "2026-06-02T12:00:00.000Z",
  };
}

function makeSessionMutation(
  sessionId: string,
  parentSessionId: string | null = null,
): PersistedSessionMutation {
  const now = "2026-09-01T12:00:00.000Z";
  return {
    sessionId,
    eventType: "session.created",
    snapshot: {
      sessionKind: parentSessionId ? "agent" : "root",
      parentSessionId,
      role: parentSessionId ? "worker" : null,
      title: sessionId,
      titleSource: "default",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      workingDirectory: "/tmp/project",
      enableMcp: false,
      backupsEnabledOverride: null,
      createdAt: now,
      updatedAt: now,
      status: "active",
      hasPendingAsk: false,
      hasPendingApproval: false,
      systemPrompt: "system",
      messages: [{ role: "user", content: `Hello from ${sessionId}` }],
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  };
}

async function persistDeletionFixture(db: SessionDb): Promise<void> {
  for (const [sessionId, parentSessionId] of [
    ["root", null],
    ["child", "root"],
    ["grandchild", "child"],
    ["unrelated", null],
  ] as const) {
    const mutation = makeSessionMutation(sessionId, parentSessionId);
    await db.persistSessionMutation(mutation);
    await db.persistSessionSnapshot(sessionId, makeSnapshot({ sessionId }));
    await db.appendThreadJournalEvent({
      threadId: sessionId,
      ts: mutation.snapshot.updatedAt,
      eventType: "item.completed",
      turnId: null,
      itemId: null,
      requestId: null,
      payload: { text: `Conversation content for ${sessionId}` },
    });
    await db.recordThreadJournalFailure({
      threadId: sessionId,
      failedWriteCount: 1,
      droppedEventCount: 1,
      lastFailureAt: mutation.snapshot.updatedAt,
      lastFailureMessage: "previous failure",
    });
    await db.setThreadMetadata({ threadId: sessionId, pinned: true });
    await db.rememberThreadCreationKey(`creation-${sessionId}`, sessionId);
  }
}

describe("sessionDb", () => {
  test("rejects anonymous in-memory databases because committed-reader isolation needs a durable path", async () => {
    const paths = await makeTmpCoworkHome();

    await expect(SessionDb.create({ paths, dbPath: ":memory:" })).rejects.toThrow(
      "anonymous in-memory databases cannot provide committed-reader isolation",
    );
  });

  test("leaves retired research migrations unapplied when their schema does not exist", async () => {
    const paths = await makeTmpCoworkHome();
    const dbPath = path.join(paths.rootDir, "sessions.db");
    const db = await SessionDb.create({ paths });
    try {
      const inspectDb = new Database(dbPath, { create: false, strict: false });
      try {
        expect(
          inspectDb
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research'")
            .get(),
        ).toBeNull();
        expect(
          inspectDb
            .query("SELECT version FROM schema_migrations WHERE version IN (13, 14, 15)")
            .all(),
        ).toEqual([]);
      } finally {
        inspectDb.close();
      }
    } finally {
      db.close();
    }

    const incorrectlyMarkedDb = new Database(dbPath, { create: false, strict: false });
    try {
      const markMigration = incorrectlyMarkedDb.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (const version of [13, 14, 15]) {
        markMigration.run(version, "2026-04-07T17:16:57.053Z");
      }
    } finally {
      incorrectlyMarkedDb.close();
    }

    const reopened = await SessionDb.create({ paths });
    try {
      const inspectDb = new Database(dbPath, { create: false, strict: false });
      try {
        expect(
          inspectDb
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research'")
            .get(),
        ).toBeNull();
        expect(
          inspectDb
            .query("SELECT version FROM schema_migrations WHERE version IN (13, 14, 15)")
            .all(),
        ).toEqual([]);
      } finally {
        inspectDb.close();
      }
    } finally {
      reopened.close();
    }
  });

  test("preserves legacy research rows and leaves unapplied upgrades available to older builds", async () => {
    const paths = await makeTmpCoworkHome();
    const dbPath = path.join(paths.rootDir, "sessions.db");
    const seededAt = "2026-04-07T17:16:57.053Z";
    const initialDb = await SessionDb.create({ paths });
    initialDb.close();

    const legacyDb = new Database(dbPath, { create: false, strict: false });
    try {
      legacyDb.exec(
        `CREATE TABLE research (
           id TEXT PRIMARY KEY,
           parent_research_id TEXT NULL REFERENCES research(id) ON DELETE SET NULL,
           title TEXT NOT NULL,
           prompt TEXT NOT NULL,
           status TEXT NOT NULL,
           interaction_id TEXT NULL,
           last_event_id TEXT NULL,
           inputs_json TEXT NOT NULL,
           settings_json TEXT NOT NULL,
           outputs_markdown TEXT NOT NULL,
           thought_summaries_json TEXT NOT NULL,
           sources_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           error TEXT NULL
         );
         CREATE INDEX idx_research_status_updated ON research(status, updated_at DESC);
         CREATE INDEX idx_research_parent_updated ON research(parent_research_id, updated_at DESC);`,
      );
      legacyDb
        .query(
          `INSERT INTO research (
             id, title, prompt, status, inputs_json, settings_json, outputs_markdown,
             thought_summaries_json, sources_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "legacy-research",
          "Saved research",
          "Preserve this research",
          "completed",
          "{}",
          "{}",
          "Saved findings",
          "[]",
          "[]",
          seededAt,
          seededAt,
        );
      const markMigration = legacyDb.query(
        "INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (const version of [13, 14, 15]) {
        markMigration.run(version, seededAt);
      }
    } finally {
      legacyDb.close();
    }

    const upgraded = await SessionDb.create({ paths });
    try {
      const inspectDb = new Database(dbPath, { create: false, strict: false });
      try {
        expect(
          inspectDb
            .query("SELECT version FROM schema_migrations WHERE version IN (13, 14, 15)")
            .all(),
        ).toEqual([{ version: 13 }]);
        expect(inspectDb.query("SELECT id, title FROM research").get()).toEqual({
          id: "legacy-research",
          title: "Saved research",
        });
        const researchColumns = (
          inspectDb.query("PRAGMA table_info(research)").all() as Array<Record<string, unknown>>
        ).map((row) => String(row.name));
        expect(researchColumns).not.toContain("plan_pending");
        expect(researchColumns).not.toContain("workspace_path");
      } finally {
        inspectDb.close();
      }
    } finally {
      upgraded.close();
    }

    const downgradedDb = new Database(dbPath, { create: false, strict: false });
    try {
      downgradedDb.exec(
        `ALTER TABLE research ADD COLUMN plan_pending INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE research ADD COLUMN workspace_path TEXT NULL;
         CREATE INDEX idx_research_workspace_updated ON research(workspace_path, updated_at DESC);`,
      );
      const markMigration = downgradedDb.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (const version of [14, 15]) {
        markMigration.run(version, seededAt);
      }
    } finally {
      downgradedDb.close();
    }

    const reopened = await SessionDb.create({ paths });
    try {
      const inspectDb = new Database(dbPath, { create: false, strict: false });
      try {
        expect(
          inspectDb
            .query("SELECT version FROM schema_migrations WHERE version IN (13, 14, 15)")
            .all(),
        ).toEqual([{ version: 13 }, { version: 14 }, { version: 15 }]);
        expect(inspectDb.query("SELECT id, title FROM research").get()).toEqual({
          id: "legacy-research",
          title: "Saved research",
        });
      } finally {
        inspectDb.close();
      }
    } finally {
      reopened.close();
    }
  });

  test("persists/lists/deletes sessions with canonical state", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "s-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Session One",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/project",
          providerOptions: {
            openai: {
              reasoningEffort: "high",
              reasoningSummary: "detailed",
            },
          },
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }],
          lastMemoryGeneratedIndex: 1,
          providerState: {
            provider: "openai",
            model: "gpt-5.2",
            responseId: "resp_123",
            updatedAt: now,
          },
          todos: [],
          harnessContext: null,
          costTracker: {
            sessionId: "s-1",
            totalTurns: 1,
            totalPromptTokens: 100,
            totalCompletionTokens: 40,
            totalTokens: 140,
            estimatedTotalCostUsd: 0.0025,
            costTrackingAvailable: true,
            byModel: [],
            turns: [],
            budgetStatus: {
              configured: true,
              warnAtUsd: 5,
              stopAtUsd: 10,
              warningTriggered: false,
              stopTriggered: false,
              currentCostUsd: 0.0025,
            },
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("s-1");
      expect(sessions[0]?.messageCount).toBe(1);

      const paged = db.getMessages("s-1", 0, 10);
      expect(paged.total).toBe(1);
      expect(paged.messages).toHaveLength(1);

      const persisted = db.getSessionRecord("s-1");
      expect(persisted?.sessionId).toBe("s-1");
      expect(persisted?.lastEventSeq).toBe(1);
      expect(persisted?.providerState).toEqual({
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_123",
        updatedAt: now,
      });
      expect(persisted?.providerOptions).toEqual({
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
        },
      });
      expect(persisted?.lastMemoryGeneratedIndex).toBe(1);
      expect(persisted?.costTracker).toEqual({
        sessionId: "s-1",
        totalTurns: 1,
        totalPromptTokens: 100,
        totalCompletionTokens: 40,
        totalTokens: 140,
        estimatedTotalCostUsd: 0.0025,
        costTrackingAvailable: true,
        byModel: [],
        turns: [],
        budgetStatus: {
          configured: true,
          warnAtUsd: 5,
          stopAtUsd: 10,
          warningTriggered: false,
          stopTriggered: false,
          currentCostUsd: 0.0025,
        },
        createdAt: now,
        updatedAt: now,
      });

      await db.deleteSession("s-1");
      expect(db.getSessionRecord("s-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("recovers a corrupted file database with a working committed reader and can reopen after close", async () => {
    const paths = await makeTmpCoworkHome();
    const dbPath = path.join(paths.rootDir, "sessions.db");
    await fs.writeFile(dbPath, "not a sqlite database", "utf-8");

    const recovered = await SessionDb.create({ paths });
    try {
      expect(recovered.listSessions()).toEqual([]);
      const now = new Date().toISOString();
      await recovered.persistSessionMutation({
        sessionId: "recovered-session",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Recovered Session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello after recovery" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      expect(recovered.getSessionRecord("recovered-session")?.title).toBe("Recovered Session");
      expect(recovered.getMessages("recovered-session").total).toBe(1);
    } finally {
      recovered.close();
    }

    const rootEntries = await fs.readdir(paths.rootDir);
    expect(rootEntries.some((entry) => entry.startsWith("sessions.db.corrupt."))).toBe(true);

    const reopened = await SessionDb.create({ paths });
    try {
      expect(reopened.getSessionRecord("recovered-session")?.title).toBe("Recovered Session");
    } finally {
      reopened.close();
    }
  });

  test("preserves the original database when corruption quarantine fails", async () => {
    const paths = await makeTmpCoworkHome();
    const dbPath = path.join(paths.rootDir, "sessions.db");
    const originalContents = "damaged database bytes that must remain recoverable";
    await fs.writeFile(dbPath, originalContents);
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("quarantine unavailable"));
    let recovered: SessionDb | undefined;
    try {
      await expect(
        SessionDb.create({ paths }).then((db) => {
          recovered = db;
          return db;
        }),
      ).rejects.toThrow("quarantine unavailable");
      expect(await fs.readFile(dbPath, "utf-8")).toBe(originalContents);
    } finally {
      recovered?.close();
      rename.mockRestore();
      await fs.rm(path.dirname(paths.rootDir), { recursive: true, force: true });
    }
  });

  test("backfills late-added agent task metadata columns for existing session dbs", async () => {
    const paths = await makeTmpCoworkHome();
    const dbPath = path.join(paths.rootDir, "sessions.db");
    const seededAt = "2026-04-07T17:16:57.053Z";
    const seedDb = new Database(dbPath, { create: true, strict: false });
    try {
      seedDb.exec(
        `CREATE TABLE schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL
         );
         CREATE TABLE sessions (
           session_id TEXT PRIMARY KEY,
           session_kind TEXT NOT NULL DEFAULT 'root',
           parent_session_id TEXT NULL,
           role TEXT NULL,
           agent_type TEXT NULL,
           mode TEXT NULL,
           depth INTEGER NULL,
           nickname TEXT NULL,
           requested_model TEXT NULL,
           effective_model TEXT NULL,
           requested_reasoning_effort TEXT NULL,
           effective_reasoning_effort TEXT NULL,
           execution_state TEXT NULL,
           last_message_preview TEXT NULL,
           title TEXT NOT NULL,
           title_source TEXT NOT NULL,
           title_model TEXT NULL,
           provider TEXT NOT NULL,
           model TEXT NOT NULL,
           working_directory TEXT NOT NULL,
           output_directory TEXT NULL,
           uploads_directory TEXT NULL,
           enable_mcp INTEGER NOT NULL,
           backups_enabled_override INTEGER NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           status TEXT NOT NULL,
           has_pending_ask INTEGER NOT NULL,
           has_pending_approval INTEGER NOT NULL,
           message_count INTEGER NOT NULL,
           last_event_seq INTEGER NOT NULL
         );
         CREATE TABLE session_state (
           session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
           system_prompt TEXT NOT NULL,
           messages_json TEXT NOT NULL,
           provider_state_json TEXT NULL,
           provider_options_json TEXT NULL,
           todos_json TEXT NOT NULL,
           harness_context_json TEXT NULL,
           cost_tracker_json TEXT NULL
         );
         CREATE TABLE session_events (
           session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
           seq INTEGER NOT NULL,
           ts TEXT NOT NULL,
           direction TEXT NOT NULL,
           event_type TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           PRIMARY KEY(session_id, seq)
         );
         CREATE TABLE session_model_stream_chunks (
           session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
           turn_id TEXT NOT NULL,
           chunk_index INTEGER NOT NULL,
           ts TEXT NOT NULL,
           provider TEXT NOT NULL,
           model TEXT NOT NULL,
           raw_format TEXT NOT NULL,
           normalizer_version INTEGER NOT NULL,
           raw_event_json TEXT NOT NULL,
           PRIMARY KEY(session_id, turn_id, chunk_index)
         );
         CREATE TABLE session_snapshots (
           session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
           updated_at TEXT NOT NULL,
           snapshot_json TEXT NOT NULL
         );
         CREATE TABLE thread_journal_events (
           thread_id TEXT NOT NULL,
           seq INTEGER NOT NULL,
           ts TEXT NOT NULL,
           event_type TEXT NOT NULL,
           turn_id TEXT NULL,
           item_id TEXT NULL,
           request_id TEXT NULL,
           payload_json TEXT NOT NULL,
           PRIMARY KEY(thread_id, seq)
         );`,
      );
      const insertMigration = seedDb.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      for (let version = 1; version <= 11; version += 1) {
        insertMigration.run(version, seededAt);
      }
    } finally {
      seedDb.close();
    }

    const db = await SessionDb.create({ paths });
    try {
      const inspectDb = new Database(dbPath, { create: false, strict: false });
      try {
        const sessionColumns = (
          inspectDb.query("PRAGMA table_info(sessions)").all() as Array<Record<string, unknown>>
        ).map((row) => String(row.name));
        expect(sessionColumns).toContain("task_type");
        expect(sessionColumns).toContain("target_paths_json");
      } finally {
        inspectDb.close();
      }

      await db.persistSessionMutation({
        sessionId: "child-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          nickname: "verify-auth",
          taskType: "verify",
          targetPaths: ["src/auth", "test/auth"],
          profile: makeAgentProfileSnapshot(),
          title: "Child Session",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2-mini",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: seededAt,
          updatedAt: seededAt,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "child-system",
          messages: [{ role: "assistant", content: "child hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      const persisted = db.getSessionRecord("child-1");
      expect(persisted?.taskType).toBe("verify");
      expect(persisted?.targetPaths).toEqual(["src/auth", "test/auth"]);
    } finally {
      db.close();
    }
  });

  test("skips persisted rows with providers unsupported by the current build", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "root-valid",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Valid Root",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await db.persistSessionMutation({
        sessionId: "root-legacy",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Legacy Root",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "legacy" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await db.persistSessionMutation({
        sessionId: "child-valid",
        eventType: "session.created",
        snapshot: {
          sessionKind: "agent",
          parentSessionId: "root-valid",
          role: "worker",
          title: "Valid Child",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "assistant", content: "valid child" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await db.persistSessionMutation({
        sessionId: "child-legacy",
        eventType: "session.created",
        snapshot: {
          sessionKind: "agent",
          parentSessionId: "root-valid",
          role: "worker",
          title: "Legacy Child",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "assistant", content: "legacy child" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      (db as any).db
        .query("UPDATE sessions SET provider = ? WHERE session_id IN (?, ?)")
        .run("future-local", "root-legacy", "child-legacy");

      expect(
        db
          .listSessions()
          .map((session) => session.sessionId)
          .sort(),
      ).toEqual(["root-valid"]);
      expect(db.getSessionRecord("root-valid")?.provider).toBe("openai");
      expect(db.getSessionRecord("root-legacy")).toBeNull();
      expect(
        db
          .listAgentSessions("root-valid")
          .map((agent) => agent.agentId)
          .sort(),
      ).toEqual(["child-valid"]);
      expect(db.getSessionRecord("child-legacy")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("persists raw model stream chunks alongside session state", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "s-raw",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Raw Session",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/project",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      await db.persistModelStreamChunk({
        sessionId: "s-raw",
        turnId: "turn-1",
        chunkIndex: 0,
        ts: now,
        provider: "openai",
        model: "gpt-5.2",
        rawFormat: "openai-responses-v1",
        normalizerVersion: 1,
        rawEvent: {
          type: "response.output_item.added",
          item: { type: "reasoning", id: "rs_1" },
        },
      });

      expect(db.listModelStreamChunks("s-raw")).toEqual([
        {
          sessionId: "s-raw",
          turnId: "turn-1",
          chunkIndex: 0,
          ts: now,
          provider: "openai",
          model: "gpt-5.2",
          rawFormat: "openai-responses-v1",
          normalizerVersion: 1,
          rawEvent: {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_1" },
          },
        },
      ]);

      await db.persistModelStreamChunks([
        {
          sessionId: "s-raw",
          turnId: "turn-1",
          chunkIndex: 1,
          ts: now,
          provider: "openai",
          model: "gpt-5.2",
          rawFormat: "openai-responses-v1",
          normalizerVersion: 1,
          rawEvent: { type: "response.output_text.delta", delta: "hello" },
        },
        {
          sessionId: "s-raw",
          turnId: "turn-1",
          chunkIndex: 2,
          ts: now,
          provider: "openai",
          model: "gpt-5.2",
          rawFormat: "openai-responses-v1",
          normalizerVersion: 1,
          rawEvent: { type: "response.output_text.delta", delta: " world" },
        },
      ]);

      expect(db.listModelStreamChunks("s-raw").map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
    } finally {
      db.close();
    }
  });

  test("persists canonical thread journal events", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "thread-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Thread One",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.4",
          workingDirectory: "/tmp/project",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      const seq1 = await db.appendThreadJournalEvent({
        threadId: "thread-1",
        ts: now,
        eventType: "thread/started",
        turnId: null,
        itemId: null,
        requestId: null,
        payload: {
          thread: {
            id: "thread-1",
          },
        },
      });
      const seq2 = await db.appendThreadJournalEvent({
        threadId: "thread-1",
        ts: now,
        eventType: "turn/started",
        turnId: "turn-1",
        itemId: null,
        requestId: null,
        payload: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "inProgress",
            items: [],
          },
        },
      });

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(db.listThreadJournalEvents("thread-1")).toEqual([
        {
          threadId: "thread-1",
          seq: 1,
          ts: now,
          eventType: "thread/started",
          turnId: null,
          itemId: null,
          requestId: null,
          payload: {
            thread: {
              id: "thread-1",
            },
          },
        },
        {
          threadId: "thread-1",
          seq: 2,
          ts: now,
          eventType: "turn/started",
          turnId: "turn-1",
          itemId: null,
          requestId: null,
          payload: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
              items: [],
            },
          },
        },
      ]);
      expect(db.listThreadJournalEvents("thread-1", { afterSeq: 1 })).toEqual([
        {
          threadId: "thread-1",
          seq: 2,
          ts: now,
          eventType: "turn/started",
          turnId: "turn-1",
          itemId: null,
          requestId: null,
          payload: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
              items: [],
            },
          },
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("listThreadJournalEvents returns the full journal when no limit is requested", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "thread-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Thread One",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.4",
          workingDirectory: "/tmp/project",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      await db.appendThreadJournalEvents(
        Array.from({ length: 1_005 }, (_, index) => ({
          threadId: "thread-1",
          ts: now,
          eventType: "item/agentMessage/delta",
          turnId: "turn-1",
          itemId: `item-${index}`,
          requestId: null,
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: `item-${index}`,
            delta: `chunk-${index}`,
          },
        })),
      );

      expect(db.listThreadJournalEvents("thread-1")).toHaveLength(1_005);
      expect(db.listThreadJournalEvents("thread-1", { limit: 10 })).toHaveLength(10);
      expect(db.getThreadJournalTailSeq("thread-1")).toBe(1_005);
      expect(db.getThreadJournalTailSeq("missing-thread")).toBe(0);
      expect(db.listThreadJournalEvents("thread-1").at(-1)?.payload).toMatchObject({
        delta: "chunk-1004",
      });
    } finally {
      db.close();
    }
  });

  test("persists thread journal failure markers across database reopen", async () => {
    const paths = await makeTmpCoworkHome();
    const first = await SessionDb.create({ paths });
    try {
      await first.recordThreadJournalFailure({
        threadId: "thread-1",
        failedWriteCount: 2,
        droppedEventCount: 5,
        lastFailureAt: "2026-07-01T00:00:00.000Z",
        lastFailureMessage: "database is locked",
      });
      expect(first.getThreadJournalFailure("thread-1")).toEqual({
        threadId: "thread-1",
        failedWriteCount: 2,
        droppedEventCount: 5,
        lastFailureAt: "2026-07-01T00:00:00.000Z",
        lastFailureMessage: "database is locked",
      });
    } finally {
      first.close();
    }

    const reopened = await SessionDb.create({ paths });
    try {
      expect(reopened.getThreadJournalFailure("thread-1")).toEqual({
        threadId: "thread-1",
        failedWriteCount: 2,
        droppedEventCount: 5,
        lastFailureAt: "2026-07-01T00:00:00.000Z",
        lastFailureMessage: "database is locked",
      });
    } finally {
      reopened.close();
    }
  });

  test("persists thread metadata flags across database reopen", async () => {
    const paths = await makeTmpCoworkHome();
    const first = await SessionDb.create({ paths });
    try {
      await first.setThreadMetadata({
        threadId: "thread-1",
        pinned: true,
        archived: true,
        updatedAt: "2026-07-02T00:00:00.000Z",
      });
      await first.setThreadMetadata({
        threadId: "thread-2",
        pinned: false,
        archived: true,
        updatedAt: "2026-07-03T00:00:00.000Z",
      });
      expect(first.getThreadMetadata("thread-1")).toEqual({
        threadId: "thread-1",
        pinned: true,
        pinnedAt: "2026-07-02T00:00:00.000Z",
        archived: true,
        archivedAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });
    } finally {
      first.close();
    }

    const reopened = await SessionDb.create({ paths });
    try {
      expect(
        reopened
          .listThreadMetadata()
          .map((entry) => entry.threadId)
          .sort(),
      ).toEqual(["thread-1", "thread-2"]);
      await reopened.setThreadMetadata({
        threadId: "thread-1",
        archived: false,
        updatedAt: "2026-07-04T00:00:00.000Z",
      });
      expect(reopened.getThreadMetadata("thread-1")).toMatchObject({
        pinned: true,
        pinnedAt: "2026-07-02T00:00:00.000Z",
        archived: false,
        archivedAt: null,
      });
    } finally {
      reopened.close();
    }
  });

  test("filters listed sessions by working directory and persists materialized snapshots", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "workspace-a",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Workspace A",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/workspace-a",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello a" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await db.persistSessionMutation({
        sessionId: "workspace-b",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Workspace B",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.4",
          workingDirectory: "/tmp/workspace-b",
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello b" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      const persistedSnapshot = makeSnapshot({
        sessionId: "workspace-a",
        title: "Workspace A",
        updatedAt: now,
      });
      await db.persistSessionSnapshot("workspace-a", persistedSnapshot);

      expect(
        db
          .listSessions({ workingDirectory: "/tmp/workspace-a" })
          .map((session) => session.sessionId),
      ).toEqual(["workspace-a"]);
      expect(
        db
          .listSessions({ workingDirectory: "/tmp/workspace-b" })
          .map((session) => session.sessionId),
      ).toEqual(["workspace-b"]);
      expect(db.getSessionSnapshot("workspace-a")).toEqual(persistedSnapshot);
      expect(db.getSessionSnapshot("workspace-b")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("listSessions preserves exact summary shapes and ordering across workspace filters", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    const workspace = path.join(paths.rootDir, "workspace");
    const otherWorkspace = path.join(paths.rootDir, "other-workspace");
    try {
      const mutations = [
        makeSessionMutation("older"),
        makeSessionMutation("other"),
        makeSessionMutation("newer"),
        makeSessionMutation("unsupported"),
        makeSessionMutation("child", "older"),
      ];
      for (const [index, mutation] of mutations.entries()) {
        mutation.snapshot.workingDirectory =
          mutation.sessionId === "other" ? otherWorkspace : workspace;
        mutation.snapshot.updatedAt = `2026-09-01T12:00:0${index}.000Z`;
        mutation.snapshot.hasPendingAsk = mutation.sessionId === "newer";
        mutation.snapshot.hasPendingApproval = mutation.sessionId === "older";
        await db.persistSessionMutation(mutation);
      }
      const rawDb = new Database(db.dbPath);
      try {
        rawDb
          .query("UPDATE sessions SET provider = ? WHERE session_id = ?")
          .run("future-local", "unsupported");
      } finally {
        rawDb.close(true);
      }
      const summaries = mutations.slice(0, 3).map(({ sessionId, snapshot }) => ({
        sessionId,
        title: snapshot.title,
        titleSource: snapshot.titleSource,
        titleModel: snapshot.titleModel,
        provider: snapshot.provider,
        model: snapshot.model,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        messageCount: snapshot.messages.length,
        lastEventSeq: 1,
        hasPendingAsk: snapshot.hasPendingAsk,
        hasPendingApproval: snapshot.hasPendingApproval,
      }));
      const allSummaries = [summaries[2], summaries[1], summaries[0]];
      expect(db.listSessions()).toEqual(allSummaries);
      for (const workingDirectory of [undefined, null, "", " \t "]) {
        expect(db.listSessions({ workingDirectory })).toEqual(allSummaries);
      }
      for (const workingDirectory of [
        workspace,
        ` ${workspace}${path.sep} `,
        `${workspace}${path.sep}nested${path.sep}..${path.sep}.`,
      ]) {
        expect(db.listSessions({ workingDirectory })).toEqual([summaries[2], summaries[0]]);
      }
      expect(db.listSessions({ workingDirectory: otherWorkspace })).toEqual([summaries[1]]);
      expect(db.listSessions({ workingDirectory: path.join(paths.rootDir, "missing") })).toEqual(
        [],
      );
    } finally {
      db.close();
      await fs.rm(path.dirname(paths.rootDir), { recursive: true, force: true });
    }
  });

  test("listSessions filters other workspaces before strict summary validation", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const valid = makeSessionMutation("valid");
      const malformed = makeSessionMutation("malformed");
      malformed.snapshot.workingDirectory = path.join(paths.rootDir, "other-workspace");
      await db.persistSessionMutation(valid);
      await db.persistSessionMutation(malformed);
      const rawDb = new Database(db.dbPath);
      try {
        rawDb.query("UPDATE sessions SET title = '' WHERE session_id = ?").run("malformed");
      } finally {
        rawDb.close(true);
      }
      expect(
        db
          .listSessions({ workingDirectory: valid.snapshot.workingDirectory })
          .map((summary) => summary.sessionId),
      ).toEqual(["valid"]);
      expect(() => db.listSessions()).toThrow();
    } finally {
      db.close();
      await fs.rm(path.dirname(paths.rootDir), { recursive: true, force: true });
    }
  });

  test("listSessions matches working directory across lexical normalization", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-db-wdnorm-"));
      const canonical = path.resolve(realDir);
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "wd-norm",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Norm",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: canonical,
          enableMcp: true,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      expect(
        db.listSessions({ workingDirectory: path.join(canonical, ".") }).map((s) => s.sessionId),
      ).toEqual(["wd-norm"]);
      expect(
        db.listSessions({ workingDirectory: `${canonical}${path.sep}` }).map((s) => s.sessionId),
      ).toEqual(["wd-norm"]);
    } finally {
      db.close();
    }
  });

  test("imports legacy JSON snapshots before marking legacy migration as applied", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();

    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-1.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-1",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
        },
        config: {
          provider: "google",
          model: "gemini-3-flash-preview",
          enableMcp: false,
          workingDirectory: "/tmp/legacy",
        },
        context: {
          system: "legacy",
          messages: [{ role: "user", content: "hello from legacy" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-1");
      expect(sessions[0]?.messageCount).toBe(1);

      const persisted = db.getSessionRecord("legacy-1");
      expect(persisted?.title).toBe("Legacy Session");
      expect(persisted?.messages).toHaveLength(1);
      expect(persisted?.providerState).toBeNull();
      expect(persisted?.profile).toBeNull();
    } finally {
      db.close();
    }
  });

  test("imports provider options and agent profiles from version 7 legacy snapshots", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();

    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-7.json"),
      JSON.stringify({
        version: 7,
        sessionId: "legacy-7",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Agent",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          nickname: null,
          taskType: "verify",
          targetPaths: ["src/auth", "test/auth"],
          profile: makeAgentProfileSnapshot(),
          requestedModel: null,
          effectiveModel: "gpt-5.2",
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: "completed",
          lastMessagePreview: "done",
        },
        config: {
          provider: "openai",
          model: "gpt-5.2",
          enableMcp: true,
          backupsEnabledOverride: null,
          workingDirectory: "/tmp/legacy-7",
          providerOptions: {
            openai: {
              reasoningEffort: "xhigh",
              textVerbosity: "low",
            },
          },
        },
        context: {
          system: "legacy",
          messages: [{ role: "assistant", content: "done" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
          workflowRuns: [
            {
              runId: "wf_legacy",
              name: "Legacy failure",
              phases: ["main"],
              currentPhase: "main",
              agents: [],
              logs: [],
              spentUsd: 0.25,
              outcome: "errored",
              error: "legacy run failed",
            },
          ],
        },
      }),
      "utf-8",
    );

    const db = await SessionDb.create({ paths });
    try {
      const persisted = db.getSessionRecord("legacy-7");
      expect(persisted?.providerOptions).toEqual({
        openai: {
          reasoningEffort: "xhigh",
          textVerbosity: "low",
        },
      });
      expect(persisted?.taskType).toBe("verify");
      expect(persisted?.targetPaths).toEqual(["src/auth", "test/auth"]);
      expect(db.listAgentSessions("root-1")[0]?.executionState).toBe("completed");
      expect(persisted?.profile).toEqual(makeAgentProfileSnapshot());
      expect(db.listAgentSessions("root-1")[0]?.profile).toEqual(makeAgentProfileSnapshot());
      expect(db.getSessionSnapshot("legacy-7")?.profile).toEqual(makeAgentProfileSnapshot());
      expect(db.getSessionSnapshot("legacy-7")?.workflowRuns).toEqual([
        expect.objectContaining({ runId: "wf_legacy", error: "legacy run failed" }),
      ]);
    } finally {
      db.close();
    }

    // An interrupted migration can encounter a session row it already inserted.
    // Reimport a changed profile to cover the ON CONFLICT update as well.
    const legacyPath = path.join(paths.sessionsDir, "legacy-7.json");
    const revisedProfile = { ...makeAgentProfileSnapshot(), displayName: "Updated Reviewer" };
    const legacy = JSON.parse(await fs.readFile(legacyPath, "utf8"));
    legacy.session.profile = revisedProfile;
    await fs.writeFile(legacyPath, JSON.stringify(legacy));
    const migrationDb = new Database(db.dbPath, { create: false, strict: false });
    try {
      migrationDb.exec("DELETE FROM schema_migrations WHERE version = 2");
    } finally {
      migrationDb.close();
    }

    const reopened = await SessionDb.create({ paths });
    try {
      expect(reopened.getSessionRecord("legacy-7")?.profile).toEqual(revisedProfile);
      expect(reopened.listAgentSessions("root-1")[0]?.profile).toEqual(revisedProfile);
      expect(reopened.getSessionSnapshot("legacy-7")?.profile).toEqual(revisedProfile);
    } finally {
      reopened.close();
    }
  });

  test("lists child-agent sessions separately and cascades deletion from the parent", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "root-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Root Session",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "root-system",
          messages: [{ role: "user", content: "root hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });
      await db.persistSessionMutation({
        sessionId: "child-1",
        eventType: "session.created",
        snapshot: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          nickname: "verify-auth",
          taskType: "verify",
          targetPaths: ["src/auth", "test/auth"],
          profile: makeAgentProfileSnapshot(),
          title: "Child Session",
          titleSource: "default",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2-mini",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "child-system",
          messages: [{ role: "assistant", content: "child hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      expect(db.listSessions().map((session) => session.sessionId)).toEqual(["root-1"]);
      const agents = db.listAgentSessions("root-1");
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        agentId: "child-1",
        parentSessionId: "root-1",
        role: "worker",
        nickname: "verify-auth",
        taskType: "verify",
        targetPaths: ["src/auth", "test/auth"],
        profile: expect.objectContaining({
          id: "qa-reviewer",
          ref: "workspace:qa-reviewer",
          skillNames: ["code-review"],
        }),
        mode: "collaborative",
        depth: 1,
        lifecycleState: "active",
      });
      expect(db.getSessionRecord("child-1")?.profile).toEqual(makeAgentProfileSnapshot());

      await db.deleteSession("root-1");
      expect(db.getSessionRecord("root-1")).toBeNull();
      expect(db.getSessionRecord("child-1")).toBeNull();
      expect(db.listAgentSessions("root-1")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("deletes the complete session tree and its owned journal and metadata rows", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      await persistDeletionFixture(db);
      await db.deleteSession("root");

      for (const sessionId of ["root", "child", "grandchild"]) {
        expect(db.getSessionRecord(sessionId)).toBeNull();
        expect(db.getSessionSnapshot(sessionId)).toBeNull();
        expect(db.listThreadJournalEvents(sessionId)).toEqual([]);
        expect(db.getThreadJournalFailure(sessionId)).toBeNull();
        expect(db.getThreadMetadata(sessionId)).toBeNull();
        expect(db.getThreadIdByCreationKey(`creation-${sessionId}`)).toBeNull();
      }
      expect(db.getSessionRecord("unrelated")).not.toBeNull();
      expect(db.listThreadJournalEvents("unrelated")).toHaveLength(1);
      expect(db.getThreadJournalFailure("unrelated")).not.toBeNull();
      expect(db.getThreadMetadata("unrelated")).not.toBeNull();
      expect(db.getThreadIdByCreationKey("creation-unrelated")).toBe("unrelated");
    } finally {
      db.close();
      await fs.rm(path.dirname(paths.rootDir), { recursive: true, force: true });
    }
  });

  test("rolls back the entire deletion when removing the parent fails", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    const inspectDb = new Database(db.dbPath, { create: false, strict: false });
    try {
      await persistDeletionFixture(db);
      inspectDb.exec(
        "CREATE TRIGGER reject_root_delete BEFORE DELETE ON sessions WHEN old.session_id = 'root' BEGIN SELECT RAISE(FAIL, 'parent deletion failed'); END",
      );

      await expect(db.deleteSession("root")).rejects.toThrow("parent deletion failed");

      for (const sessionId of ["root", "child", "grandchild"]) {
        expect(db.getSessionRecord(sessionId)).not.toBeNull();
        expect(db.getSessionSnapshot(sessionId)).not.toBeNull();
        expect(db.listThreadJournalEvents(sessionId)).toHaveLength(1);
        expect(db.getThreadJournalFailure(sessionId)).not.toBeNull();
        expect(db.getThreadMetadata(sessionId)).not.toBeNull();
        expect(db.getThreadIdByCreationKey(`creation-${sessionId}`)).toBe(sessionId);
      }
    } finally {
      inspectDb.close();
      db.close();
      await fs.rm(path.dirname(paths.rootDir), { recursive: true, force: true });
    }
  });

  test("skips malformed legacy snapshots and still imports valid ones", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-valid.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-valid",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Valid",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
        },
        config: {
          provider: "google",
          model: "gemini-3-flash-preview",
          enableMcp: false,
          workingDirectory: "/tmp/legacy-valid",
        },
        context: {
          system: "legacy-valid",
          messages: [{ role: "user", content: "hello from valid legacy snapshot" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-bad-json.json"),
      "not valid json {{{",
      "utf-8",
    );
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-bad-structure.json"),
      JSON.stringify({ version: 1, sessionId: "missing-fields" }),
      "utf-8",
    );

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-valid");

      const persisted = db.getSessionRecord("legacy-valid");
      expect(persisted?.title).toBe("Legacy Valid");
      expect(persisted?.messages).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("skips unreadable legacy snapshot entries while importing valid ones", async () => {
    const paths = await makeTmpCoworkHome();
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(paths.sessionsDir, "legacy-valid.json"),
      JSON.stringify({
        version: 1,
        sessionId: "legacy-valid",
        createdAt: now,
        updatedAt: now,
        session: {
          title: "Legacy Valid",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
        },
        config: {
          provider: "google",
          model: "gemini-3-flash-preview",
          enableMcp: false,
          workingDirectory: "/tmp/legacy-valid",
        },
        context: {
          system: "legacy-valid",
          messages: [{ role: "user", content: "hello from valid legacy snapshot" }],
          todos: [],
          harnessContext: null,
        },
      }),
      "utf-8",
    );

    const unreadableDir = path.join(paths.sessionsDir, "legacy-unreadable.json");
    await fs.mkdir(unreadableDir);

    const db = await SessionDb.create({ paths });
    try {
      const sessions = db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("legacy-valid");

      const persisted = db.getSessionRecord("legacy-valid");
      expect(persisted?.title).toBe("Legacy Valid");
      expect(persisted?.messages).toHaveLength(1);
    } finally {
      db.close();
      await fs.rm(unreadableDir, { recursive: true, force: true });
    }
  });

  test("returns empty messages when messages_json is malformed", async () => {
    const paths = await makeTmpCoworkHome();
    const db = await SessionDb.create({ paths });
    try {
      const now = new Date().toISOString();
      await db.persistSessionMutation({
        sessionId: "s-bad-messages",
        eventType: "session.created",
        snapshot: {
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Session with bad messages",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          workingDirectory: "/tmp/project",
          enableMcp: false,
          createdAt: now,
          updatedAt: now,
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }],
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
      });

      (db as any).db
        .query("UPDATE session_state SET messages_json = ? WHERE session_id = ?")
        .run("not-json", "s-bad-messages");

      const paged = db.getMessages("s-bad-messages", 0, 10);
      expect(paged.total).toBe(0);
      expect(paged.messages).toEqual([]);
    } finally {
      db.close();
    }
  });
});
