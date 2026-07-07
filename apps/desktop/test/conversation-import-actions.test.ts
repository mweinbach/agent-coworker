import { beforeEach, describe, expect, test } from "bun:test";
import type { JsonRpcSocket } from "../src/lib/agentSocket";
import {
  createState,
  createStoreHarness,
  defaultWorkspaceRuntime,
  RUNTIME,
  resetSkillPluginActionRuntime,
  workspaceId,
} from "./skill-plugin-actions.harness";

const { createImportActions } = await import("../src/app/store.actions/import");

describe("conversation import store actions", () => {
  beforeEach(() => {
    resetSkillPluginActionRuntime();
  });

  test("requests conversation import sources over JSON-RPC", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
    };
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: unknown }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {
          sources: [
            {
              source: "codex",
              id: "codex:/tmp/state.sqlite",
              path: "/tmp/state.sqlite",
              available: true,
              conversationCount: 1,
            },
          ],
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const result = await createImportActions(set, get).listConversationImportSources({
      includeCodex: true,
    });

    expect(requests).toEqual([
      {
        method: "cowork/conversationImport/sources/list",
        params: { includeCodex: true },
      },
    ]);
    expect(result.sources[0]?.source).toBe("codex");
  });

  test("refreshes imported workspaces after a successful import", async () => {
    const state = createState();
    Object.assign(state, {
      threads: [],
      threadRuntimeById: {},
      selectedThreadId: null,
      selectedTaskId: null,
      view: "chat",
      lastNonSettingsView: "chat",
    });
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
    };
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: unknown }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/list") {
          return {
            threads: [
              {
                id: "imported-thread",
                title: "Imported chat",
                preview: "Imported",
                modelProvider: "openai",
                model: "gpt-5.5",
                cwd: "/tmp/workspace",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:01.000Z",
                messageCount: 1,
                lastEventSeq: 1,
                status: { type: "notLoaded" },
              },
            ],
          };
        }
        return {
          imported: [
            {
              source: "codex",
              fingerprint: "fp",
              threadId: "imported-thread",
              workspaceId,
              workspacePath: "/tmp/workspace",
              title: "Imported chat",
            },
          ],
          skipped: [],
          failed: [],
          createdWorkspaces: [],
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const result = await createImportActions(set, get).importConversations({
      selected: [{ source: "codex", fingerprint: "fp" }],
    });

    expect(result.imported[0]?.threadId).toBe("imported-thread");
    expect(requests.map((request) => request.method)).toEqual([
      "cowork/conversationImport/import",
      "thread/list",
    ]);
    const threads = (state as unknown as { threads: Array<{ id: string }> }).threads;
    expect(threads.some((thread) => thread.id === "imported-thread")).toBe(true);
  });
});
