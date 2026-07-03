import { isOneOffChatWorkspace, type WorkspaceRecord } from "./types";

export const CHATS_WORKSPACE_TARGET_ID = "__cowork_chats__";

export type WorkspaceDisplayTarget = {
  id: string;
  label: string;
  kind: "chats" | "project";
  workspaceId: string;
  targetPath: string;
};

export function parentDirectoryPath(input: string): string {
  const trimmed = input.trim().replace(/[\\/]+$/, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSlash > 0 ? trimmed.slice(0, lastSlash) : trimmed;
}

export function workspaceDisplayLabel(
  workspace: Pick<WorkspaceRecord, "name" | "workspaceKind">,
): string {
  return isOneOffChatWorkspace(workspace) ? "Chats" : workspace.name;
}

export function resolveProjectWorkspaceId(
  workspaces: Array<Pick<WorkspaceRecord, "id" | "workspaceKind">>,
  selectedWorkspaceId: string | null,
): string | null {
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  if (selectedWorkspace && !isOneOffChatWorkspace(selectedWorkspace)) {
    return selectedWorkspace.id;
  }
  return workspaces.find((workspace) => !isOneOffChatWorkspace(workspace))?.id ?? null;
}

export function resolveWorkspaceDisplayTargets(
  workspaces: WorkspaceRecord[],
  selectedWorkspaceId: string | null,
): { targets: WorkspaceDisplayTarget[]; activeTarget: WorkspaceDisplayTarget | null } {
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  const oneOffChatWorkspaces = workspaces.filter(isOneOffChatWorkspace);
  const chatAnchor =
    selectedWorkspace && isOneOffChatWorkspace(selectedWorkspace)
      ? selectedWorkspace
      : (oneOffChatWorkspaces[0] ?? null);
  const chatsTarget = chatAnchor
    ? {
        id: CHATS_WORKSPACE_TARGET_ID,
        label: "Chats",
        kind: "chats" as const,
        workspaceId: chatAnchor.id,
        targetPath: parentDirectoryPath(chatAnchor.path),
      }
    : null;
  const projectTargets = workspaces
    .filter((workspace) => !isOneOffChatWorkspace(workspace))
    .map(
      (workspace): WorkspaceDisplayTarget => ({
        id: workspace.id,
        label: workspace.name,
        kind: "project",
        workspaceId: workspace.id,
        targetPath: workspace.path,
      }),
    );
  const targets = chatsTarget ? [chatsTarget, ...projectTargets] : projectTargets;

  const activeTarget =
    selectedWorkspace && isOneOffChatWorkspace(selectedWorkspace)
      ? chatsTarget
      : (targets.find((target) => target.workspaceId === selectedWorkspaceId) ??
        targets[0] ??
        null);

  return { targets, activeTarget };
}

export function workspaceLabelForThread(
  workspaces: WorkspaceRecord[],
  workspaceId: string,
  fallbackLabel: string,
): string {
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  return workspace ? workspaceDisplayLabel(workspace) : fallbackLabel;
}
