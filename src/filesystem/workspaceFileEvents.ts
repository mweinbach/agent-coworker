import { normalizeDirectoryListingPath } from "./directoryListingCoordinator";

export type WorkspaceFileChangeKind = "add" | "remove" | "rename" | "modify";

export type WorkspaceFileChangeEvent = {
  workspaceId: string;
  rootPath: string;
  kind: WorkspaceFileChangeKind;
  changedPaths: string[];
  affectedDirectoryPaths: string[];
  invalidatedSubtreePaths: string[];
};

export type CreateWorkspaceFileChangeEventInput = {
  workspaceId: string;
  rootPath: string;
  kind: WorkspaceFileChangeKind;
  changedPaths: string[];
};

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true;
  }
  const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return candidatePath.startsWith(prefix);
}

function explorerParentPath(rootPath: string, changedPath: string): string {
  if (changedPath === rootPath) {
    return rootPath;
  }
  const separator = changedPath.lastIndexOf("/");
  if (separator <= 0) {
    return rootPath;
  }
  const parent = changedPath.slice(0, separator);
  return isPathWithinRoot(rootPath, parent) ? parent : rootPath;
}

function uniqueNormalizedPaths(paths: string[]): string[] {
  const unique = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeDirectoryListingPath(path);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

export function createWorkspaceFileChangeEvent(
  input: CreateWorkspaceFileChangeEventInput,
): WorkspaceFileChangeEvent {
  const rootPath = normalizeDirectoryListingPath(input.rootPath);
  const changedPaths = uniqueNormalizedPaths(input.changedPaths).filter((path) =>
    isPathWithinRoot(rootPath, path),
  );
  const effectiveChangedPaths = changedPaths.length > 0 ? changedPaths : [rootPath];
  const affectedDirectoryPaths = uniqueNormalizedPaths(
    effectiveChangedPaths.map((path) => explorerParentPath(rootPath, path)),
  );
  const invalidatedSubtreePaths =
    input.kind === "remove" || input.kind === "rename" ? effectiveChangedPaths : [];

  return {
    workspaceId: input.workspaceId,
    rootPath,
    kind: input.kind,
    changedPaths: effectiveChangedPaths,
    affectedDirectoryPaths,
    invalidatedSubtreePaths,
  };
}
