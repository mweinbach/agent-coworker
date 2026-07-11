export type FileChangeVersion = {
  modifiedAtMs: number;
  changeTimeMs: number;
  size: number;
  fingerprint: string;
};

export type WorkspaceFileChangeEvent =
  | {
      kind: "changed";
      path: string;
      version: FileChangeVersion;
    }
  | {
      kind: "deleted";
      path: string;
      version: null;
    };

export function fileChangeVersionsEqual(
  left: FileChangeVersion | null | undefined,
  right: FileChangeVersion | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changeTimeMs === right.changeTimeMs &&
    left.size === right.size &&
    left.fingerprint === right.fingerprint
  );
}
