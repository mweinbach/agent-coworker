import {
  type AppStoreState,
  reactivateWorkspaceJsonRpcState,
  type StoreGet,
  type StoreSet,
} from "../src/app/store.helpers";
import { defaultWorkspaceRuntime, RUNTIME } from "../src/app/store.helpers/runtimeState";
import type { WorkspaceRuntime } from "../src/app/types";

export { defaultWorkspaceRuntime, RUNTIME };

/** Distinct from control-socket tests (`ws-skills`) so parallel CI runs do not share disposed JSON-RPC state. */
export const workspaceId = "ws-skills-store-actions";
export const secondaryWorkspaceId = "ws-skills-secondary";

type HarnessWorkspace = { id: string; path: string };

export type StoreActionHarnessState = {
  selectedWorkspaceId: string | null;
  pluginManagementWorkspaceId: string | null;
  pluginManagementMode: "auto" | "global" | "workspace";
  workspaces: HarnessWorkspace[];
  workspaceRuntimeById: Record<string, WorkspaceRuntime>;
  notifications: AppStoreState["notifications"];
};

export function createState(): StoreActionHarnessState {
  return {
    selectedWorkspaceId: workspaceId,
    pluginManagementWorkspaceId: null,
    pluginManagementMode: "auto",
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
