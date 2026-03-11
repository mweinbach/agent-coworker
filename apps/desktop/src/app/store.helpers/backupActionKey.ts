export function workspaceBackupActionKey(kind: string, targetSessionId: string, checkpointId?: string): string {
  return checkpointId ? `${kind}:${targetSessionId}:${checkpointId}` : `${kind}:${targetSessionId}`;
}
