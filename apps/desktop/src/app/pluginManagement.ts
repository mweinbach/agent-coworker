import type { WorkspaceRecord } from "./types";

function hasWorkspaceId(workspaces: WorkspaceRecord[], workspaceId: string | null | undefined): workspaceId is string {
  return typeof workspaceId === "string" && workspaces.some((workspace) => workspace.id === workspaceId);
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
}): {
  selectedWorkspaceId: string | null;
  pluginManagementWorkspaceId: string | null;
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

  return {
    selectedWorkspaceId,
    pluginManagementWorkspaceId,
    catalogWorkspaceId: pluginManagementWorkspaceId ?? selectedWorkspaceId,
    managementScope: pluginManagementWorkspaceId ? "workspace" : "global",
  };
}
