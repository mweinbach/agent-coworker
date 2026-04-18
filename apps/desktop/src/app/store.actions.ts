import type { AppStoreActions, StoreGet, StoreSet } from "./store.helpers";

import { createA2uiDockActions } from "./store.actions/a2uiDock";
import { createWorkspaceBackupActions } from "./store.actions/backup";
import { createBootstrapActions } from "./store.actions/bootstrap";
import { createExplorerActions } from "./store.actions/explorer";
import { createWorkspaceMcpActions } from "./store.actions/mcp";
import { createWorkspaceMemoryActions } from "./store.actions/memory";
import { createProviderActions } from "./store.actions/provider";
import { createSkillActions } from "./store.actions/skills";
import { createThreadActions } from "./store.actions/thread";
import { createWorkspaceActions } from "./store.actions/workspace";
import { createWorkspaceDefaultsActions } from "./store.actions/workspaceDefaults";
import { createOnboardingActions } from "./store.actions/onboarding";

export function createAppActions(set: StoreSet, get: StoreGet): AppStoreActions {
  return {
    ...createBootstrapActions(set, get),
    ...createWorkspaceActions(set, get),
    ...createWorkspaceBackupActions(set, get),
    ...createThreadActions(set, get),
    ...createSkillActions(set, get),
    ...createWorkspaceDefaultsActions(set, get),
    ...createWorkspaceMcpActions(set, get),
    ...createWorkspaceMemoryActions(set, get),
    ...createProviderActions(set, get),
    ...createExplorerActions(set, get),
    ...createOnboardingActions(set, get),
    ...createA2uiDockActions(set, get),
  };
}
