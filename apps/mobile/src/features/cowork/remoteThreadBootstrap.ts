import type { CoworkJsonRpcClient } from "./jsonRpcClient";
import type { CoworkThread, WorkspaceSummary } from "./protocolTypes";
import {
  ONE_OFF_CHAT_WORKSPACE_PAGE_SIZE,
  PROJECT_THREAD_PAGE_SIZE,
} from "./threadHomeModel";

export const PROJECT_THREAD_LIMIT = PROJECT_THREAD_PAGE_SIZE;
export const ONE_OFF_CHAT_WORKSPACE_LIMIT = ONE_OFF_CHAT_WORKSPACE_PAGE_SIZE;

type ThreadListClient = Pick<CoworkJsonRpcClient, "requestThreadList">;

export type RemoteThreadLoadEntry = {
  cwd: string;
  limit?: number;
  offset?: number;
  workspaceId?: string;
};

export type RemoteThreadLoadPlanOptions = {
  projectThreadLimit?: number;
  oneOffChatWorkspaceLimit?: number;
  projectThreadLimitsByWorkspaceId?: Record<string, number>;
};

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

export function buildRemoteThreadLoadPlan(
  workspaces: WorkspaceSummary[],
  options: RemoteThreadLoadPlanOptions = {},
): RemoteThreadLoadEntry[] {
  const projectThreadLimit = options.projectThreadLimit ?? PROJECT_THREAD_LIMIT;
  const oneOffChatWorkspaceLimit =
    options.oneOffChatWorkspaceLimit ?? ONE_OFF_CHAT_WORKSPACE_LIMIT;
  const perProjectLimits = options.projectThreadLimitsByWorkspaceId ?? {};

  const projectWorkspaces = sortWorkspacesByLastOpened(
    workspaces.filter((workspace) => workspace.workspaceKind !== "oneOffChat"),
  );
  const oneOffWorkspaces = sortWorkspacesByLastOpened(
    workspaces.filter((workspace) => workspace.workspaceKind === "oneOffChat"),
  ).slice(0, oneOffChatWorkspaceLimit);

  return [
    ...projectWorkspaces.map((workspace) => ({
      cwd: workspace.path,
      workspaceId: workspace.id,
      limit: perProjectLimits[workspace.id] ?? projectThreadLimit,
    })),
    ...oneOffWorkspaces.map((workspace) => ({
      cwd: workspace.path,
      workspaceId: workspace.id,
    })),
  ];
}

export async function loadRemoteThreadsFromPlan(
  client: ThreadListClient,
  plan: RemoteThreadLoadEntry[],
): Promise<{
  threads: CoworkThread[];
  totalsByWorkspaceId: Record<string, number>;
}> {
  if (plan.length === 0) {
    return { threads: [], totalsByWorkspaceId: {} };
  }

  const settled = await Promise.allSettled(
    plan.map(async (entry) => ({
      entry,
      result: await client.requestThreadList(entry.cwd, entry.limit, entry.offset),
    })),
  );

  const merged = new Map<string, CoworkThread>();
  const totalsByWorkspaceId: Record<string, number> = {};
  let successCount = 0;
  let lastError: unknown = null;

  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      lastError = outcome.reason;
      continue;
    }
    successCount += 1;
    const { entry, result } = outcome.value;
    if (entry.workspaceId) {
      totalsByWorkspaceId[entry.workspaceId] = result.total;
    }
    for (const thread of result.threads) {
      merged.set(thread.id, thread);
    }
  }

  if (successCount === 0) {
    const cause = lastError instanceof Error ? lastError : new Error(String(lastError));
    throw new Error(`Failed to load any remote threads from plan: ${cause.message}`, {
      cause,
    });
  }

  return {
    threads: Array.from(merged.values()),
    totalsByWorkspaceId,
  };
}

export async function loadBoundedRemoteThreads(
  client: ThreadListClient,
  workspaces: WorkspaceSummary[],
  options: RemoteThreadLoadPlanOptions = {},
): Promise<{
  threads: CoworkThread[];
  totalsByWorkspaceId: Record<string, number>;
}> {
  return loadRemoteThreadsFromPlan(client, buildRemoteThreadLoadPlan(workspaces, options));
}

export async function loadMoreProjectThreads(
  client: ThreadListClient,
  workspace: WorkspaceSummary,
  currentLimit: number,
  pageSize = PROJECT_THREAD_PAGE_SIZE,
): Promise<{
  threads: CoworkThread[];
  total: number;
  nextLimit: number;
}> {
  const nextLimit = currentLimit + pageSize;
  const result = await client.requestThreadList(workspace.path, nextLimit, 0);
  return {
    threads: result.threads,
    total: result.total,
    nextLimit,
  };
}

export async function loadMoreOneOffChatWorkspaces(
  client: ThreadListClient,
  workspaces: WorkspaceSummary[],
  currentLimit: number,
  pageSize = ONE_OFF_CHAT_WORKSPACE_LIMIT,
): Promise<{
  threads: CoworkThread[];
  totalsByWorkspaceId: Record<string, number>;
  nextLimit: number;
}> {
  const nextLimit = currentLimit + pageSize;
  const oneOffWorkspaces = sortWorkspacesByLastOpened(
    workspaces.filter((workspace) => workspace.workspaceKind === "oneOffChat"),
  );
  const previouslyLoaded = oneOffWorkspaces.slice(0, currentLimit);
  const newlyLoaded = oneOffWorkspaces.slice(currentLimit, nextLimit);
  const plan: RemoteThreadLoadEntry[] = newlyLoaded.map((workspace) => ({
    cwd: workspace.path,
    workspaceId: workspace.id,
  }));

  const loaded = await loadRemoteThreadsFromPlan(client, plan);
  return {
    threads: loaded.threads,
    totalsByWorkspaceId: loaded.totalsByWorkspaceId,
    nextLimit: Math.min(nextLimit, oneOffWorkspaces.length),
  };
}
