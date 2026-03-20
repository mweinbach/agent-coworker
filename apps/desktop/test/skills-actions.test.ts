import { beforeEach, describe, expect, mock, test } from "bun:test";

let sendControlResult = false;

mock.module("../src/lib/desktopCommands", () => ({
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  stopWorkspaceServer: async () => {},
  openPath: async () => {},
  revealPath: async () => {},
  copyPath: async () => {},
  createDirectory: async () => {},
  renamePath: async () => {},
  trashPath: async () => {},
}));

mock.module("../src/app/store.helpers", () => ({
  RUNTIME: { controlSockets: new Map() },
  appendThreadTranscript: async () => {},
  basename: (value: string) => value.split("/").at(-1) ?? value,
  buildContextPreamble: () => "",
  ensureControlSocket: () => null,
  ensureServerRunning: async () => {},
  ensureThreadRuntime: () => {},
  ensureWorkspaceRuntime: () => {},
  isProviderName: () => true,
  makeId: () => "note-1",
  mapTranscriptToFeed: () => [],
  normalizeThreadTitleSource: () => "manual",
  nowIso: () => "2026-03-20T00:00:00.000Z",
  persistNow: async () => {},
  providerAuthMethodsFor: () => [],
  pushNotification: <T>(notifications: T[], entry: T) => [...notifications, entry],
  queuePendingThreadMessage: () => {},
  sendControl: () => sendControlResult,
  sendThread: () => true,
  sendUserMessageToThread: async () => {},
  syncDesktopStateCache: () => {},
  truncateTitle: (value: string) => value,
}));

const { createSkillActions } = await import("../src/app/store.actions/skills");

const workspaceId = "ws-skills";

function createState() {
  return {
    selectedWorkspaceId: workspaceId,
    workspaceRuntimeById: {
      [workspaceId]: {
        skillCatalogLoading: false,
        skillCatalogError: "stale error",
        skillMutationPendingKeys: {},
        skillMutationError: "stale mutation error",
      },
    },
    notifications: [],
  };
}

function createStoreHarness(state: ReturnType<typeof createState>) {
  const get = () => state as any;
  const set = (updater: any) => {
    const patch = typeof updater === "function" ? updater(state as any) : updater;
    Object.assign(state, patch);
  };
  return { get, set };
}

describe("skill store actions", () => {
  beforeEach(() => {
    sendControlResult = false;
  });

  test("refreshSkillsCatalog clears loading when sendControl fails", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);

    await createSkillActions(set as any, get as any).refreshSkillsCatalog();

    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogError).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });

  test("previewSkillInstall removes only its pending key when sendControl fails", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys = { other: true };
    const { get, set } = createStoreHarness(state);

    await createSkillActions(set as any, get as any).previewSkillInstall("owner/repo", "project");

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ other: true });
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });

  test("installSkills removes only its pending key when sendControl fails", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys = { other: true };
    const { get, set } = createStoreHarness(state);

    await createSkillActions(set as any, get as any).installSkills("owner/repo", "global");

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ other: true });
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });
});
