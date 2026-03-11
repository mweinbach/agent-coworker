import fs from "node:fs/promises";
import path from "node:path";

import type { SubagentAgentType } from "../../shared/persistentSubagents";
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

  async listSessions() {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can list sessions");
      return;
    }
    try {
      const sessions = this.context.deps.sessionDb
        ? this.context.deps.sessionDb.listSessions()
        : await listPersistedSessionSnapshots(this.context.getCoworkPaths());
      this.context.emit({ type: "sessions", sessionId: this.context.id, sessions });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list sessions: ${String(err)}`);
    }
  }

  async listSubagentSessions() {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can list subagents");
      return;
    }
    if (!this.context.deps.listSubagentSessionsImpl) {
      this.context.emitError("internal_error", "session", "Subagent listing is unavailable");
      return;
    }
    try {
      const subagents = await this.context.deps.listSubagentSessionsImpl(this.context.id);
      this.context.emit({ type: "subagent_sessions", sessionId: this.context.id, subagents });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list subagents: ${String(err)}`);
    }
  }

  async createSubagentSession(agentType: SubagentAgentType, task: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "session", "Only root sessions can create subagents");
      return;
    }
    if (!this.context.deps.createSubagentSessionImpl) {
      this.context.emitError("internal_error", "session", "Subagent creation is unavailable");
      return;
    }
    try {
      const subagent = await this.context.deps.createSubagentSessionImpl({
        parentSessionId: this.context.id,
        parentConfig: this.context.state.config,
        agentType,
        task,
      });
      this.context.emit({ type: "subagent_created", sessionId: this.context.id, subagent });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to create subagent: ${String(err)}`);
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
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "backup", "Only root sessions can list workspace backups");
      return;
    }
    if (!this.context.deps.listWorkspaceBackupsImpl) {
      this.context.emitError("internal_error", "backup", "Workspace backup listing is unavailable");
      return;
    }
    try {
      const backups = await this.context.deps.listWorkspaceBackupsImpl({
        requesterSessionId: this.context.id,
        workingDirectory: this.context.state.config.workingDirectory,
      });
      this.context.emit({
        type: "workspace_backups",
        sessionId: this.context.id,
        workspacePath: this.context.state.config.workingDirectory,
        backups,
      });
    } catch (err) {
      this.context.emitError("backup_error", "backup", `Failed to list workspace backups: ${String(err)}`);
    }
  }

  async createWorkspaceBackupCheckpoint(targetSessionId: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "backup", "Only root sessions can manage workspace backups");
      return;
    }
    if (!this.context.deps.createWorkspaceBackupCheckpointImpl) {
      this.context.emitError("internal_error", "backup", "Workspace backup checkpointing is unavailable");
      return;
    }
    try {
      const backups = await this.context.deps.createWorkspaceBackupCheckpointImpl({
        requesterSessionId: this.context.id,
        workingDirectory: this.context.state.config.workingDirectory,
        targetSessionId,
      });
      this.context.emit({
        type: "workspace_backups",
        sessionId: this.context.id,
        workspacePath: this.context.state.config.workingDirectory,
        backups,
      });
    } catch (err) {
      this.context.emitError("backup_error", "backup", `Failed to create workspace checkpoint: ${String(err)}`);
    }
  }

  async restoreWorkspaceBackup(targetSessionId: string, checkpointId?: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "backup", "Only root sessions can manage workspace backups");
      return;
    }
    if (!this.context.deps.restoreWorkspaceBackupImpl) {
      this.context.emitError("internal_error", "backup", "Workspace backup restore is unavailable");
      return;
    }
    try {
      const backups = await this.context.deps.restoreWorkspaceBackupImpl({
        requesterSessionId: this.context.id,
        workingDirectory: this.context.state.config.workingDirectory,
        targetSessionId,
        checkpointId,
      });
      this.context.emit({
        type: "workspace_backups",
        sessionId: this.context.id,
        workspacePath: this.context.state.config.workingDirectory,
        backups,
      });
    } catch (err) {
      this.context.emitError("backup_error", "backup", `Failed to restore workspace backup: ${String(err)}`);
    }
  }

  async deleteWorkspaceBackupCheckpoint(targetSessionId: string, checkpointId: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "backup", "Only root sessions can manage workspace backups");
      return;
    }
    if (!this.context.deps.deleteWorkspaceBackupCheckpointImpl) {
      this.context.emitError("internal_error", "backup", "Workspace backup deletion is unavailable");
      return;
    }
    try {
      const backups = await this.context.deps.deleteWorkspaceBackupCheckpointImpl({
        requesterSessionId: this.context.id,
        workingDirectory: this.context.state.config.workingDirectory,
        targetSessionId,
        checkpointId,
      });
      this.context.emit({
        type: "workspace_backups",
        sessionId: this.context.id,
        workspacePath: this.context.state.config.workingDirectory,
        backups,
      });
    } catch (err) {
      this.context.emitError("backup_error", "backup", `Failed to delete workspace checkpoint: ${String(err)}`);
    }
  }

  async deleteWorkspaceBackupEntry(targetSessionId: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "backup", "Only root sessions can manage workspace backups");
      return;
    }
    if (!this.context.deps.deleteWorkspaceBackupEntryImpl) {
      this.context.emitError("internal_error", "backup", "Workspace backup deletion is unavailable");
      return;
    }
    try {
      const backups = await this.context.deps.deleteWorkspaceBackupEntryImpl({
        requesterSessionId: this.context.id,
        workingDirectory: this.context.state.config.workingDirectory,
        targetSessionId,
      });
      this.context.emit({
        type: "workspace_backups",
        sessionId: this.context.id,
        workspacePath: this.context.state.config.workingDirectory,
        backups,
      });
    } catch (err) {
      this.context.emitError("backup_error", "backup", `Failed to delete workspace backup: ${String(err)}`);
    }
  }

  async getWorkspaceBackupDelta(targetSessionId: string, checkpointId: string) {
    if ((this.context.state.sessionInfo.sessionKind ?? "root") !== "root") {
      this.context.emitError("validation_failed", "backup", "Only root sessions can inspect workspace backup deltas");
      return;
    }
    if (!this.context.deps.getWorkspaceBackupDeltaImpl) {
      this.context.emitError("internal_error", "backup", "Workspace backup delta inspection is unavailable");
      return;
    }
    try {
      const delta = await this.context.deps.getWorkspaceBackupDeltaImpl({
        requesterSessionId: this.context.id,
        workingDirectory: this.context.state.config.workingDirectory,
        targetSessionId,
        checkpointId,
      });
      this.context.emit({
        type: "workspace_backup_delta",
        sessionId: this.context.id,
        ...delta,
      });
    } catch (err) {
      this.context.emitError("backup_error", "backup", `Failed to inspect workspace backup delta: ${String(err)}`);
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
