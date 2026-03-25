import { create } from "zustand";

import type {
  JsonRpcControlRequest,
  JsonRpcControlResult,
  McpServerEntry,
} from "../../../../../src/shared/jsonrpcControlSchemas";
import { callParsedControlMethod } from "./controlRpc";
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
  legacy: McpServersEvent["legacy"] | null;
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
  refresh(): Promise<void>;
  upsertServer(
    server: JsonRpcControlRequest<"cowork/mcp/server/upsert">["server"],
    previousName?: string,
  ): Promise<void>;
  validateServer(name: string): Promise<void>;
  deleteServer(name: string): Promise<void>;
  authorizeServer(name: string): Promise<void>;
  callbackServer(name: string, code?: string): Promise<void>;
  setServerApiKey(name: string, apiKey: string): Promise<void>;
  migrateLegacy(scope: "workspace" | "user"): Promise<void>;
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
  return {
    servers: event.servers,
    legacy: event.legacy,
    files: event.files,
    warnings: event.warnings ?? [],
  };
}

export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  legacy: null,
  files: [],
  warnings: [],
  validationByName: {},
  loading: false,
  error: null,
  lastAuthChallenge: null,
  lastAuthResult: null,

  async fetchServers() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const result = await callParsedControlMethod(client, "cowork/mcp/servers/read", { cwd });
      set({ ...applyServersEvent(result.event), loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async refresh() {
    await get().fetchServers();
  },

  async upsertServer(server, previousName) {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
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
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async validateServer(name: string) {
    const { client, cwd } = getClientAndCwd();
    try {
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
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/mcp/server/delete", { cwd, name });
      set({
        ...applyServersEvent(result.event),
        validationByName: Object.fromEntries(
          Object.entries(get().validationByName).filter(([entryName]) => entryName !== name),
        ),
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async authorizeServer(name: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/mcp/server/auth/authorize", { cwd, name });
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
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async callbackServer(name: string, code?: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/mcp/server/auth/callback", {
        cwd,
        name,
        ...(code?.trim() ? { code: code.trim() } : {}),
      });
      set({
        lastAuthChallenge: null,
        lastAuthResult: {
          name: result.event.name,
          ok: result.event.ok,
          mode: result.event.mode,
          message: result.event.message,
        },
      });
      await get().fetchServers();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async setServerApiKey(name: string, apiKey: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/mcp/server/auth/setApiKey", {
        cwd,
        name,
        apiKey,
      });
      set({
        lastAuthChallenge: null,
        lastAuthResult: {
          name: result.event.name,
          ok: result.event.ok,
          mode: result.event.mode,
          message: result.event.message,
        },
      });
      await get().fetchServers();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async migrateLegacy(scope: "workspace" | "user") {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const result = await callParsedControlMethod(client, "cowork/mcp/legacy/migrate", { cwd, scope });
      set({
        ...applyServersEvent(result.event),
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  clear() {
    set({
      servers: [],
      legacy: null,
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
