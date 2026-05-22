import { useBackupStore } from "./backupStore";
import { useMcpStore } from "./mcpStore";
import { useMemoryStore } from "./memoryStore";
import { useProviderStore } from "./providerStore";
import { useSkillsStore } from "./skillsStore";
import { useWorkspaceStore } from "./workspaceStore";

let secureStorePromise: Promise<any> | null = null;
async function getSecureStore() {
  if (!secureStorePromise) {
    secureStorePromise = import("expo-secure-store");
  }
  return await secureStorePromise;
}

export async function saveToOfflineCache(key: string, value: any): Promise<void> {
  try {
    const SecureStore = await getSecureStore();
    await SecureStore.setItemAsync(`cowork.cache.${key}`, JSON.stringify(value));
  } catch (err) {
    // Silent fail in tests / environments without SecureStore
  }
}

export async function loadFromOfflineCache<T>(key: string): Promise<T | null> {
  try {
    const SecureStore = await getSecureStore();
    const raw = await SecureStore.getItemAsync(`cowork.cache.${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    return null;
  }
}

export async function loadAllOfflineWorkspaceCache(): Promise<void> {
  try {
    // 1. Workspaces & active workspace
    const workspaces = await loadFromOfflineCache<any[]>("workspaces");
    const activeWorkspaceId = await loadFromOfflineCache<string>("activeWorkspaceId");
    const activeWorkspaceName = await loadFromOfflineCache<string>("activeWorkspaceName");
    const activeWorkspaceCwd = await loadFromOfflineCache<string>("activeWorkspaceCwd");
    const controlSnapshot = await loadFromOfflineCache<any>("controlSnapshot");

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
    const catalog = await loadFromOfflineCache<any[]>("providerCatalog");
    const authMethods = await loadFromOfflineCache<any>("providerAuthMethods");
    const status = await loadFromOfflineCache<any>("providerStatus");
    if (catalog || authMethods || status) {
      useProviderStore.setState({
        catalog: catalog ?? [],
        authMethodsByProvider: authMethods ?? {},
        statusByProvider: status ?? {},
      });
    }

    // 3. MCP Servers
    const mcpServers = await loadFromOfflineCache<any[]>("mcpServers");
    const mcpFiles = await loadFromOfflineCache<any[]>("mcpFiles");
    const mcpWarnings = await loadFromOfflineCache<any[]>("mcpWarnings");
    if (mcpServers) {
      useMcpStore.setState({
        servers: mcpServers,
        files: mcpFiles ?? [],
        warnings: mcpWarnings ?? [],
      });
    }

    // 4. Skills
    const skills = await loadFromOfflineCache<any[]>("skills");
    const skillsCatalog = await loadFromOfflineCache<any>("skillsCatalog");
    const skillsInstallations = await loadFromOfflineCache<any[]>("skillsInstallations");
    const skillsEffectiveInstallations = await loadFromOfflineCache<any[]>(
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
    const memories = await loadFromOfflineCache<any[]>("memories");
    if (memories) {
      useMemoryStore.setState({
        entries: memories,
      });
    }

    // 6. Backups
    const backups = await loadFromOfflineCache<any[]>("backups");
    const workspacePath = await loadFromOfflineCache<string>("workspacePath");
    if (backups) {
      useBackupStore.setState({
        backups,
        workspacePath: workspacePath ?? null,
      });
    }
  } catch (err) {
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
