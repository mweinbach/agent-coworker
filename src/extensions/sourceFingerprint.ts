import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_HASH_ALGORITHM = "sha256";
const SOURCE_HASH_PREFIX = `${SOURCE_HASH_ALGORITHM}:`;
const SOURCE_HASH_RE = /^sha256:[a-f0-9]{64}$/;

function shouldIgnoreEntry(relativePath: string, name: string): boolean {
  if (
    name === ".git" ||
    name === ".DS_Store" ||
    name === ".cowork-skill.json" ||
    name.includes(".incoming-") ||
    name.includes(".backup-")
  ) {
    return true;
  }

  const normalized = relativePath.split(path.sep).join("/");
  return (
    normalized === ".cowork-plugin/install.json" ||
    normalized === ".codex-plugin/install.json" ||
    normalized.endsWith("/.cowork-plugin/install.json") ||
    normalized.endsWith("/.codex-plugin/install.json")
  );
}

async function updateHashForPath(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativePath: string,
): Promise<void> {
  const absolutePath = path.join(rootDir, relativePath);
  const stat = await fs.lstat(absolutePath);
  const stablePath = relativePath.split(path.sep).join("/");
  const name = path.basename(relativePath);

  if (shouldIgnoreEntry(relativePath, name)) {
    return;
  }

  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true, encoding: "utf8" });
    const sortedEntries = entries
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const entryName of sortedEntries) {
      await updateHashForPath(hash, rootDir, path.join(relativePath, entryName));
    }
    return;
  }

  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolutePath);
    hash.update(`symlink\0${stablePath}\0${target}\0`);
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  hash.update(`file\0${stablePath}\0`);
  hash.update(await fs.readFile(absolutePath));
  hash.update("\0");
}

export function isSourceHash(value: string | undefined): value is string {
  return typeof value === "string" && SOURCE_HASH_RE.test(value);
}

export async function computeSourceRootHash(rootDir: string): Promise<string> {
  const hash = createHash(SOURCE_HASH_ALGORITHM);
  hash.update("cowork-source-root-v1\0");
  await updateHashForPath(hash, path.resolve(rootDir), ".");
  return `${SOURCE_HASH_PREFIX}${hash.digest("hex")}`;
}
