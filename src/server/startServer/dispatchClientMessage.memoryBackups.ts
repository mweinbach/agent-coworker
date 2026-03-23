import type { LegacyClientMessageHandlerMap } from "./dispatchClientMessage.shared";

export function createMemoryAndBackupsClientMessageHandlers(): Pick<
  LegacyClientMessageHandlerMap,
  | "session_backup_get"
  | "session_backup_checkpoint"
  | "session_backup_restore"
  | "session_backup_delete_checkpoint"
  | "workspace_backups_get"
  | "workspace_backup_checkpoint"
  | "workspace_backup_restore"
  | "workspace_backup_delete_checkpoint"
  | "workspace_backup_delete_entry"
  | "workspace_backup_delta_get"
  | "memory_list"
  | "memory_upsert"
  | "memory_delete"
> {
  return {
    session_backup_get: ({ session }) =>
      void session.getSessionBackupState(),
    session_backup_checkpoint: ({ session }) =>
      void session.createManualSessionCheckpoint(),
    session_backup_restore: ({ session, message }) =>
      void session.restoreSessionBackup(message.checkpointId),
    session_backup_delete_checkpoint: ({ session, message }) =>
      void session.deleteSessionCheckpoint(message.checkpointId),
    workspace_backups_get: ({ session }) =>
      void session.listWorkspaceBackups(),
    workspace_backup_checkpoint: ({ session, message }) =>
      void session.createWorkspaceBackupCheckpoint(message.targetSessionId),
    workspace_backup_restore: ({ session, message }) =>
      void session.restoreWorkspaceBackup(message.targetSessionId, message.checkpointId),
    workspace_backup_delete_checkpoint: ({ session, message }) =>
      void session.deleteWorkspaceBackupCheckpoint(message.targetSessionId, message.checkpointId),
    workspace_backup_delete_entry: ({ session, message }) =>
      void session.deleteWorkspaceBackupEntry(message.targetSessionId),
    workspace_backup_delta_get: ({ session, message }) =>
      void session.getWorkspaceBackupDelta(message.targetSessionId, message.checkpointId),
    memory_list: ({ session, message }) =>
      void session.emitMemories(message.scope),
    memory_upsert: ({ session, message }) =>
      void session.upsertMemory(message.scope, message.id, message.content),
    memory_delete: ({ session, message }) =>
      void session.deleteMemory(message.scope, message.id),
  };
}
