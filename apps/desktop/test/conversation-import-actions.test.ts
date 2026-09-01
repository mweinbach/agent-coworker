import { beforeEach, describe, expect, test } from "bun:test";
import type { JsonRpcSocket } from "../src/lib/agentSocket";
import {
  createState,
  createStoreHarness,
  defaultWorkspaceRuntime,
  RUNTIME,
  resetSkillPluginActionRuntime,
  secondaryWorkspaceId,
  workspaceId,
} from "./skill-plugin-actions.harness";

const { createImportActions } = await import("../src/app/store.actions/import");

describe("conversation import store actions", () => {
  beforeEach(() => {
    resetSkillPluginActionRuntime();
  });

  test("hydrates newly imported workspaces before refreshing their threads", async () => {
    const state = Object.assign(createState(), {
      threads: [],
      threadRuntimeById: {},
      selectedThreadId: null,
      selectedTaskId: null,
      view: "chat",
      lastNonSettingsView: "chat",
    });
    for (const id of [workspaceId, secondaryWorkspaceId]) {
      state.workspaceRuntimeById[id] = {
        ...defaultWorkspaceRuntime(),
        serverUrl: `ws://${id}`,
        controlSessionId: "control",
      };
    }
    const importedWorkspace = {
      id: secondaryWorkspaceId,
      path: "/tmp/imported-project",
      name: "Imported project",
      workspaceKind: "project" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
      lastOpenedAt: "2026-09-01T00:00:00.000Z",
      defaultEnableMcp: true,
      defaultBackupsEnabled: false,
      yolo: false,
    };
    const importResult = {
      imported: [
        {
          source: "codex",
          fingerprint: "new-fp",
          threadId: "new-thread",
          workspaceId: secondaryWorkspaceId,
          workspacePath: importedWorkspace.path,
          title: "Imported chat",
        },
      ],
      skipped: [],
      failed: [],
      createdWorkspaces: [
        {
          workspaceId: secondaryWorkspaceId,
          path: importedWorkspace.path,
          name: importedWorkspace.name,
        },
      ],
    };
    const listRequests: unknown[] = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => importResult,
      respond: () => true,
      close: () => {},
    } as never);
    RUNTIME.jsonRpcSockets.set(secondaryWorkspaceId, {
      readyPromise: Promise.resolve(),
      request: async (_method: string, params: unknown) => {
        listRequests.push(params);
        return {
          threads: [
            {
              id: "new-thread",
              title: "Imported chat",
              preview: "Imported",
              modelProvider: "openai",
              model: "gpt-5.5",
              cwd: importedWorkspace.path,
              createdAt: importedWorkspace.createdAt,
              updatedAt: importedWorkspace.createdAt,
              messageCount: 1,
              lastEventSeq: 1,
              status: { type: "notLoaded" },
            },
          ],
        };
      },
      respond: () => true,
      close: () => {},
    } as never);
    const { get, set } = createStoreHarness(state);
    const existingWorkspace = state.workspaces[0];
    const actions = createImportActions(set, get, {
      loadState: async () => ({ version: 2, workspaces: [importedWorkspace], threads: [] }),
    });

    await actions.importConversations({ selected: [{ source: "codex", fingerprint: "new-fp" }] });

    expect(state.workspaces).toContainEqual(importedWorkspace);
    expect(state.workspaces[0]).toBe(existingWorkspace);
    expect(listRequests).toEqual([{ cwd: importedWorkspace.path }]);
    expect(state.threads).toContainEqual(
      expect.objectContaining({ id: "new-thread", workspaceId: secondaryWorkspaceId }),
    );
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
