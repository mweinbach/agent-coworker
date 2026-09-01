import type {
  JsonRpcControlResult,
  McpServerEntry,
  MemoryEntry,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderStatusEntry,
  SkillCatalogSnapshot,
  SkillEntry,
  SkillInstallationEntry,
  WorkspaceBackupEntry,
} from "@/cowork-shared/jsonrpcControlSchemas";
import { useBackupStore } from "./backupStore";
import type { WorkspaceControlSnapshot } from "./controlRpc";
import { useMcpStore } from "./mcpStore";
import { useMemoryStore } from "./memoryStore";
import { getOfflineCacheScope, loadFromOfflineCache } from "./offlineCacheStorage";
import type { WorkspaceSummary } from "./protocolTypes";
import { useProviderStore } from "./providerStore";
import { useSkillsStore } from "./skillsStore";
import { useWorkspaceStore } from "./workspaceStore";

export {
  clearAllOfflineWorkspaceCache,
  loadFromOfflineCache,
  saveToOfflineCache,
} from "./offlineCacheStorage";

type McpConfigFile = JsonRpcControlResult<"cowork/mcp/servers/read">["event"]["files"][number];

export async function loadAllOfflineWorkspaceCache(): Promise<void> {
  const owner = getOfflineCacheScope();
  const before = {
    workspace: useWorkspaceStore.getState(),
    providers: useProviderStore.getState(),
    mcp: useMcpStore.getState(),
    skills: useSkillsStore.getState(),
    memory: useMemoryStore.getState(),
    backups: useBackupStore.getState(),
  };
  if (before.workspace.activeWorkspaceCwd || before.workspace.workspaces.length > 0) return;

  const [workspaces, activeWorkspaceId, activeWorkspaceName, activeWorkspaceCwd] =
    await Promise.all([
      loadFromOfflineCache<WorkspaceSummary[]>("workspaces", owner.desktopId),
      loadFromOfflineCache<string>("activeWorkspaceId", owner.desktopId),
      loadFromOfflineCache<string>("activeWorkspaceName", owner.desktopId),
      loadFromOfflineCache<string>("activeWorkspaceCwd", owner.desktopId),
    ]);
  if (getOfflineCacheScope() !== owner || useWorkspaceStore.getState() !== before.workspace) return;
  const cachedCwd = typeof activeWorkspaceCwd === "string" ? activeWorkspaceCwd : null;
  const readContext = <T>(key: string) => loadFromOfflineCache<T>(key, owner.desktopId, cachedCwd);
  const [
    controlSnapshot,
    catalog,
    authMethods,
    status,
    mcpServers,
    mcpFiles,
    mcpWarnings,
    skills,
    skillsCatalog,
    skillsInstallations,
    skillsEffectiveInstallations,
    memories,
    backups,
    workspacePath,
  ] = await Promise.all([
    readContext<WorkspaceControlSnapshot>("controlSnapshot"),
    readContext<ProviderCatalogEntry[]>("providerCatalog"),
    readContext<Record<string, ProviderAuthMethod[]>>("providerAuthMethods"),
    readContext<Record<string, ProviderStatusEntry>>("providerStatus"),
    readContext<McpServerEntry[]>("mcpServers"),
    readContext<McpConfigFile[]>("mcpFiles"),
    readContext<string[]>("mcpWarnings"),
    readContext<SkillEntry[]>("skills"),
    readContext<SkillCatalogSnapshot>("skillsCatalog"),
    readContext<SkillInstallationEntry[]>("skillsInstallations"),
    readContext<SkillInstallationEntry[]>("skillsEffectiveInstallations"),
    readContext<MemoryEntry[]>("memories"),
    readContext<WorkspaceBackupEntry[]>("backups"),
    readContext<string>("workspacePath"),
  ]);

  if (getOfflineCacheScope() !== owner || useWorkspaceStore.getState() !== before.workspace) return;
  if (Array.isArray(workspaces) || typeof activeWorkspaceCwd === "string") {
    useWorkspaceStore.setState({
      workspaces: Array.isArray(workspaces) ? workspaces : [],
      activeWorkspaceId: typeof activeWorkspaceId === "string" ? activeWorkspaceId : null,
      activeWorkspaceName: typeof activeWorkspaceName === "string" ? activeWorkspaceName : null,
      activeWorkspaceCwd: typeof activeWorkspaceCwd === "string" ? activeWorkspaceCwd : null,
      controlSnapshot,
    });
  }
  if (useProviderStore.getState() === before.providers && (catalog || authMethods || status)) {
    useProviderStore.setState({
      catalog: Array.isArray(catalog) ? catalog : [],
      authMethodsByProvider: authMethods ?? {},
      statusByProvider: status ?? {},
    });
  }
  if (useMcpStore.getState() === before.mcp && Array.isArray(mcpServers)) {
    useMcpStore.setState({
      servers: mcpServers,
      files: Array.isArray(mcpFiles) ? mcpFiles : [],
      warnings: Array.isArray(mcpWarnings) ? mcpWarnings : [],
    });
  }
  if (useSkillsStore.getState() === before.skills && Array.isArray(skills)) {
    useSkillsStore.setState({
      skills,
      catalog: skillsCatalog,
      installations: Array.isArray(skillsInstallations) ? skillsInstallations : [],
      effectiveInstallations: Array.isArray(skillsEffectiveInstallations)
        ? skillsEffectiveInstallations
        : [],
    });
  }
  if (useMemoryStore.getState() === before.memory && Array.isArray(memories)) {
    useMemoryStore.setState({ entries: memories });
  }
  if (useBackupStore.getState() === before.backups && Array.isArray(backups)) {
    useBackupStore.setState({
      backups,
      workspacePath: typeof workspacePath === "string" ? workspacePath : null,
    });
  }
}
