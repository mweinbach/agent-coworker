import fs from "node:fs/promises";
import path from "node:path";

import { decodeBase64Strict, MAX_ATTACHMENT_UPLOAD_BASE64_SIZE } from "../../shared/attachments";
import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { AgentReasoningEffort, AgentRole, AgentSpawnContextOptions } from "../../shared/agents";
import { sameWorkspacePath } from "../../utils/workspacePath";
import {
  deletePersistedSessionSnapshot,
  listPersistedSessionSnapshots,
  type PersistedSessionSummary,
} from "../sessionStore";
import type { SessionContext } from "./SessionContext";

function snapshotToTopLevelSessionSummary(liveSnapshot: SessionSnapshot | null): PersistedSessionSummary | null {
  if (!liveSnapshot || liveSnapshot.sessionKind !== "root") {
    return null;
  }

  return {
    sessionId: liveSnapshot.sessionId,
    title: liveSnapshot.title,
    titleSource: liveSnapshot.titleSource,
    titleModel: liveSnapshot.titleModel,
    provider: liveSnapshot.provider,
    model: liveSnapshot.model,
    createdAt: liveSnapshot.createdAt,
    updatedAt: liveSnapshot.updatedAt,
    messageCount: liveSnapshot.messageCount,
    lastEventSeq: liveSnapshot.lastEventSeq,
    hasPendingAsk: liveSnapshot.hasPendingAsk,
    hasPendingApproval: liveSnapshot.hasPendingApproval,
  };
}

function mergeLiveTopLevelSessionSummary(
  session: PersistedSessionSummary,
  liveSnapshot: SessionSnapshot | null,
): PersistedSessionSummary {
  return snapshotToTopLevelSessionSummary(liveSnapshot) ?? session;
}

function mapLiveTopLevelSessionSummary(liveSnapshot: SessionSnapshot | null): PersistedSessionSummary | null {
  return snapshotToTopLevelSessionSummary(liveSnapshot);
}

function shouldIncludeTopLevelSessionSummary(
  session: PersistedSessionSummary,
  liveSnapshot: SessionSnapshot | null,
): boolean {
  if (
    liveSnapshot?.sessionKind === "root"
    && (
      liveSnapshot.executionState === "running"
      || liveSnapshot.executionState === "pending_init"
    )
  ) {
    return true;
  }

  return session.messageCount > 0
    || session.titleSource !== "default"
    || session.hasPendingAsk
    || session.hasPendingApproval;
}

export class SessionAdminManager {
  constructor(private readonly context: SessionContext) {}

  reset() {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }
    this.context.state.messages = [];
    this.context.state.allMessages = [];
    this.context.state.providerState = null;
    this.context.state.todos = [];
    this.context.emit({ type: "todos", sessionId: this.context.id, todos: [] });
    this.context.emit({ type: "reset_done", sessionId: this.context.id });
    this.context.queuePersistSessionSnapshot("session.reset");
  }

  getMessages(offset = 0, limit = 100) {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.floor(limit));
    let total = this.context.state.allMessages.length;
    let slice = this.context.state.allMessages.slice(safeOffset, safeOffset + safeLimit);
    if (this.context.deps.sessionDb) {
      const persisted = this.context.deps.sessionDb.getMessages(this.context.id, safeOffset, safeLimit);
      total = persisted.total;
      slice = persisted.messages;
    }
    this.context.emit({
      type: "messages",
      sessionId: this.context.id,
      messages: slice,
      total,
      offset: safeOffset,
      limit: safeLimit,
    });
  }

  async listSessions(scope: "all" | "workspace" = "all") {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can list sessions");
      return;
    }
    try {
      const persistedSessions = this.context.deps.sessionDb
        ? this.context.deps.sessionDb.listSessions({
            ...(scope === "workspace" ? { workingDirectory: this.context.state.config.workingDirectory } : {}),
          })
        : await listPersistedSessionSnapshots(this.context.getCoworkPaths(), {
            ...(scope === "workspace" ? { workingDirectory: this.context.state.config.workingDirectory } : {}),
          });
      const liveSessions = persistedSessions.map((session) => {
        const liveSnapshot = this.context.deps.getLiveSessionSnapshotImpl?.(session.sessionId) ?? null;
        return {
          liveSnapshot,
          summary: mergeLiveTopLevelSessionSummary(session, liveSnapshot),
        };
      });
      let sessions = liveSessions
        .map(({ summary, liveSnapshot }) =>
          shouldIncludeTopLevelSessionSummary(summary, liveSnapshot)
            ? summary
            : null,
        )
        .filter((session): session is PersistedSessionSummary => session !== null);
      const activeLiveSnapshot = this.context.deps.getLiveSessionSnapshotImpl?.(this.context.id) ?? null;
      const activeLiveSession = mapLiveTopLevelSessionSummary(activeLiveSnapshot);
      const shouldIncludeActiveLiveSession = activeLiveSession
        ? shouldIncludeTopLevelSessionSummary(activeLiveSession, activeLiveSnapshot)
        : false;

      if (
        activeLiveSession
        && shouldIncludeActiveLiveSession
        && !sessions.some((session) => session.sessionId === activeLiveSession.sessionId)
      ) {
        sessions = [activeLiveSession, ...sessions];
      }

      sessions = sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      this.context.emit({ type: "sessions", sessionId: this.context.id, sessions });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list sessions: ${String(err)}`);
    }
  }

  async getSessionSnapshot(targetSessionId: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can fetch session snapshots");
      return;
    }
    try {
      const liveSnapshot = this.context.deps.getLiveSessionSnapshotImpl?.(targetSessionId) ?? null;
      const liveWorkingDirectory = this.context.deps.getLiveSessionWorkingDirectoryImpl?.(targetSessionId) ?? null;
      const isSelfSnapshotRequest = targetSessionId === this.context.id;

      // Live sessions can answer immediately even if sqlite persistence is still catching up.
      if (liveSnapshot && (isSelfSnapshotRequest || liveWorkingDirectory)) {
        if (liveSnapshot.sessionKind !== "root") {
          this.context.emitError("validation_failed", "session", "Only root sessions can be hydrated via session snapshots");
          return;
        }
        if (
          !isSelfSnapshotRequest
          && liveWorkingDirectory
          && !sameWorkspacePath(liveWorkingDirectory, this.context.state.config.workingDirectory)
        ) {
          this.context.emitError("permission_denied", "session", "Target session is outside the active workspace");
          return;
        }

        this.context.emit({
          type: "session_snapshot",
          sessionId: this.context.id,
          targetSessionId,
          snapshot: liveSnapshot,
        });
        return;
      }

      const record = this.context.deps.sessionDb?.getSessionRecord(targetSessionId) ?? null;
      if (!record) {
        this.context.emitError("validation_failed", "session", `Unknown target session: ${targetSessionId}`);
        return;
      }
      if (record.sessionKind !== "root") {
        this.context.emitError("validation_failed", "session", "Only root sessions can be hydrated via session snapshots");
        return;
      }
      if (!sameWorkspacePath(record.workingDirectory, this.context.state.config.workingDirectory)) {
        this.context.emitError("permission_denied", "session", "Target session is outside the active workspace");
        return;
      }

      let dbSnapshot: ReturnType<NonNullable<SessionContext["deps"]["sessionDb"]>["getSessionSnapshot"]> = null;
      try {
        dbSnapshot = this.context.deps.sessionDb?.getSessionSnapshot(targetSessionId) ?? null;
      } catch {
        // Malformed/schema-mismatched snapshot row - fall back to legacy
      }
      const snapshot =
        liveSnapshot
        ?? dbSnapshot
        ?? this.context.deps.buildLegacySessionSnapshotImpl?.(record)
        ?? null;

      if (!snapshot) {
        this.context.emitError("internal_error", "session", `No snapshot available for session: ${targetSessionId}`);
        return;
      }

      this.context.emit({
        type: "session_snapshot",
        sessionId: this.context.id,
        targetSessionId,
        snapshot,
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to load session snapshot: ${String(err)}`);
    }
  }

  async listAgentSessions() {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can list child agents");
      return;
    }
    if (!this.context.deps.listAgentSessionsImpl) {
      this.context.emitError("internal_error", "session", "Child-agent listing is unavailable");
      return;
    }
    try {
      const agents = await this.context.deps.listAgentSessionsImpl(this.context.id);
      this.context.emit({ type: "agent_list", sessionId: this.context.id, agents });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list child agents: ${String(err)}`);
    }
  }

  async createAgentSession(opts: AgentSpawnContextOptions & {
    message: string;
    role?: AgentRole;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
  }) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can create child agents");
      return;
    }
    if (!this.context.deps.createAgentSessionImpl) {
      this.context.emitError("internal_error", "session", "Child-agent creation is unavailable");
      return;
    }
    try {
      const agent = await this.context.deps.createAgentSessionImpl({
        parentSessionId: this.context.id,
        parentConfig: this.context.state.config,
        message: opts.message,
        role: opts.role,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        ...(opts.contextMode !== undefined ? { contextMode: opts.contextMode } : {}),
        ...(opts.briefing !== undefined ? { briefing: opts.briefing } : {}),
        ...(opts.includeParentTodos !== undefined ? { includeParentTodos: opts.includeParentTodos } : {}),
        ...(opts.includeHarnessContext !== undefined ? { includeHarnessContext: opts.includeHarnessContext } : {}),
        ...(opts.forkContext !== undefined ? { forkContext: opts.forkContext } : {}),
        parentDepth: typeof this.context.state.sessionInfo.depth === "number" ? this.context.state.sessionInfo.depth : 0,
      });
      this.context.emit({ type: "agent_spawned", sessionId: this.context.id, agent });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to create child agent: ${String(err)}`);
    }
  }

  async sendAgentInput(agentId: string, message: string, interrupt?: boolean) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can control child agents");
      return;
    }
    if (!this.context.deps.sendAgentInputImpl) {
      this.context.emitError("internal_error", "session", "Child-agent input is unavailable");
      return;
    }
    try {
      await this.context.deps.sendAgentInputImpl({
        parentSessionId: this.context.id,
        agentId,
        message,
        ...(interrupt !== undefined ? { interrupt } : {}),
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to send child-agent input: ${String(err)}`);
    }
  }

  async waitForAgents(agentIds: string[], timeoutMs?: number) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can wait on child agents");
      return;
    }
    if (!this.context.deps.waitForAgentImpl) {
      this.context.emitError("internal_error", "session", "Child-agent waiting is unavailable");
      return;
    }
    try {
      const result = await this.context.deps.waitForAgentImpl({
        parentSessionId: this.context.id,
        agentIds,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      this.context.emit({
        type: "agent_wait_result",
        sessionId: this.context.id,
        agentIds,
        timedOut: result.timedOut,
        agents: result.agents,
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to wait on child agents: ${String(err)}`);
    }
  }

  async resumeAgent(agentId: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can resume child agents");
      return;
    }
    if (!this.context.deps.resumeAgentImpl) {
      this.context.emitError("internal_error", "session", "Child-agent resume is unavailable");
      return;
    }
    try {
      await this.context.deps.resumeAgentImpl({
        parentSessionId: this.context.id,
        agentId,
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to resume child agent: ${String(err)}`);
    }
  }

  async closeAgent(agentId: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can close child agents");
      return;
    }
    if (!this.context.deps.closeAgentImpl) {
      this.context.emitError("internal_error", "session", "Child-agent close is unavailable");
      return;
    }
    try {
      await this.context.deps.closeAgentImpl({
        parentSessionId: this.context.id,
        agentId,
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to close child agent: ${String(err)}`);
    }
  }

  async deleteSession(targetSessionId: string) {
    if (targetSessionId === this.context.id) {
      this.context.emitError("validation_failed", "session", "Cannot delete the active session");
      return;
    }
    try {
      if (this.context.deps.deleteSessionImpl) {
        await this.context.deps.deleteSessionImpl({
          requesterSessionId: this.context.id,
          targetSessionId,
        });
      } else if (this.context.deps.sessionDb) {
        await this.context.deps.sessionDb.deleteSession(targetSessionId);
      } else {
        const paths = this.context.getCoworkPaths();
        await deletePersistedSessionSnapshot(paths, targetSessionId);
      }
      this.context.emit({ type: "session_deleted", sessionId: this.context.id, targetSessionId });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to delete session: ${String(err)}`);
    }
  }

  async listWorkspaceBackups() {
    await this.runWorkspaceBackupOp(
      "listWorkspaceBackupsImpl",
      "list workspace backups",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async createWorkspaceBackupCheckpoint(targetSessionId: string) {
    await this.runWorkspaceBackupOp(
      "createWorkspaceBackupCheckpointImpl",
      "create workspace checkpoint",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async restoreWorkspaceBackup(targetSessionId: string, checkpointId?: string) {
    await this.runWorkspaceBackupOp(
      "restoreWorkspaceBackupImpl",
      "restore workspace backup",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId, checkpointId }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async deleteWorkspaceBackupCheckpoint(targetSessionId: string, checkpointId: string) {
    await this.runWorkspaceBackupOp(
      "deleteWorkspaceBackupCheckpointImpl",
      "delete workspace checkpoint",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId, checkpointId }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async deleteWorkspaceBackupEntry(targetSessionId: string) {
    await this.runWorkspaceBackupOp(
      "deleteWorkspaceBackupEntryImpl",
      "delete workspace backup",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId }),
      (backups) => ({ type: "workspace_backups" as const, sessionId: this.context.id, workspacePath: this.context.state.config.workingDirectory, backups }),
    );
  }

  async getWorkspaceBackupDelta(targetSessionId: string, checkpointId: string) {
    await this.runWorkspaceBackupOp(
      "getWorkspaceBackupDeltaImpl",
      "inspect workspace backup delta",
      (impl) => impl({ requesterSessionId: this.context.id, workingDirectory: this.context.state.config.workingDirectory, targetSessionId, checkpointId }),
      (delta) => ({ type: "workspace_backup_delta" as const, sessionId: this.context.id, ...delta }),
    );
  }

  private async runWorkspaceBackupOp<K extends keyof import("./SessionContext").SessionDependencies, T>(
    implKey: K,
    label: string,
    execute: (impl: NonNullable<import("./SessionContext").SessionDependencies[K]>) => Promise<T>,
    buildEvent: (result: T) => import("../protocol").ServerEvent,
  ): Promise<void> {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "backup", `Only root sessions can ${label}`);
      return;
    }
    const impl = this.context.deps[implKey];
    if (!impl) {
      this.context.emitError("internal_error", "backup", `Workspace backup operation is unavailable: ${label}`);
      return;
    }
    try {
      const result = await execute(impl);
      this.context.emit(buildEvent(result));
    } catch (err) {
      this.context.emitError("backup_error", "backup", `Failed to ${label}: ${String(err)}`);
    }
  }

  async uploadFile(filename: string, contentBase64: string) {
    const safeName = path.basename(filename);
    if (!safeName || safeName === "." || safeName === "..") {
      this.context.emitError("validation_failed", "session", "Invalid filename");
      return;
    }

    const uploadsDir = this.context.state.config.uploadsDirectory ?? path.resolve(this.context.state.config.workingDirectory, "User Uploads");
    const resolvedUploadsDir = path.resolve(uploadsDir);
    let filePath = path.resolve(resolvedUploadsDir, safeName);
    if (!filePath.startsWith(resolvedUploadsDir + path.sep)) {
      this.context.emitError("validation_failed", "session", "Invalid filename (path traversal)");
      return;
    }

    try {
      const ext = path.extname(safeName);
      const base = safeName.slice(0, safeName.length - ext.length);
      let counter = 1;
      while (true) {
        try {
          await fs.access(filePath);
          filePath = path.resolve(resolvedUploadsDir, `${base}_${counter}${ext}`);
          counter += 1;
        } catch {
          break;
        }
      }
      if (contentBase64.length > MAX_ATTACHMENT_UPLOAD_BASE64_SIZE) {
        this.context.emitError("validation_failed", "session", "File too large (max 100MB)");
        return;
      }
      const decoded = decodeBase64Strict(contentBase64);
      if (!decoded) {
        this.context.emitError("validation_failed", "session", "Invalid base64 file contents");
        return;
      }
      await fs.mkdir(resolvedUploadsDir, { recursive: true });
      await fs.writeFile(filePath, decoded);
      this.context.emit({ type: "file_uploaded", sessionId: this.context.id, filename: path.basename(filePath), path: filePath });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to upload file: ${String(err)}`);
    }
  }
}
