import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { MODEL_SCRATCHPAD_DIRNAME } from "../../shared/toolOutputOverflow";

async function hashFileContent(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function updateHashWithDirectory(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  currentDir: string,
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (currentDir === rootDir && entry.name === MODEL_SCRATCHPAD_DIRNAME) continue;
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      const stat = await fs.lstat(absolutePath);
      hash.update(`${JSON.stringify(["directory", relativePath, stat.mode & 0o7777])}\n`);
      await updateHashWithDirectory(hash, rootDir, absolutePath);
      continue;
    }
    if (entry.isFile()) {
      const stat = await fs.lstat(absolutePath);
      const digest = await hashFileContent(absolutePath);
      hash.update(`${JSON.stringify(["file", relativePath, stat.mode & 0o7777, digest])}\n`);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      hash.update(`${JSON.stringify(["symlink", relativePath, target])}\n`);
      continue;
    }
    const stat = await fs.lstat(absolutePath);
    hash.update(`${JSON.stringify(["other", relativePath, stat.mode, stat.size])}\n`);
  }
}

export async function workspaceFingerprint(rootDir: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update("session-backup-workspace-v2\n");
  await updateHashWithDirectory(hash, rootDir, rootDir);
  return hash.digest("hex");
}
