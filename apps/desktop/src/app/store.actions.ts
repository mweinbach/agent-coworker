import { createA2uiDockActions } from "./store.actions/a2uiDock";
import { createWorkspaceBackupActions } from "./store.actions/backup";
import { createBootstrapActions } from "./store.actions/bootstrap";
import { createOpenAiNativeConnectorActions } from "./store.actions/connectors";
import { createExplorerActions } from "./store.actions/explorer";
import { createImportActions } from "./store.actions/import";
import { createWorkspaceMcpActions } from "./store.actions/mcp";
import { createWorkspaceMemoryActions } from "./store.actions/memory";
import { createOnboardingActions } from "./store.actions/onboarding";
import { createPluginActions } from "./store.actions/plugins";
import { createPreviewActions } from "./store.actions/preview";
import { createProviderActions } from "./store.actions/provider";
import { createResearchActions } from "./store.actions/research";
import { createRuntimeDiagnosticsActions } from "./store.actions/runtimeDiagnostics";
import { createSkillActions } from "./store.actions/skills";
import { createThreadActions } from "./store.actions/thread";
import { createWorkspaceActions } from "./store.actions/workspace";
import { createWorkspaceDefaultsActions } from "./store.actions/workspaceDefaults";
import type { AppStoreActions, StoreGet, StoreSet } from "./store.helpers";

export function createAppActions(set: StoreSet, get: StoreGet): AppStoreActions {
  return {
    ...createBootstrapActions(set, get),
    ...createWorkspaceActions(set, get),
    ...createWorkspaceBackupActions(set, get),
    ...createThreadActions(set, get),
    ...createSkillActions(set, get),
    ...createPluginActions(set, get),
    ...createImportActions(set, get),
    ...createResearchActions(set, get),
    ...createWorkspaceDefaultsActions(set, get),
    ...createWorkspaceMcpActions(set, get),
    ...createOpenAiNativeConnectorActions(set, get),
    ...createWorkspaceMemoryActions(set, get),
    ...createProviderActions(set, get),
    ...createRuntimeDiagnosticsActions(set, get),
    ...createExplorerActions(set, get),
    ...createPreviewActions(set, get),
    ...createOnboardingActions(set, get),
    ...createA2uiDockActions(set, get),
  };
}
