import fs from "node:fs/promises";
import path from "node:path";

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
    try {
      const sessions = this.context.deps.sessionDb
        ? this.context.deps.sessionDb.listSessions()
        : await listPersistedSessionSnapshots(this.context.getCoworkPaths());
      this.context.emit({ type: "sessions", sessionId: this.context.id, sessions });
    } catch (err) {
      this.context.emitError("internal_error", "session", `Failed to list sessions: ${String(err)}`);
    }
  }

  async deleteSession(targetSessionId: string) {
    if (targetSessionId === this.context.id) {
      this.context.emitError("validation_failed", "session", "Cannot delete the active session");
      return;
    }
    try {
      if (this.context.deps.sessionDb) {
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
