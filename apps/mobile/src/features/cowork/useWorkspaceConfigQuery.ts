import { useQuery } from "@tanstack/react-query";
import type { ProviderStatusEntry } from "@/cowork-shared/jsonrpcControlSchemas";
import { useBackupStore } from "./backupStore";
import { callParsedControlMethod, parseWorkspaceControlSnapshot } from "./controlRpc";
import { useMcpStore } from "./mcpStore";
import { useMemoryStore } from "./memoryStore";
import { saveToOfflineCache } from "./offlineCache";
import { type WorkspaceListResult, workspaceListResultSchema } from "./protocolTypes";
import { useProviderStore } from "./providerStore";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useSkillsStore } from "./skillsStore";
import { useWorkspaceStore } from "./workspaceStore";

export function useWorkspacesQuery() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const client = getActiveCoworkJsonRpcClient();
      if (!client) throw new Error("No active JSON-RPC client.");
      const result = await client.call<WorkspaceListResult>("workspace/list");
      const parsed = workspaceListResultSchema.parse(result);

      const active = parsed.activeWorkspaceId
        ? (parsed.workspaces.find((w) => w.id === parsed.activeWorkspaceId) ?? null)
        : null;

      // Update Zustand store
      useWorkspaceStore.setState({
        workspaces: parsed.workspaces,
        activeWorkspaceId: parsed.activeWorkspaceId,
        activeWorkspaceName: active?.name ?? null,
        activeWorkspaceCwd: active?.path ?? null,
      });

      // Update offline cache
      void saveToOfflineCache("workspaces", parsed.workspaces);
      void saveToOfflineCache("activeWorkspaceId", parsed.activeWorkspaceId);
      void saveToOfflineCache("activeWorkspaceName", active?.name ?? null);
      void saveToOfflineCache("activeWorkspaceCwd", active?.path ?? null);

      return parsed;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes stale time
  });
}

export function useControlStateQuery(cwd: string | null) {
  return useQuery({
    queryKey: ["controlState", cwd],
    queryFn: async () => {
      if (!cwd) return null;
      const client = getActiveCoworkJsonRpcClient();
      if (!client) throw new Error("No active JSON-RPC client.");
      const result = await callParsedControlMethod(client, "cowork/session/state/read", { cwd });
      const snapshot = parseWorkspaceControlSnapshot(result);

      // Update Zustand store
      useWorkspaceStore.setState({
        controlSnapshot: snapshot,
      });

      // Update offline cache
      void saveToOfflineCache("controlSnapshot", snapshot);
      return snapshot;
    },
    enabled: !!cwd,
    staleTime: 1000 * 60 * 5,
  });
}

export function useProviderCatalogQuery(cwd: string | null) {
  return useQuery({
    queryKey: ["providerCatalog", cwd],
    queryFn: async () => {
      if (!cwd) return null;
      const client = getActiveCoworkJsonRpcClient();
      if (!client) throw new Error("No active JSON-RPC client.");

      const [catalogResult, authResult, statusResult] = await Promise.all([
        callParsedControlMethod(client, "cowork/provider/catalog/read", { cwd }),
        callParsedControlMethod(client, "cowork/provider/authMethods/read", { cwd }),
        callParsedControlMethod(client, "cowork/provider/status/refresh", { cwd }),
      ]);

      const toStatusByProvider = (
        statuses: ProviderStatusEntry[],
      ): Partial<Record<ProviderStatusEntry["provider"], ProviderStatusEntry>> => {
        return Object.fromEntries(statuses.map((s) => [s.provider, s]));
      };

      const catalog = catalogResult.event.all;
      const authMethods = authResult.event.methods;
      const statusByProvider = toStatusByProvider(statusResult.event.providers);

      // Update Zustand store
      useProviderStore.setState({
        catalog,
        authMethodsByProvider: authMethods,
        statusByProvider,
      });

      // Update offline cache
      void saveToOfflineCache("providerCatalog", catalog);
      void saveToOfflineCache("providerAuthMethods", authMethods);
      void saveToOfflineCache("providerStatus", statusByProvider);

      return { catalog, authMethods, statusByProvider };
    },
    enabled: !!cwd,
    staleTime: 1000 * 60 * 5,
  });
}

export function useMcpServersQuery(cwd: string | null) {
  return useQuery({
    queryKey: ["mcpServers", cwd],
    queryFn: async () => {
      if (!cwd) return null;
      const client = getActiveCoworkJsonRpcClient();
      if (!client) throw new Error("No active JSON-RPC client.");
      const result = await callParsedControlMethod(client, "cowork/mcp/servers/read", { cwd });

      const event = result.event;

      // Update Zustand store
      useMcpStore.setState({
        servers: event.servers,
        files: event.files,
        warnings: event.warnings ?? [],
      });

      // Update offline cache
      void saveToOfflineCache("mcpServers", event.servers);
      void saveToOfflineCache("mcpFiles", event.files);
      void saveToOfflineCache("mcpWarnings", event.warnings ?? []);

      return event;
    },
    enabled: !!cwd,
    staleTime: 1000 * 60 * 5,
  });
}

export function useSkillsQuery(cwd: string | null) {
  return useQuery({
    queryKey: ["skills", cwd],
    queryFn: async () => {
      if (!cwd) return null;
      const client = getActiveCoworkJsonRpcClient();
      if (!client) throw new Error("No active JSON-RPC client.");

      const [skillsResult, catalogResult] = await Promise.all([
        callParsedControlMethod(client, "cowork/skills/list", { cwd }),
        callParsedControlMethod(client, "cowork/skills/catalog/read", { cwd }),
      ]);

      const skills = skillsResult.event.skills;
      const catalog = catalogResult.event.catalog;

      // Update Zustand store
      useSkillsStore.setState({
        skills,
        catalog,
        installations: catalog.installations,
        effectiveInstallations: catalog.effectiveSkills,
      });

      // Update offline cache
      void saveToOfflineCache("skills", skills);
      void saveToOfflineCache("skillsCatalog", catalog);
      void saveToOfflineCache("skillsInstallations", catalog.installations);
      void saveToOfflineCache("skillsEffectiveInstallations", catalog.effectiveSkills);

      return { skills, catalog };
    },
    enabled: !!cwd,
    staleTime: 1000 * 60 * 5,
  });
}

export function useMemoriesQuery(cwd: string | null) {
  return useQuery({
    queryKey: ["memories", cwd],
    queryFn: async () => {
      if (!cwd) return null;
      const client = getActiveCoworkJsonRpcClient();
      if (!client) throw new Error("No active JSON-RPC client.");
      const result = await callParsedControlMethod(client, "cowork/memory/list", { cwd });

      const memories = result.event.memories;

      // Update Zustand store
      useMemoryStore.setState({
        entries: memories,
      });

      // Update offline cache
      void saveToOfflineCache("memories", memories);

      return memories;
    },
    enabled: !!cwd,
    staleTime: 1000 * 60 * 5,
  });
}

export function useBackupsQuery(cwd: string | null) {
  return useQuery({
    queryKey: ["backups", cwd],
    queryFn: async () => {
      if (!cwd) return null;
      const client = getActiveCoworkJsonRpcClient();
      if (!client) throw new Error("No active JSON-RPC client.");
      const result = await callParsedControlMethod(client, "cowork/backups/workspace/read", {
        cwd,
      });

      const backups = result.event.backups;
      const workspacePath = result.event.workspacePath;

      // Update Zustand store
      useBackupStore.setState({
        backups,
        workspacePath,
      });

      // Update offline cache
      void saveToOfflineCache("backups", backups);
      void saveToOfflineCache("workspacePath", workspacePath);

      return { backups, workspacePath };
    },
    enabled: !!cwd,
    staleTime: 1000 * 60 * 5,
  });
}
