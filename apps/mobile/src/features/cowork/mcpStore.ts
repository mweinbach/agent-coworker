import { create } from "zustand";

import type {
  JsonRpcControlRequest,
  JsonRpcControlResult,
  McpServerEntry,
} from "@/cowork-shared/jsonrpcControlSchemas";
import { callParsedControlMethod, isStaleWorkspaceRequestError } from "./controlRpc";
import { saveToOfflineCache } from "./offlineCacheStorage";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";

type McpServersEvent = JsonRpcControlResult<"cowork/mcp/servers/read">["event"];
type McpValidationState = JsonRpcControlResult<"cowork/mcp/server/validate">["event"];
type McpAuthChallenge = Extract<
  JsonRpcControlResult<"cowork/mcp/server/auth/authorize">["event"],
  { type: "mcp_server_auth_challenge" }
>;
type McpAuthResult = JsonRpcControlResult<"cowork/mcp/server/auth/callback">["event"];
export type McpUpsertServer = JsonRpcControlRequest<"cowork/mcp/server/upsert">["server"];

type McpStoreState = {
  servers: McpServerEntry[];
  files: McpServersEvent["files"];
  warnings: string[];
  validationByName: Record<string, McpValidationState>;
  loading: boolean;
  error: string | null;
  lastAuthChallenge: {
    name: string;
    instructions: string;
    url?: string;
    expiresAt?: string;
  } | null;
  lastAuthResult: {
    name: string;
    ok: boolean;
    mode?: string;
    message: string;
  } | null;

  fetchServers(): Promise<void>;
  upsertServer(
    server: JsonRpcControlRequest<"cowork/mcp/server/upsert">["server"],
    previousName?: string,
  ): Promise<boolean>;
  validateServer(name: string): Promise<void>;
  deleteServer(name: string): Promise<void>;
  authorizeServer(name: string): Promise<void>;
  callbackServer(name: string, code?: string): Promise<boolean>;
  setServerApiKey(name: string, apiKey: string): Promise<boolean>;
  clear(): void;
};

function getClientAndCwd() {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

function applyServersEvent(event: McpServersEvent) {
  void saveToOfflineCache("mcpServers", event.servers);
  void saveToOfflineCache("mcpFiles", event.files);
  void saveToOfflineCache("mcpWarnings", event.warnings ?? []);
  return {
    servers: event.servers,
    files: event.files,
    warnings: event.warnings ?? [],
  };
}

export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  files: [],
  warnings: [],
  validationByName: {},
  loading: false,
  error: null,
  lastAuthChallenge: null,
  lastAuthResult: null,

  async fetchServers() {
    set({ loading: true, error: null });
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/mcp/servers/read", { cwd });
      set({ ...applyServersEvent(result.event), loading: false });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async upsertServer(server, previousName) {
    set({ loading: true, error: null });
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/mcp/server/upsert", {
        cwd,
        server,
        ...(previousName ? { previousName } : {}),
      });
      set({
        ...applyServersEvent(result.event),
        loading: false,
        lastAuthChallenge: null,
      });
      return true;
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return false;
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },

  async validateServer(name: string) {
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/mcp/server/validate", {
        cwd,
        name,
      });
      set({
        validationByName: {
          ...get().validationByName,
          [name]: result.event,
        },
      });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({
        validationByName: {
          ...get().validationByName,
          [name]: {
            type: "mcp_server_validation",
            name,
            ok: false,
            mode: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  },

  async deleteServer(name: string) {
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/mcp/server/delete", {
        cwd,
        name,
      });
      set({
        ...applyServersEvent(result.event),
        validationByName: Object.fromEntries(
          Object.entries(get().validationByName).filter(([entryName]) => entryName !== name),
        ),
      });
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async authorizeServer(name: string) {
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/mcp/server/auth/authorize", {
        cwd,
        name,
      });
      if (result.event.type === "mcp_server_auth_challenge") {
        const challenge: McpAuthChallenge = result.event;
        set({
          lastAuthChallenge: {
            name: challenge.name,
            instructions: challenge.challenge.instructions,
            url: challenge.challenge.url,
            expiresAt: challenge.challenge.expiresAt,
          },
          lastAuthResult: null,
        });
        return;
      }
      const authResult = result.event as McpAuthResult;
      set({
        lastAuthChallenge: null,
        lastAuthResult: {
          name: authResult.name,
          ok: authResult.ok,
          mode: authResult.mode,
          message: authResult.message,
        },
      });
      await get().fetchServers();
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async callbackServer(name: string, code?: string) {
    set({ error: null });
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/mcp/server/auth/callback", {
        cwd,
        name,
        ...(code?.trim() ? { code: code.trim() } : {}),
      });
      set({
        ...(result.event.ok ? { lastAuthChallenge: null } : {}),
        error: result.event.ok ? null : result.event.message,
        lastAuthResult: {
          name: result.event.name,
          ok: result.event.ok,
          mode: result.event.mode,
          message: result.event.message,
        },
      });
      if (result.event.ok) await get().fetchServers();
      return result.event.ok;
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return false;
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  async setServerApiKey(name: string, apiKey: string) {
    set({ error: null });
    try {
      const { client, cwd } = getClientAndCwd();
      const result = await callParsedControlMethod(client, "cowork/mcp/server/auth/setApiKey", {
        cwd,
        name,
        apiKey,
      });
      set({
        ...(result.event.ok ? { lastAuthChallenge: null } : {}),
        error: result.event.ok ? null : result.event.message,
        lastAuthResult: {
          name: result.event.name,
          ok: result.event.ok,
          mode: result.event.mode,
          message: result.event.message,
        },
      });
      if (result.event.ok) await get().fetchServers();
      return result.event.ok;
    } catch (error) {
      if (isStaleWorkspaceRequestError(error)) return false;
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  clear() {
    set({
      servers: [],
      files: [],
      warnings: [],
      validationByName: {},
      loading: false,
      error: null,
      lastAuthChallenge: null,
      lastAuthResult: null,
    });
  },
}));
