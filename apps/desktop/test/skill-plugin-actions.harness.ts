import { mock } from "bun:test";

import {
  type AppStoreState,
  reactivateWorkspaceJsonRpcState,
  type StoreGet,
  type StoreSet,
} from "../src/app/store.helpers";
import { defaultWorkspaceRuntime, RUNTIME } from "../src/app/store.helpers/runtimeState";
import type { WorkspaceRuntime } from "../src/app/types";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

export { defaultWorkspaceRuntime, RUNTIME };

/** Distinct from control-socket tests (`ws-skills`) so parallel CI runs do not share disposed JSON-RPC state. */
export const workspaceId = "ws-skills-store-actions";
export const secondaryWorkspaceId = "ws-skills-secondary";

const DESKTOP_BRIDGE_UNAVAILABLE = "Desktop bridge unavailable. Start the app via Electron.";

/**
 * Pin `desktopCommands` to the same behavior the real module has when no desktop
 * bridge is present. Other desktop test files register
 * `mock.module("../src/lib/desktopCommands", ...)` mocks that leak across the shared
 * bun test process; a leaked `getWorkspaceServerStatus` reporting `url: "ws://mock"`
 * makes `ensureServerRunning` treat the fake per-workspace server URLs used here as
 * stale, tearing down the fake JSON-RPC sockets these tests install on `RUNTIME`.
 */
function installDesktopCommandsBridgeUnavailableMock() {
  mock.module("../src/lib/desktopCommands", () =>
    createDesktopCommandsMock({
      getWorkspaceServerStatus: async ({ workspaceId: id }) => ({
        workspaceId: id,
        running: true,
        url: null,
        reason: "running",
      }),
      startWorkspaceServer: async () => {
        throw new Error(DESKTOP_BRIDGE_UNAVAILABLE);
      },
      stopWorkspaceServer: async () => {
        throw new Error(DESKTOP_BRIDGE_UNAVAILABLE);
      },
    }),
  );
}

installDesktopCommandsBridgeUnavailableMock();

type HarnessWorkspace = { id: string; path: string };

export type StoreActionHarnessState = {
  selectedWorkspaceId: string | null;
  workspaces: HarnessWorkspace[];
  workspaceRuntimeById: Record<string, WorkspaceRuntime>;
  notifications: AppStoreState["notifications"];
};

export function createState(): StoreActionHarnessState {
  return {
    selectedWorkspaceId: workspaceId,
    workspaces: [{ id: workspaceId, path: "/tmp/workspace" }],
    workspaceRuntimeById: {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        skillCatalogError: "stale error",
        skillMutationError: "stale mutation error",
      },
    },
    notifications: [],
  };
}

export function createStoreHarness(state: StoreActionHarnessState) {
  const get: StoreGet = () => state as unknown as AppStoreState;
  const set: StoreSet = (updater) => {
    const patch =
      typeof updater === "function" ? updater(state as unknown as AppStoreState) : updater;
    Object.assign(state, patch);
  };
  return { get, set };
}

export function resetSkillPluginActionRuntime() {
  installDesktopCommandsBridgeUnavailableMock();
  RUNTIME.jsonRpcSockets.clear();
  RUNTIME.skillInstallWaiters.clear();
  RUNTIME.pluginInstallWaiters.clear();
  RUNTIME.agentProfilesCatalogGenerations.clear();
  RUNTIME.workspaceStartPromises.clear();
  RUNTIME.workspaceStartGenerations.clear();
  RUNTIME.workspaceServerRestartAttempts.clear();
  reactivateWorkspaceJsonRpcState(workspaceId);
  reactivateWorkspaceJsonRpcState(secondaryWorkspaceId);
}
