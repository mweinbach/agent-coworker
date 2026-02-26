import fs from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./command";
import { ensureSecureDirectory } from "./fileSystem";

export async function createTarGz(sourceDir: string, targetArchive: string): Promise<void> {
  await ensureSecureDirectory(path.dirname(targetArchive));
  const res = await runCommand("tar", ["-czf", targetArchive, "-C", sourceDir, "."]);
  if (res.exitCode !== 0) {
    throw new Error(`tar create failed: ${res.stderr || res.stdout || `exit=${String(res.exitCode)}`}`);
  }
  try {
    await fs.chmod(targetArchive, 0o600);
  } catch {
    // best effort only
  }
}

export async function extractTarGz(archivePath: string, targetDir: string): Promise<void> {
  await ensureSecureDirectory(targetDir);
  const res = await runCommand("tar", ["-xzf", archivePath, "-C", targetDir]);
  if (res.exitCode !== 0) {
    throw new Error(`tar extract failed: ${res.stderr || res.stdout || `exit=${String(res.exitCode)}`}`);
  }
}
