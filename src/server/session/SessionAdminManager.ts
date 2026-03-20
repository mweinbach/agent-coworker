import fs from "node:fs/promises";
import path from "node:path";

import type { AgentReasoningEffort, AgentRole } from "../../shared/agents";
import { sameWorkspacePath } from "../../utils/workspacePath";
import { deletePersistedSessionSnapshot, listPersistedSessionSnapshots } from "../sessionStore";
import type { SessionContext } from "./SessionContext";

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
      const sessions = this.context.deps.sessionDb
        ? this.context.deps.sessionDb.listSessions({
            ...(scope === "workspace" ? { workingDirectory: this.context.state.config.workingDirectory } : {}),
          })
        : await listPersistedSessionSnapshots(this.context.getCoworkPaths(), {
            ...(scope === "workspace" ? { workingDirectory: this.context.state.config.workingDirectory } : {}),
          });
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

      const liveSnapshot = this.context.deps.getLiveSessionSnapshotImpl?.(targetSessionId) ?? null;
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

  async createAgentSession(opts: {
    message: string;
    role?: AgentRole;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
    forkContext?: boolean;
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
        this.context.deps.sessionDb.deleteSession(targetSessionId);
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
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    const safeName = path.basename(filename);
    if (!safeName || safeName === "." || safeName === "..") {
      this.context.emitError("validation_failed", "session", "Invalid filename");
      return;
    }

    const MAX_BASE64_SIZE = 10 * 1024 * 1024;
    if (contentBase64.length > MAX_BASE64_SIZE) {
      this.context.emitError("validation_failed", "session", "File too large (max ~7.5MB)");
      return;
    }

    const uploadsDir = this.context.state.config.uploadsDirectory ?? this.context.state.config.workingDirectory;
    const filePath = path.resolve(uploadsDir, safeName);
    if (!filePath.startsWith(path.resolve(uploadsDir))) {
      this.context.emitError("validation_failed", "session", "Invalid filename (path traversal)");
      return;
    }

    try {
      const decoded = Buffer.from(contentBase64, "base64");
      if (this.context.state.config.uploadsDirectory) {
        await fs.mkdir(uploadsDir, { recursive: true });
      }
      await fs.writeFile(filePath, decoded);
      this.context.emit({ type: "file_uploaded", sessionId: this.context.id, filename: safeName, path: filePath });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to upload file: ${String(err)}`);
    }
  }
}
