import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

import {
  type ConversationSourceRequest,
  createConversationImportService,
} from "../../src/import/conversations";
import { type PersistedSessionMutation, SessionDb } from "../../src/server/sessionDb";
import type { WebDesktopServiceLike } from "../../src/server/webDesktopService";
import type { SessionSnapshot } from "../../src/shared/sessionSnapshot";
import type { AgentConfig } from "../../src/types";

type CoworkBackupSessionFixture = {
  sessionId: string;
  title: string;
  cwd: string;
  sessionKind?: SessionSnapshot["sessionKind"];
  createdAt?: string;
  updatedAt?: string;
  provider?: AgentConfig["provider"];
  model?: string;
  feed?: SessionSnapshot["feed"];
  messages?: PersistedSessionMutation["snapshot"]["messages"];
};

function countSnapshotMessages(feed: SessionSnapshot["feed"]): number {
  return feed.filter((item) => item.kind === "message").length;
}

function makeCoworkBackupSnapshot(session: CoworkBackupSessionFixture): SessionSnapshot {
  const createdAt = session.createdAt ?? "2026-01-01T00:00:00.000Z";
  const updatedAt = session.updatedAt ?? "2026-01-01T00:00:01.000Z";
  const feed = session.feed ?? [];
  return {
    sessionId: session.sessionId,
    title: session.title,
    titleSource: "default",
    titleModel: null,
    provider: session.provider ?? "google",
    model: session.model ?? "gemini-3-flash-preview",
    sessionKind: session.sessionKind ?? "root",
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
    lastMessagePreview: null,
    createdAt,
    updatedAt,
    messageCount: countSnapshotMessages(feed),
    lastEventSeq: feed.length,
    feed,
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

function makeCoworkBackupMutation(session: CoworkBackupSessionFixture): PersistedSessionMutation {
  const snapshot = makeCoworkBackupSnapshot(session);
  return {
    sessionId: session.sessionId,
    eventType: "session.created",
    eventTs: snapshot.updatedAt,
    snapshot: {
      sessionKind: snapshot.sessionKind,
      parentSessionId: snapshot.parentSessionId,
      role: snapshot.role,
      title: snapshot.title,
      titleSource: snapshot.titleSource,
      titleModel: snapshot.titleModel,
      provider: snapshot.provider,
      model: snapshot.model,
      workingDirectory: session.cwd,
      enableMcp: true,
      backupsEnabledOverride: null,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      status: "active",
      hasPendingAsk: false,
      hasPendingApproval: false,
      systemPrompt: "system",
      messages: session.messages ?? [],
      providerState: null,
      todos: [],
      harnessContext: null,
      costTracker: null,
    },
  };
}

export async function writeCoworkBackupDb(
  rootDir: string,
  sessions: CoworkBackupSessionFixture[],
): Promise<string> {
  const sessionsDir = path.join(rootDir, "sessions");
  const dbPath = path.join(rootDir, "sessions.db");
  await fs.mkdir(sessionsDir, { recursive: true });
  const db = await SessionDb.create({
    paths: { rootDir, sessionsDir },
    dbPath,
  });
  try {
    for (const session of sessions) {
      await db.persistSessionMutation(makeCoworkBackupMutation(session));
      if (session.feed) {
        await db.persistSessionSnapshot(session.sessionId, makeCoworkBackupSnapshot(session));
      }
    }
  } finally {
    db.close();
  }
  return dbPath;
}

export async function createImportTestService(
  dir: string,
  options: { desktopService?: WebDesktopServiceLike } = {},
) {
  const rootDir = path.join(dir, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  const workspace = path.join(dir, "workspace");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  const db = await SessionDb.create({
    paths: { rootDir, sessionsDir },
    dbPath: path.join(rootDir, "sessions.db"),
  });
  const config = {
    provider: "openai",
    model: "gpt-5.5",
    workingDirectory: workspace,
    projectCoworkDir: path.join(workspace, ".cowork"),
    userCoworkDir: rootDir,
    builtInDir: dir,
    builtInConfigDir: dir,
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  } as AgentConfig;
  return {
    db,
    workspace,
    service: createConversationImportService({
      sessionDb: db,
      homedir: dir,
      getConfig: () => config,
      ...options,
    }),
  };
}

export async function writeImportHistory(
  root: string,
  workspace: string,
  format: "codex-files" | "codex-db" | "claude-code" | "cowork",
  count: number,
): Promise<ConversationSourceRequest> {
  await fs.mkdir(root, { recursive: true });
  const sessions = Array.from({ length: count }, (_, index) => ({
    sessionId: `session-${index}`,
    title: `Message ${index}`,
    cwd: workspace,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    messages: [{ role: "user" as const, content: `Message ${index}` }],
  }));
  if (format === "cowork")
    return { source: "cowork", path: await writeCoworkBackupDb(root, sessions) };
  if (format === "codex-db") {
    const dbPath = path.join(root, "state.sqlite");
    const db = new Database(dbPath);
    try {
      db.exec(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)",
      );
      const insert = db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0)");
      db.transaction(() => {
        for (const session of sessions) {
          const timestamp = Date.parse(session.updatedAt) / 1000;
          insert.run(session.sessionId, session.title, workspace, timestamp, timestamp);
        }
      })();
    } finally {
      db.close();
    }
    return { source: "codex", path: dbPath };
  }
  for (const session of sessions) {
    const records =
      format === "codex-files"
        ? [
            {
              type: "event_msg",
              timestamp: session.updatedAt,
              payload: { type: "user_message", message: session.title },
            },
          ]
        : [
            { type: "ai-title", aiTitle: session.title, sessionId: session.sessionId },
            {
              type: "user",
              timestamp: session.updatedAt,
              sessionId: session.sessionId,
              cwd: workspace,
              message: session.messages[0],
            },
          ];
    const filePath = path.join(root, `${session.sessionId}.jsonl`);
    await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    await fs.utimes(filePath, new Date(session.updatedAt), new Date(session.updatedAt));
  }
  return { source: format === "codex-files" ? "codex" : "claude-code", path: root };
}
