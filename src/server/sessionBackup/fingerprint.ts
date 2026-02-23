import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

async function updateHashWithFileContent(hash: ReturnType<typeof createHash>, filePath: string): Promise<void> {
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
}

async function updateHashWithDirectory(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  currentDir: string
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      hash.update(`D:${relativePath}\n`);
      await updateHashWithDirectory(hash, rootDir, absolutePath);
      continue;
    }
    if (entry.isFile()) {
      hash.update(`F:${relativePath}\n`);
      await updateHashWithFileContent(hash, absolutePath);
      hash.update("\n");
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath).catch(() => "<unreadable>");
      hash.update(`L:${relativePath}->${target}\n`);
      continue;
    }
    const stat = await fs.lstat(absolutePath);
    hash.update(`O:${relativePath}:${stat.mode}:${stat.size}\n`);
  }
}

export async function workspaceFingerprint(rootDir: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update("session-backup-workspace-v1\n");
  await updateHashWithDirectory(hash, rootDir, rootDir);
  return hash.digest("hex");
}
