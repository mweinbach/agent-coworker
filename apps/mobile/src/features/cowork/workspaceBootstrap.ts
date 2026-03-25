import { useBackupStore } from "./backupStore";
import { useMcpStore } from "./mcpStore";
import { useMemoryStore } from "./memoryStore";
import { useProviderStore } from "./providerStore";
import { useSkillsStore } from "./skillsStore";
import { useWorkspaceStore } from "./workspaceStore";

export function clearWorkspaceBoundStores() {
  useWorkspaceStore.getState().clear();
  useSkillsStore.getState().clear();
  useMemoryStore.getState().clear();
  useBackupStore.getState().clear();
  useProviderStore.getState().clear();
  useMcpStore.getState().clear();
}

export async function refreshWorkspaceBoundStores() {
  const workspaceStore = useWorkspaceStore.getState();
  if (!workspaceStore.activeWorkspaceCwd) {
    return;
  }
  await workspaceStore.fetchControlState();
  await Promise.allSettled([
    useProviderStore.getState().refresh(),
    useMcpStore.getState().fetchServers(),
    useSkillsStore.getState().fetchSkills(),
    useMemoryStore.getState().fetchMemories(),
    useBackupStore.getState().fetchBackups(),
  ]);
}

export async function hydrateWorkspaceBoundStores() {
  const workspaceStore = useWorkspaceStore.getState();
  await workspaceStore.fetchWorkspaces();
  await refreshWorkspaceBoundStores();
}
