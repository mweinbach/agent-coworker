import type { CoworkJsonRpcClient } from "./jsonRpcClient";
import type { CoworkThread, WorkspaceSummary } from "./protocolTypes";

export const PROJECT_THREAD_LIMIT = 5;
export const ONE_OFF_CHAT_WORKSPACE_LIMIT = 10;

type ThreadListClient = Pick<CoworkJsonRpcClient, "requestThreadList">;

function sortWorkspacesByLastOpened(workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) =>
    (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? ""),
  );
}

export function buildWorkspaceLookup(workspaces: WorkspaceSummary[]): Map<string, WorkspaceSummary> {
  const lookup = new Map<string, WorkspaceSummary>();
  for (const workspace of workspaces) {
    lookup.set(workspace.path, workspace);
  }
  return lookup;
}

export async function loadBoundedRemoteThreads(
  client: ThreadListClient,
  workspaces: WorkspaceSummary[],
): Promise<CoworkThread[]> {
  const merged = new Map<string, CoworkThread>();

  for (const entry of buildRemoteThreadLoadPlan(workspaces)) {
    let result: Awaited<ReturnType<ThreadListClient["requestThreadList"]>>;
    try {
      result = await client.requestThreadList(entry.cwd, entry.limit);
    } catch {
      // Keep hydrating the remaining workspaces; a stale catalog entry should not blank the list.
      continue;
    }
    for (const thread of result.threads) {
      merged.set(thread.id, thread);
    }
  }

  return Array.from(merged.values());
}

export function buildRemoteThreadLoadPlan(workspaces: WorkspaceSummary[]): Array<{
  cwd: string;
  limit?: number;
}> {
  const projectWorkspaces = sortWorkspacesByLastOpened(
    workspaces.filter((workspace) => workspace.workspaceKind !== "oneOffChat"),
  );
  const oneOffWorkspaces = sortWorkspacesByLastOpened(
    workspaces.filter((workspace) => workspace.workspaceKind === "oneOffChat"),
  ).slice(0, ONE_OFF_CHAT_WORKSPACE_LIMIT);

  return [
    ...projectWorkspaces.map((workspace) => ({
      cwd: workspace.path,
      limit: PROJECT_THREAD_LIMIT,
    })),
    ...oneOffWorkspaces.map((workspace) => ({
      cwd: workspace.path,
    })),
  ];
}
