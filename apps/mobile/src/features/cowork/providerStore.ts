import { create } from "zustand";

import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";
import type { ProviderCatalogEntry } from "./protocolTypes";

type ProviderStoreState = {
  catalog: ProviderCatalogEntry[];
  statusByName: Record<string, string>;
  loading: boolean;
  error: string | null;
  lastAuthChallenge: { provider: string; url: string } | null;

  fetchCatalog(): Promise<void>;
  fetchStatus(): Promise<void>;
  setApiKey(provider: string, methodId: string, apiKey: string): Promise<void>;
  authorize(provider: string, methodId: string): Promise<void>;
  logout(provider: string): Promise<void>;
  callback(provider: string, methodId: string, code: string): Promise<void>;
  clear(): void;
};

function getClientAndCwd() {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

export const useProviderStore = create<ProviderStoreState>((set, get) => ({
  catalog: [],
  statusByName: {},
  loading: false,
  error: null,
  lastAuthChallenge: null,

  async fetchCatalog() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const result = await client.call<{ event: { providers: ProviderCatalogEntry[] } }>(
        "cowork/provider/catalog/read",
        { cwd },
      );
      set({ catalog: result?.event?.providers ?? [], loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async fetchStatus() {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await client.call<{ event: { statusByName: Record<string, string> } }>(
        "cowork/provider/status/read",
        { cwd },
      );
      set({ statusByName: result?.event?.statusByName ?? {} });
    } catch {
      // Non-critical
    }
  },

  async setApiKey(provider: string, methodId: string, apiKey: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/provider/auth/set-api-key", { cwd, provider, methodId, apiKey });
      await get().fetchCatalog();
      await get().fetchStatus();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async authorize(provider: string, methodId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await client.call<{ challenge?: { url: string } }>(
        "cowork/provider/auth/authorize",
        { cwd, provider, methodId },
      );
      if (result?.challenge?.url) {
        set({ lastAuthChallenge: { provider, url: result.challenge.url } });
      } else {
        await get().fetchCatalog();
        await get().fetchStatus();
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async logout(provider: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/provider/auth/logout", { cwd, provider });
      await get().fetchCatalog();
      await get().fetchStatus();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async callback(provider: string, methodId: string, code: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/provider/auth/callback", { cwd, provider, methodId, code });
      set({ lastAuthChallenge: null });
      await get().fetchCatalog();
      await get().fetchStatus();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  clear() {
    set({ catalog: [], statusByName: {}, loading: false, error: null, lastAuthChallenge: null });
  },
}));
