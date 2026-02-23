import type { AppStoreActions, StoreGet, StoreSet } from "./store.helpers";

import { createBootstrapActions } from "./store.actions/bootstrap";
import { createExplorerActions } from "./store.actions/explorer";
import { createWorkspaceMcpActions } from "./store.actions/mcp";
import { createProviderActions } from "./store.actions/provider";
import { createSkillActions } from "./store.actions/skills";
import { createThreadActions } from "./store.actions/thread";
import { createWorkspaceActions } from "./store.actions/workspace";
import { createWorkspaceDefaultsActions } from "./store.actions/workspaceDefaults";

export function createAppActions(set: StoreSet, get: StoreGet): AppStoreActions {
  return {
    ...createBootstrapActions(set, get),
    ...createWorkspaceActions(set, get),
    ...createThreadActions(set, get),
    ...createSkillActions(set, get),
    ...createWorkspaceDefaultsActions(set, get),
    ...createWorkspaceMcpActions(set, get),
    ...createProviderActions(set, get),
    ...createExplorerActions(set, get),
  };
}
