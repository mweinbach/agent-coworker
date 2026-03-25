import { create } from "zustand";

import type {
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderStatusEntry,
} from "../../../../../src/shared/jsonrpcControlSchemas";
import { callParsedControlMethod } from "./controlRpc";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";

type ProviderStoreState = {
  catalog: ProviderCatalogEntry[];
  authMethodsByProvider: Record<string, ProviderAuthMethod[]>;
  statusByProvider: Record<string, ProviderStatusEntry>;
  loading: boolean;
  error: string | null;
  lastAuthChallenge: { provider: string; methodId: string; instructions: string; url?: string } | null;
  lastAuthResult: { provider: string; methodId: string; ok: boolean; message: string } | null;

  fetchCatalog(): Promise<void>;
  fetchAuthMethods(): Promise<void>;
  fetchStatus(): Promise<void>;
  refresh(): Promise<void>;
  setApiKey(provider: string, methodId: string, apiKey: string): Promise<void>;
  copyApiKey(provider: string, sourceProvider: string): Promise<void>;
  authorize(provider: string, methodId: string): Promise<void>;
  logout(provider: string): Promise<void>;
  callback(provider: string, methodId: string, code?: string): Promise<void>;
  clear(): void;
};

function getClientAndCwd() {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

function toStatusByProvider(statuses: ProviderStatusEntry[]): Record<string, ProviderStatusEntry> {
  return Object.fromEntries(statuses.map((status) => [status.provider, status]));
}

export const useProviderStore = create<ProviderStoreState>((set, get) => ({
  catalog: [],
  authMethodsByProvider: {},
  statusByProvider: {},
  loading: false,
  error: null,
  lastAuthChallenge: null,
  lastAuthResult: null,

  async fetchCatalog() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const result = await callParsedControlMethod(client, "cowork/provider/catalog/read", { cwd });
      set({ catalog: result.event.all, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async fetchAuthMethods() {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/provider/authMethods/read", { cwd });
      set({ authMethodsByProvider: result.event.methods });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async fetchStatus() {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/provider/status/refresh", { cwd });
      set({ statusByProvider: toStatusByProvider(result.event.providers) });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async refresh() {
    set({ loading: true, error: null });
    try {
      await Promise.all([
        get().fetchCatalog(),
        get().fetchAuthMethods(),
        get().fetchStatus(),
      ]);
      set({ loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async setApiKey(provider: string, methodId: string, apiKey: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/provider/auth/setApiKey", {
        cwd,
        provider: provider as any,
        methodId,
        apiKey,
      });
      set({
        lastAuthChallenge: null,
        lastAuthResult: {
          provider: result.event.provider,
          methodId: result.event.methodId,
          ok: result.event.ok,
          message: result.event.message,
        },
      });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async copyApiKey(provider: string, sourceProvider: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/provider/auth/copyApiKey", {
        cwd,
        provider: provider as any,
        sourceProvider: sourceProvider as any,
      });
      set({
        lastAuthChallenge: null,
        lastAuthResult: {
          provider: result.event.provider,
          methodId: result.event.methodId,
          ok: result.event.ok,
          message: result.event.message,
        },
      });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async authorize(provider: string, methodId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/provider/auth/authorize", {
        cwd,
        provider: provider as any,
        methodId,
      });
      if (result.event.type === "provider_auth_challenge") {
        set({
          lastAuthChallenge: {
            provider: result.event.provider,
            methodId: result.event.methodId,
            instructions: result.event.challenge.instructions,
            url: result.event.challenge.url,
          },
          lastAuthResult: null,
        });
        return;
      }
      set({
        lastAuthChallenge: null,
        lastAuthResult: {
          provider: result.event.provider,
          methodId: result.event.methodId,
          ok: result.event.ok,
          message: result.event.message,
        },
      });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async logout(provider: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/provider/auth/logout", {
        cwd,
        provider: provider as any,
      });
      set({
        lastAuthChallenge: null,
        lastAuthResult: {
          provider: result.event.provider,
          methodId: result.event.methodId,
          ok: result.event.ok,
          message: result.event.message,
        },
      });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async callback(provider: string, methodId: string, code?: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/provider/auth/callback", {
        cwd,
        provider: provider as any,
        methodId,
        ...(code ? { code } : {}),
      });
      set({
        lastAuthChallenge: null,
        lastAuthResult: {
          provider: result.event.provider,
          methodId: result.event.methodId,
          ok: result.event.ok,
          message: result.event.message,
        },
      });
      await get().refresh();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  clear() {
    set({
      catalog: [],
      authMethodsByProvider: {},
      statusByProvider: {},
      loading: false,
      error: null,
      lastAuthChallenge: null,
      lastAuthResult: null,
    });
  },
}));
