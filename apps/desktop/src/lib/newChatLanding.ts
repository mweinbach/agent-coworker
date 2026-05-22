import type { WorkspaceRecord } from "../app/types";
import { isOneOffChatWorkspace } from "../app/types";

export type NewChatLandingTarget =
  | {
      kind: "project";
      workspaceId: string;
    }
  | {
      kind: "oneOff";
    };

export function resolveDefaultNewChatTarget(
  workspaces: WorkspaceRecord[],
  selectedWorkspaceId: string | null,
): NewChatLandingTarget {
  const projectWorkspaces = workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace));
  const selectedProject = projectWorkspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );
  if (selectedProject) {
    return { kind: "project", workspaceId: selectedProject.id };
  }
  const firstProject = projectWorkspaces[0];
  return firstProject ? { kind: "project", workspaceId: firstProject.id } : { kind: "oneOff" };
}

export function resolveNewChatLandingTarget(
  target: NewChatLandingTarget | null,
  workspaces: WorkspaceRecord[],
  selectedWorkspaceId: string | null,
): NewChatLandingTarget {
  if (target) {
    if (target.kind === "oneOff") {
      return target;
    }
    const projectWorkspaces = workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace));
    if (projectWorkspaces.some((workspace) => workspace.id === target.workspaceId)) {
      return target;
    }
  }
  return resolveDefaultNewChatTarget(workspaces, selectedWorkspaceId);
}

export function resolveNewChatLandingProjectWorkspaceId(
  target: NewChatLandingTarget | null,
  workspaces: WorkspaceRecord[],
  selectedWorkspaceId: string | null,
): string | null {
  const resolvedTarget = resolveNewChatLandingTarget(target, workspaces, selectedWorkspaceId);
  return resolvedTarget.kind === "project" ? resolvedTarget.workspaceId : null;
}
