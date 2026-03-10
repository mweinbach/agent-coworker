import { Database } from "bun:sqlite";
import path from "node:path";

import type { AiCoworkerPaths } from "../connect";
import type { PersistentSubagentSummary, SessionKind, SubagentAgentType } from "../shared/persistentSubagents";
import type { OpenAiContinuationState } from "../shared/openaiContinuation";
import type { SessionUsageSnapshot } from "../session/costTracker";
import type { ModelStreamRawFormat } from "./modelStream";
import type { AgentConfig, HarnessContextState, ModelMessage, TodoItem } from "../types";
import type { PersistedSessionSummary } from "./sessionStore";
import type { SessionTitleSource } from "./sessionTitleService";
import { ensurePrivateDirectory, hardenPrivateFile, quarantineCorruptedDb } from "./sessionDb/fileHardening";
import { importLegacySnapshots } from "./sessionDb/legacyImport";
import { bootstrapSessionDb } from "./sessionDb/migrations";
import { isCorruptionError } from "./sessionDb/normalizers";
import { SessionDbRepository } from "./sessionDb/repository";

export type { PersistedSessionSummary } from "./sessionStore";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export type SessionPersistenceStatus = "active" | "closed";

export type PersistedSessionRecord = {
  sessionId: string;
  sessionKind: SessionKind;
  parentSessionId: string | null;
  agentType: SubagentAgentType | null;
  title: string;
  titleSource: SessionTitleSource;
  titleModel: string | null;
  provider: AgentConfig["provider"];
  model: string;
  workingDirectory: string;
  outputDirectory?: string;
  uploadsDirectory?: string;
  enableMcp: boolean;
  createdAt: string;
  updatedAt: string;
  status: SessionPersistenceStatus;
  hasPendingAsk: boolean;
  hasPendingApproval: boolean;
  messageCount: number;
  lastEventSeq: number;
  systemPrompt: string;
  messages: ModelMessage[];
  providerState: OpenAiContinuationState | null;
  todos: TodoItem[];
  harnessContext: HarnessContextState | null;
  costTracker: SessionUsageSnapshot | null;
};

export type PersistedSessionMutation = {
  sessionId: string;
  eventType: string;
  eventTs?: string;
  direction?: "client" | "server" | "system";
  payload?: unknown;
  snapshot: {
    sessionKind: SessionKind;
    parentSessionId: string | null;
    agentType: SubagentAgentType | null;
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
    enableMcp: boolean;
    createdAt: string;
    updatedAt: string;
    status: SessionPersistenceStatus;
    hasPendingAsk: boolean;
    hasPendingApproval: boolean;
    systemPrompt: string;
    messages: ModelMessage[];
    providerState: OpenAiContinuationState | null;
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
    costTracker: SessionUsageSnapshot | null;
  };
};

export type PersistedModelStreamChunk = {
  sessionId: string;
  turnId: string;
  chunkIndex: number;
  ts: string;
  provider: AgentConfig["provider"];
  model: string;
  rawFormat: ModelStreamRawFormat;
  normalizerVersion: number;
  rawEvent: unknown;
};

type SessionDbOptions = {
  paths: Pick<AiCoworkerPaths, "rootDir" | "sessionsDir">;
  dbPath?: string;
  busyTimeoutMs?: number;
};

export class SessionDb {
  readonly dbPath: string;

  private readonly db: Database;
  private readonly sessionsDir: string;
  private readonly busyTimeoutMs: number;
  private readonly repository: SessionDbRepository;

  private constructor(opts: { db: Database; dbPath: string; sessionsDir: string; busyTimeoutMs: number }) {
    this.db = opts.db;
    this.dbPath = opts.dbPath;
    this.sessionsDir = opts.sessionsDir;
    this.busyTimeoutMs = opts.busyTimeoutMs;
    this.repository = new SessionDbRepository(this.db);
  }

  static async create(opts: SessionDbOptions): Promise<SessionDb> {
    await ensurePrivateDirectory(opts.paths.rootDir);

    const dbPath = opts.dbPath ?? path.join(opts.paths.rootDir, "sessions.db");
    const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    let db: Database;
    try {
      db = new Database(dbPath, { create: true, strict: false });
    } catch (error) {
      throw new Error(`Failed to open session database at ${dbPath}: ${String(error)}`);
    }

    const repo = new SessionDb({
      db,
      dbPath,
      sessionsDir: opts.paths.sessionsDir,
      busyTimeoutMs,
    });

    try {
      await repo.bootstrap();
      await repo.hardenDbFile();
      return repo;
    } catch (error) {
      if (!isCorruptionError(error)) {
        db.close();
        throw error;
      }

      db.close();
      await quarantineCorruptedDb(dbPath);

      const recreated = new Database(dbPath, { create: true, strict: false });
      const recoveredRepo = new SessionDb({
        db: recreated,
        dbPath,
        sessionsDir: opts.paths.sessionsDir,
        busyTimeoutMs,
      });
      await recoveredRepo.bootstrap();
      await recoveredRepo.hardenDbFile();
      return recoveredRepo;
    }
  }

  close(): void {
    this.db.close();
  }

  listSessions(): PersistedSessionSummary[] {
    return this.repository.listSessions();
  }

  listSubagentSessions(parentSessionId: string): PersistentSubagentSummary[] {
    return this.repository.listSubagentSessions(parentSessionId);
  }

  deleteSession(sessionId: string): void {
    this.repository.deleteSession(sessionId);
  }

  getMessages(sessionId: string, offset = 0, limit = 100): { messages: ModelMessage[]; total: number } {
    return this.repository.getMessages(sessionId, offset, limit);
  }

  getSessionRecord(sessionId: string): PersistedSessionRecord | null {
    return this.repository.getSessionRecord(sessionId);
  }

  persistSessionMutation(opts: PersistedSessionMutation): number {
    return this.repository.persistSessionMutation(opts);
  }

  persistModelStreamChunk(opts: PersistedModelStreamChunk): void {
    this.repository.persistModelStreamChunk(opts);
  }

  listModelStreamChunks(sessionId: string, turnId?: string): PersistedModelStreamChunk[] {
    return this.repository.listModelStreamChunks(sessionId, turnId);
  }

  private async bootstrap(): Promise<void> {
    await bootstrapSessionDb({
      db: this.db,
      busyTimeoutMs: this.busyTimeoutMs,
      repository: this.repository,
      importLegacySnapshots: async () => {
        await importLegacySnapshots({
          sessionsDir: this.sessionsDir,
          importSnapshot: (snapshot) => {
            this.repository.importLegacySnapshot(snapshot);
          },
        });
      },
    });
  }

  private async hardenDbFile(): Promise<void> {
    await hardenPrivateFile(this.dbPath);
  }
}
