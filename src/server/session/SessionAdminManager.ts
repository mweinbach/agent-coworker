import fs from "node:fs/promises";
import path from "node:path";

import type { SubagentAgentType } from "../../shared/persistentSubagents";
import { deletePersistedSessionSnapshot, listPersistedSessionSnapshots } from "../sessionStore";
import type { SessionContext } from "./SessionContext";

const MAX_WORKSPACE_DIRECTORY_ENTRIES = 2_000;
const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;

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

  async getWorkspaceFiles(directory = "") {
    const normalizedDirectory = this.normalizeWorkspacePath(directory);
    const resolved = await this.resolveWorkspacePath(normalizedDirectory);
    if (!resolved) {
      this.context.emitError("validation_failed", "session", "Invalid workspace directory");
      return;
    }

    try {
      const directoryStat = await fs.stat(resolved.absolutePath);
      if (!directoryStat.isDirectory()) {
        this.context.emitError("validation_failed", "session", "Workspace path is not a directory");
        return;
      }

      const dirents = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
      dirents.sort((lhs, rhs) => {
        if (lhs.isDirectory() !== rhs.isDirectory()) {
          return lhs.isDirectory() ? -1 : 1;
        }
        return lhs.name.localeCompare(rhs.name, undefined, { sensitivity: "base" });
      });

      const truncated = dirents.length > MAX_WORKSPACE_DIRECTORY_ENTRIES;
      const visibleDirents = dirents.slice(0, MAX_WORKSPACE_DIRECTORY_ENTRIES);
      const entries = (await Promise.all(visibleDirents.map(async (entry) => {
        const childRelativePath = this.joinWorkspacePath(normalizedDirectory, entry.name);
        const childResolved = await this.resolveWorkspacePath(childRelativePath);
        if (!childResolved) {
          return null;
        }

        const stats = await fs.stat(childResolved.absolutePath).catch(() => null);
        if (!stats) {
          return null;
        }

        return {
          path: childRelativePath,
          name: entry.name,
          kind: stats.isDirectory() ? "directory" as const : "file" as const,
          size: stats.isFile() ? stats.size : undefined,
          modifiedAt: Number.isNaN(stats.mtime.getTime()) ? undefined : stats.mtime.toISOString(),
          hidden: entry.name.startsWith("."),
        };
      }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      this.context.emit({
        type: "workspace_files",
        sessionId: this.context.id,
        workspacePath: resolved.workspaceRoot,
        directory: normalizedDirectory,
        entries,
        truncated,
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list workspace files: ${String(err)}`);
    }
  }

  async readWorkspaceFile(filePath: string) {
    const normalizedPath = this.normalizeWorkspacePath(filePath);
    if (!normalizedPath) {
      this.context.emitError("validation_failed", "session", "Invalid workspace file path");
      return;
    }

    const resolved = await this.resolveWorkspacePath(normalizedPath);
    if (!resolved) {
      this.context.emitError("validation_failed", "session", "Invalid workspace file path");
      return;
    }

    try {
      const stats = await fs.stat(resolved.absolutePath);
      if (!stats.isFile()) {
        this.context.emitError("validation_failed", "session", "Workspace path is not a file");
        return;
      }

      const truncated = stats.size > MAX_WORKSPACE_FILE_BYTES;
      const previewBytes = await (async () => {
        const handle = await fs.open(resolved.absolutePath, "r");
        try {
          const byteCount = Math.min(stats.size, MAX_WORKSPACE_FILE_BYTES);
          const buffer = Buffer.alloc(byteCount);
          const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
          return bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      })();
      const binary = previewBytes.includes(0);
      const content = binary ? "" : new TextDecoder().decode(previewBytes);

      this.context.emit({
        type: "workspace_file_content",
        sessionId: this.context.id,
        workspacePath: resolved.workspaceRoot,
        path: normalizedPath,
        content,
        truncated,
        binary,
        totalBytes: stats.size,
      });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to read workspace file: ${String(err)}`);
    }
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

  private normalizeWorkspacePath(input: string | undefined): string {
    const trimmed = input?.trim() ?? "";
    if (!trimmed || trimmed === ".") {
      return "";
    }

    const normalized = path.normalize(trimmed);
    if (normalized === "." || normalized === path.sep) {
      return "";
    }

    return normalized.replaceAll(path.sep, "/");
  }

  private joinWorkspacePath(directory: string, name: string): string {
    if (!directory) {
      return name;
    }
    return `${directory}/${name}`;
  }

  private async resolveWorkspacePath(relativePath: string): Promise<{ workspaceRoot: string; absolutePath: string } | null> {
    const workspaceRoot = path.resolve(this.context.state.config.workingDirectory);
    const candidatePath = path.resolve(workspaceRoot, relativePath || ".");

    const realWorkspaceRoot = await fs.realpath(workspaceRoot).catch(() => workspaceRoot);
    const realCandidatePath = await fs.realpath(candidatePath).catch(() => candidatePath);
    const relativeToWorkspace = path.relative(realWorkspaceRoot, realCandidatePath);
    if (
      relativeToWorkspace === ".."
      || relativeToWorkspace.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeToWorkspace)
    ) {
      return null;
    }

    return {
      workspaceRoot,
      absolutePath: candidatePath,
    };
  }
}
