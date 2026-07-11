import { useCallback, useMemo, useSyncExternalStore } from "react";

import { normalizePreviewResourcePath, workspaceFileChangeEvents } from "./filePreviewResource";

export function useFileChangeRevision(filePath: string | null): number {
  const getSnapshot = useCallback(
    () => (filePath ? workspaceFileChangeEvents.getRevision(filePath) : 0),
    [filePath],
  );
  return useSyncExternalStore(workspaceFileChangeEvents.subscribe, getSnapshot, getSnapshot);
}

export function useFileChangeRevisionSignature(filePaths: readonly string[]): string {
  const pathsKey = [...new Set(filePaths.map(normalizePreviewResourcePath))].sort().join("\0");
  const normalizedPaths = useMemo(() => (pathsKey ? pathsKey.split("\0") : []), [pathsKey]);
  const getSnapshot = useCallback(
    () =>
      normalizedPaths
        .map((filePath) => `${filePath}\0${workspaceFileChangeEvents.getRevision(filePath)}`)
        .join("\0"),
    [normalizedPaths],
  );
  return useSyncExternalStore(workspaceFileChangeEvents.subscribe, getSnapshot, getSnapshot);
}
