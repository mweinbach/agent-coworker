import path from "node:path";

import type { SessionContext } from "./SessionContext";

const AUTO_CHECKPOINT_MIN_INTERVAL_MS = 30_000;

export class SessionBackupController {
  constructor(private readonly context: SessionContext) {}

  async getSessionBackupState() {
    await this.ensureSessionBackupInitialized();
    this.emitSessionBackupState("requested");
    this.context.emitTelemetry("session.backup.state_requested", "ok", { sessionId: this.context.id });
  }

  async createManualSessionCheckpoint() {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }
    const startedAt = Date.now();
    try {
      const didCheckpoint = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.context.state.sessionBackup) {
          const reason = this.context.state.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.context.emitError("backup_error", "backup", reason);
          return false;
        }
        await this.context.state.sessionBackup.createCheckpoint("manual");
        this.context.state.sessionBackupState = this.context.state.sessionBackup.getPublicState();
        this.emitSessionBackupState("manual_checkpoint");
        return true;
      });
      if (!didCheckpoint) return;
      this.context.emitTelemetry("session.backup.checkpoint.manual", "ok", { sessionId: this.context.id }, Date.now() - startedAt);
    } catch (err) {
      this.context.emitError("backup_error", "backup", `manual checkpoint failed: ${String(err)}`);
      this.context.emitTelemetry("session.backup.checkpoint.manual", "error", { sessionId: this.context.id }, Date.now() - startedAt);
    }
  }

  async restoreSessionBackup(checkpointId?: string) {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    const startedAt = Date.now();
    try {
      const didRestore = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.context.state.sessionBackup) {
          const reason = this.context.state.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.context.emitError("backup_error", "backup", reason);
          return false;
        }
        if (checkpointId) {
          await this.context.state.sessionBackup.restoreCheckpoint(checkpointId);
        } else {
          await this.context.state.sessionBackup.restoreOriginal();
        }
        this.context.state.sessionBackupState = this.context.state.sessionBackup.getPublicState();
        this.emitSessionBackupState("restore");
        return true;
      });
      if (!didRestore) return;
      this.context.emitTelemetry("session.backup.restore", "ok", { sessionId: this.context.id }, Date.now() - startedAt);
    } catch (err) {
      this.context.emitError("backup_error", "backup", `restore failed: ${String(err)}`);
      this.context.emitTelemetry("session.backup.restore", "error", { sessionId: this.context.id }, Date.now() - startedAt);
    }
  }

  async deleteSessionCheckpoint(checkpointId: string) {
    if (this.context.state.running) {
      this.context.emitError("busy", "session", "Agent is busy");
      return;
    }

    const startedAt = Date.now();
    try {
      const didDelete = await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.context.state.sessionBackup) {
          const reason = this.context.state.sessionBackupState.failureReason ?? "Session backup is unavailable";
          this.context.emitError("backup_error", "backup", reason);
          return false;
        }
        const removed = await this.context.state.sessionBackup.deleteCheckpoint(checkpointId);
        if (!removed) {
          this.context.emitError("validation_failed", "backup", `Unknown checkpoint id: ${checkpointId}`);
          return false;
        }
        this.context.state.sessionBackupState = this.context.state.sessionBackup.getPublicState();
        this.emitSessionBackupState("delete");
        return true;
      });
      if (!didDelete) return;
      this.context.emitTelemetry("session.backup.checkpoint.delete", "ok", { sessionId: this.context.id }, Date.now() - startedAt);
    } catch (err) {
      this.context.emitError("backup_error", "backup", `delete checkpoint failed: ${String(err)}`);
      this.context.emitTelemetry("session.backup.checkpoint.delete", "error", { sessionId: this.context.id }, Date.now() - startedAt);
    }
  }

  async takeAutomaticSessionCheckpoint() {
    if (Date.now() - this.context.state.lastAutoCheckpointAt < AUTO_CHECKPOINT_MIN_INTERVAL_MS) return;

    try {
      const didCheckpoint = await this.runInBackupQueue(async () => {
        if (Date.now() - this.context.state.lastAutoCheckpointAt < AUTO_CHECKPOINT_MIN_INTERVAL_MS) return false;
        await this.ensureSessionBackupInitialized();
        if (!this.context.state.sessionBackup) return false;
        await this.context.state.sessionBackup.createCheckpoint("auto");
        this.context.state.sessionBackupState = this.context.state.sessionBackup.getPublicState();
        this.emitSessionBackupState("auto_checkpoint");
        this.context.state.lastAutoCheckpointAt = Date.now();
        return true;
      });
      if (!didCheckpoint) return;
    } catch (err) {
      this.context.emitError("backup_error", "backup", `automatic checkpoint failed: ${String(err)}`);
      this.context.emitTelemetry("session.backup.checkpoint.auto", "error", {
        sessionId: this.context.id,
        error: this.context.formatError(err),
      });
      return;
    }

    this.context.emitTelemetry("session.backup.checkpoint.auto", "ok", { sessionId: this.context.id });
  }

  async closeSessionBackup() {
    if (!this.context.state.sessionBackupInit) return;
    try {
      await this.runInBackupQueue(async () => {
        await this.ensureSessionBackupInitialized();
        if (!this.context.state.sessionBackup) return;
        await this.context.state.sessionBackup.close();
        this.context.state.sessionBackupState = this.context.state.sessionBackup.getPublicState();
      });
      this.context.emitTelemetry("session.backup.close", "ok", { sessionId: this.context.id });
    } catch {
      this.context.emitTelemetry("session.backup.close", "error", { sessionId: this.context.id });
    }
  }

  private emitSessionBackupState(reason: "requested" | "auto_checkpoint" | "manual_checkpoint" | "restore" | "delete") {
    this.context.emit({
      type: "session_backup_state",
      sessionId: this.context.id,
      reason,
      backup: this.context.state.sessionBackupState,
    });
  }

  private async initializeSessionBackup() {
    const userHome = this.context.state.config.userAgentDir ? path.dirname(this.context.state.config.userAgentDir) : undefined;
    const startedAt = Date.now();

    try {
      this.context.state.sessionBackup = await this.context.deps.sessionBackupFactory({
        sessionId: this.context.id,
        workingDirectory: this.context.state.config.workingDirectory,
        homedir: userHome,
      });
      this.context.state.sessionBackupState = this.context.state.sessionBackup.getPublicState();
      this.context.emitTelemetry("session.backup.initialize", "ok", { sessionId: this.context.id }, Date.now() - startedAt);
    } catch (err) {
      const reason = `session backup initialization failed: ${String(err)}`;
      this.context.state.sessionBackup = null;
      this.context.state.sessionBackupState = {
        ...this.context.state.sessionBackupState,
        status: "failed",
        failureReason: reason,
        originalSnapshot: { kind: "pending" },
      };
      this.context.emitTelemetry(
        "session.backup.initialize",
        "error",
        { sessionId: this.context.id, error: reason },
        Date.now() - startedAt
      );
    }
  }

  private async ensureSessionBackupInitialized() {
    if (!this.context.state.sessionBackupInit) {
      this.context.state.sessionBackupInit = this.initializeSessionBackup();
    }
    await this.context.state.sessionBackupInit;
  }

  private async runInBackupQueue<T>(op: () => Promise<T>): Promise<T> {
    const prior = this.context.state.backupOperationQueue;
    let release!: () => void;
    this.context.state.backupOperationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prior.catch(() => {});
    try {
      return await op();
    } finally {
      release();
    }
  }
}
