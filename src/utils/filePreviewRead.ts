import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";

import type { FileChangeVersion } from "../shared/fileVersion";
import { fileChangeVersionsEqual } from "../shared/fileVersion";

export type CappedFilePreview = {
  path: string;
  bytes: Uint8Array;
  byteLength: number;
  truncated: boolean;
  version: FileChangeVersion;
};

export function fileChangeVersionFromStat(
  stat: Pick<Stats, "mtimeMs" | "ctimeMs" | "size">,
): FileChangeVersion {
  const modifiedAtMs = Math.round(stat.mtimeMs);
  const changeTimeMs = Math.round(stat.ctimeMs);
  return {
    modifiedAtMs,
    changeTimeMs,
    size: stat.size,
    fingerprint: `${modifiedAtMs}:${changeTimeMs}:${stat.size}`,
  };
}

export async function readFileChangeVersion(absPath: string): Promise<FileChangeVersion> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file");
  }
  return fileChangeVersionFromStat(stat);
}

export async function readCappedFilePreview(
  absPath: string,
  maxBytes: number,
): Promise<CappedFilePreview> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await fs.open(absPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const beforeStat = await handle.stat();
      if (!beforeStat.isFile()) {
        throw new Error("Path is not a file");
      }
      const toRead = Math.min(maxBytes, beforeStat.size);
      const buffer = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
      const afterStat = await handle.stat();
      const beforeVersion = fileChangeVersionFromStat(beforeStat);
      const afterVersion = fileChangeVersionFromStat(afterStat);
      if (!fileChangeVersionsEqual(beforeVersion, afterVersion)) {
        if (attempt === 0) {
          continue;
        }
        throw new Error("File changed while the preview was being read.");
      }

      const bytes = new Uint8Array(bytesRead);
      bytes.set(buffer.subarray(0, bytesRead));
      return {
        path: absPath,
        bytes,
        byteLength: bytesRead,
        truncated: afterStat.size > bytesRead,
        version: afterVersion,
      };
    } finally {
      await handle.close();
    }
  }
  throw new Error("Unable to read a stable file preview.");
}
