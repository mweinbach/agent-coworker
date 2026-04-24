import type { PluginManagementMode, WorkspaceRecord } from "./types";

function hasWorkspaceId(
  workspaces: WorkspaceRecord[],
  workspaceId: string | null | undefined,
): workspaceId is string {
  return (
    typeof workspaceId === "string" && workspaces.some((workspace) => workspace.id === workspaceId)
  );
}

export function resolvePluginManagementWorkspaceId(
  workspaces: WorkspaceRecord[],
  workspaceId: string | null | undefined,
): string | null {
  return hasWorkspaceId(workspaces, workspaceId) ? workspaceId : null;
}

export function resolvePluginCatalogWorkspaceSelection(opts: {
  workspaces: WorkspaceRecord[];
  selectedWorkspaceId: string | null | undefined;
  pluginManagementWorkspaceId: string | null | undefined;
  pluginManagementMode?: PluginManagementMode | null | undefined;
}): {
  selectedWorkspaceId: string | null;
  pluginManagementWorkspaceId: string | null;
  pluginManagementMode: PluginManagementMode;
  displayWorkspaceId: string | null;
  catalogWorkspaceId: string | null;
  managementScope: "workspace" | "global";
} {
  const selectedWorkspaceId = hasWorkspaceId(opts.workspaces, opts.selectedWorkspaceId)
    ? opts.selectedWorkspaceId
    : null;
  const pluginManagementWorkspaceId = resolvePluginManagementWorkspaceId(
    opts.workspaces,
    opts.pluginManagementWorkspaceId,
  );
  const pluginManagementMode =
    opts.pluginManagementMode === "global" || opts.pluginManagementMode === "workspace"
      ? opts.pluginManagementMode
      : "auto";
  const catalogWorkspaceId = pluginManagementWorkspaceId ?? selectedWorkspaceId;
  const managementScope = pluginManagementMode === "workspace" ? "workspace" : "global";
  const displayWorkspaceId =
    managementScope === "workspace" ? (pluginManagementWorkspaceId ?? selectedWorkspaceId) : null;

  return {
    selectedWorkspaceId,
    pluginManagementWorkspaceId,
    pluginManagementMode,
    displayWorkspaceId,
    catalogWorkspaceId,
    managementScope,
  };
}
