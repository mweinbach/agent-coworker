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
import type { WorkspaceSummary } from "./protocolTypes";
import { useProviderStore } from "./providerStore";
import { useSkillsStore } from "./skillsStore";
import { useWorkspaceStore } from "./workspaceStore";

type McpConfigFile = JsonRpcControlResult<"cowork/mcp/servers/read">["event"]["files"][number];

let secureStorePromise: Promise<typeof import("expo-secure-store")> | null = null;
async function getSecureStore() {
  if (!secureStorePromise) {
    secureStorePromise = import("expo-secure-store");
  }
  return await secureStorePromise;
}

export async function saveToOfflineCache(key: string, value: unknown): Promise<void> {
  try {
    const SecureStore = await getSecureStore();
    await SecureStore.setItemAsync(`cowork.cache.${key}`, JSON.stringify(value));
  } catch {
    // Silent fail in tests / environments without SecureStore
  }
}

export async function loadFromOfflineCache<T>(key: string): Promise<T | null> {
  try {
    const SecureStore = await getSecureStore();
    const raw = await SecureStore.getItemAsync(`cowork.cache.${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function loadAllOfflineWorkspaceCache(): Promise<void> {
  try {
    // 1. Workspaces & active workspace
    const workspaces = await loadFromOfflineCache<WorkspaceSummary[]>("workspaces");
    const activeWorkspaceId = await loadFromOfflineCache<string>("activeWorkspaceId");
    const activeWorkspaceName = await loadFromOfflineCache<string>("activeWorkspaceName");
    const activeWorkspaceCwd = await loadFromOfflineCache<string>("activeWorkspaceCwd");
    const controlSnapshot = await loadFromOfflineCache<WorkspaceControlSnapshot>("controlSnapshot");

    if (workspaces || activeWorkspaceCwd) {
      useWorkspaceStore.setState({
        workspaces: workspaces ?? [],
        activeWorkspaceId: activeWorkspaceId ?? null,
        activeWorkspaceName: activeWorkspaceName ?? null,
        activeWorkspaceCwd: activeWorkspaceCwd ?? null,
        controlSnapshot: controlSnapshot ?? null,
      });
    }

    // 2. Providers
    const catalog = await loadFromOfflineCache<ProviderCatalogEntry[]>("providerCatalog");
    const authMethods =
      await loadFromOfflineCache<Record<string, ProviderAuthMethod[]>>("providerAuthMethods");
    const status =
      await loadFromOfflineCache<Record<string, ProviderStatusEntry>>("providerStatus");
    if (catalog || authMethods || status) {
      useProviderStore.setState({
        catalog: catalog ?? [],
        authMethodsByProvider: authMethods ?? {},
        statusByProvider: status ?? {},
      });
    }

    // 3. MCP Servers
    const mcpServers = await loadFromOfflineCache<McpServerEntry[]>("mcpServers");
    const mcpFiles = await loadFromOfflineCache<McpConfigFile[]>("mcpFiles");
    const mcpWarnings = await loadFromOfflineCache<string[]>("mcpWarnings");
    if (mcpServers) {
      useMcpStore.setState({
        servers: mcpServers,
        files: mcpFiles ?? [],
        warnings: mcpWarnings ?? [],
      });
    }

    // 4. Skills
    const skills = await loadFromOfflineCache<SkillEntry[]>("skills");
    const skillsCatalog = await loadFromOfflineCache<SkillCatalogSnapshot>("skillsCatalog");
    const skillsInstallations =
      await loadFromOfflineCache<SkillInstallationEntry[]>("skillsInstallations");
    const skillsEffectiveInstallations = await loadFromOfflineCache<SkillInstallationEntry[]>(
      "skillsEffectiveInstallations",
    );
    if (skills) {
      useSkillsStore.setState({
        skills,
        catalog: skillsCatalog ?? null,
        installations: skillsInstallations ?? [],
        effectiveInstallations: skillsEffectiveInstallations ?? [],
      });
    }

    // 5. Memory
    const memories = await loadFromOfflineCache<MemoryEntry[]>("memories");
    if (memories) {
      useMemoryStore.setState({
        entries: memories,
      });
    }

    // 6. Backups
    const backups = await loadFromOfflineCache<WorkspaceBackupEntry[]>("backups");
    const workspacePath = await loadFromOfflineCache<string>("workspacePath");
    if (backups) {
      useBackupStore.setState({
        backups,
        workspacePath: workspacePath ?? null,
      });
    }
  } catch {
    // Silent fail on startup
  }
}

export async function clearAllOfflineWorkspaceCache(): Promise<void> {
  try {
    const SecureStore = await getSecureStore();
    const keys = [
      "workspaces",
      "activeWorkspaceId",
      "activeWorkspaceName",
      "activeWorkspaceCwd",
      "controlSnapshot",
      "providerCatalog",
      "providerAuthMethods",
      "providerStatus",
      "mcpServers",
      "mcpFiles",
      "mcpWarnings",
      "skills",
      "skillsCatalog",
      "skillsInstallations",
      "skillsEffectiveInstallations",
      "memories",
      "backups",
      "workspacePath",
      "threadSnapshots",
    ];
    await Promise.all(
      keys.map(async (key) => {
        try {
          await SecureStore.deleteItemAsync(`cowork.cache.${key}`);
        } catch {}
      }),
    );
  } catch {}
}
