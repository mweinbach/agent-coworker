import { useBackupStore } from "./backupStore";
import { useMcpStore } from "./mcpStore";
import { useMemoryStore } from "./memoryStore";
import { loadAllOfflineWorkspaceCache } from "./offlineCache";
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
  // Fetch ALL in parallel! No sequential await for fetchControlState.
  await Promise.allSettled([
    workspaceStore.fetchControlState(),
    useProviderStore.getState().refresh(),
    useMcpStore.getState().fetchServers(),
    useSkillsStore.getState().fetchSkills(),
    useMemoryStore.getState().fetchMemories(),
    useBackupStore.getState().fetchBackups(),
  ]);
}

export async function hydrateWorkspaceBoundStores() {
  // Load cache instantly on startup so UI has immediate access
  await loadAllOfflineWorkspaceCache();

  const workspaceStore = useWorkspaceStore.getState();

  if (workspaceStore.activeWorkspaceCwd) {
    // We have a cached active workspace! Fetch workspaces list AND config data in parallel.
    await Promise.allSettled([workspaceStore.fetchWorkspaces(), refreshWorkspaceBoundStores()]);
  } else {
    // Fallback: no cached active workspace, so fetch workspaces first, then refresh stores if we found one
    await workspaceStore.fetchWorkspaces();
    await refreshWorkspaceBoundStores();
  }
}
