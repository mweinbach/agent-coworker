import path from "node:path";

import {
  isPathInsideOneOffChatsRoot,
  normalizeWorkspaceKind,
  type WorkspaceKind,
} from "../../utils/oneOffChats";
import type { WebDesktopServiceLike } from "../webDesktopService";

export type JsonRpcWorkspaceSummary = {
  id: string;
  name: string;
  path: string;
  workspaceKind: WorkspaceKind;
  createdAt?: string;
  lastOpenedAt?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultEnableMcp?: boolean;
  yolo?: boolean;
};

function hashWorkspaceId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildFallbackWorkspaceSummary(cwd: string): JsonRpcWorkspaceSummary {
  const now = new Date().toISOString();
  return {
    id: `server-${hashWorkspaceId(cwd)}`,
    name: path.basename(cwd) || cwd,
    path: cwd,
    workspaceKind: "project",
    createdAt: now,
    lastOpenedAt: now,
  };
}

function toWorkspaceSummary(
  record: Awaited<ReturnType<WebDesktopServiceLike["loadState"]>>["workspaces"][number],
): JsonRpcWorkspaceSummary {
  const workspaceKind =
    record.workspaceKind === "project"
      ? "project"
      : record.workspaceKind === "oneOffChat" || isPathInsideOneOffChatsRoot(record.path)
        ? "oneOffChat"
        : normalizeWorkspaceKind(record.workspaceKind);
  return {
    id: record.id,
    name: record.name,
    path: record.path,
    workspaceKind,
    createdAt: record.createdAt,
    lastOpenedAt: record.lastOpenedAt,
    ...(typeof record.defaultProvider === "string"
      ? { defaultProvider: record.defaultProvider }
      : {}),
    ...(typeof record.defaultModel === "string" ? { defaultModel: record.defaultModel } : {}),
    defaultEnableMcp: record.defaultEnableMcp,
    yolo: record.yolo,
  };
}

function resolveActiveWorkspaceId(
  workspaces: JsonRpcWorkspaceSummary[],
  workingDirectory: string,
): string | null {
  const matched = workspaces.find((workspace) => workspace.path === workingDirectory);
  if (matched) {
    return matched.id;
  }
  const sorted = workspaces.toSorted((left, right) =>
    (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? ""),
  );
  return sorted[0]?.id ?? null;
}

export async function listWorkspaceSummaries(opts: {
  workingDirectory: string;
  desktopService?: WebDesktopServiceLike | null;
}): Promise<{ workspaces: JsonRpcWorkspaceSummary[]; activeWorkspaceId: string | null }> {
  if (!opts.desktopService) {
    const fallback = buildFallbackWorkspaceSummary(opts.workingDirectory);
    return {
      workspaces: [fallback],
      activeWorkspaceId: fallback.id,
    };
  }

  const state = await opts.desktopService.loadState({ fallbackCwd: opts.workingDirectory });
  const workspaces = state.workspaces.map(toWorkspaceSummary);
  return {
    workspaces,
    activeWorkspaceId: resolveActiveWorkspaceId(workspaces, opts.workingDirectory),
  };
}

export async function switchWorkspaceSummary(opts: {
  workspaceId: string;
  workingDirectory: string;
  desktopService?: WebDesktopServiceLike | null;
}): Promise<{ workspaceId: string; name: string; path: string }> {
  if (!opts.desktopService) {
    const fallback = buildFallbackWorkspaceSummary(opts.workingDirectory);
    if (fallback.id !== opts.workspaceId) {
      throw new Error(`Unknown workspace: ${opts.workspaceId}`);
    }
    return {
      workspaceId: fallback.id,
      name: fallback.name,
      path: fallback.path,
    };
  }

  const state = await opts.desktopService.loadState({ fallbackCwd: opts.workingDirectory });
  const workspace = state.workspaces.find((entry) => entry.id === opts.workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${opts.workspaceId}`);
  }

  return {
    workspaceId: workspace.id,
    name: workspace.name,
    path: workspace.path,
  };
}
