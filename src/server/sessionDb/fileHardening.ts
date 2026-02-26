import fs from "node:fs/promises";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export async function ensurePrivateDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod(dirPath, PRIVATE_DIR_MODE);
  } catch {
    // best effort only
  }
}

export async function hardenPrivateFile(filePath: string): Promise<void> {
  try {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch {
    // best effort only
  }
}

export async function quarantineCorruptedDb(dbPath: string): Promise<void> {
  const backupPath = `${dbPath}.corrupt.${new Date().toISOString().replaceAll(":", "-")}.bak`;
  try {
    await fs.rename(dbPath, backupPath);
  } catch {
    // If we cannot move the corrupted file, attempt to overwrite in place.
    await fs.rm(dbPath, { force: true });
  }
}
