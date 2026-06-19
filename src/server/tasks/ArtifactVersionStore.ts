import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type StoredArtifactBlob = {
  sha256: string;
  sizeBytes: number;
};

export type ArtifactVersionStoreOptions = {
  rootDir?: string;
  homedir?: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export class ArtifactFingerprintConflictError extends Error {
  readonly expectedFingerprint: string;
  readonly actualFingerprint: string | null;

  constructor(expectedFingerprint: string, actualFingerprint: string | null) {
    super(
      `Artifact fingerprint conflict: expected ${expectedFingerprint}, current ${actualFingerprint ?? "missing"}`,
    );
    this.name = "ArtifactFingerprintConflictError";
    this.expectedFingerprint = expectedFingerprint;
    this.actualFingerprint = actualFingerprint;
  }
}

/**
 * Immutable content-addressed storage for task artifact bytes. Database records
 * keep only the SHA-256 key; this class never exposes its internal object path
 * through task or JSON-RPC models.
 */
export class ArtifactVersionStore {
  readonly rootDir: string;

  constructor(options: ArtifactVersionStoreOptions = {}) {
    this.rootDir = path.resolve(
      options.rootDir ?? path.join(options.homedir ?? os.homedir(), ".cowork", "artifacts"),
    );
  }

  async putBytes(bytes: Uint8Array): Promise<StoredArtifactBlob> {
    const value = Buffer.from(bytes);
    const digest = sha256(value);
    const blobPath = this.blobPath(digest);
    await fs.mkdir(path.dirname(blobPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

    try {
      const existing = await fs.readFile(blobPath);
      if (sha256(existing) !== digest) {
        throw new Error(`Artifact object failed integrity validation: ${digest}`);
      }
      return { sha256: digest, sizeBytes: existing.byteLength };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    const tempPath = path.join(
      path.dirname(blobPath),
      `.${digest}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(tempPath, value, { mode: PRIVATE_FILE_MODE, flag: "wx" });
      try {
        await fs.copyFile(tempPath, blobPath, fsConstants.COPYFILE_EXCL);
        await fs.chmod(blobPath, PRIVATE_FILE_MODE).catch(() => {});
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }

    const persisted = await fs.readFile(blobPath);
    if (sha256(persisted) !== digest) {
      throw new Error(`Artifact object failed integrity validation: ${digest}`);
    }
    return { sha256: digest, sizeBytes: persisted.byteLength };
  }

  async captureFile(filePath: string): Promise<StoredArtifactBlob> {
    return await this.putBytes(await fs.readFile(filePath));
  }

  async fingerprintFile(filePath: string): Promise<StoredArtifactBlob | null> {
    try {
      const bytes = await fs.readFile(filePath);
      return { sha256: sha256(bytes), sizeBytes: bytes.byteLength };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async readBytes(blobSha256: string): Promise<Uint8Array> {
    const blobPath = this.blobPath(blobSha256);
    const bytes = await fs.readFile(blobPath);
    if (sha256(bytes) !== blobSha256) {
      throw new Error(`Artifact object failed integrity validation: ${blobSha256}`);
    }
    return bytes;
  }

  async restoreFile(input: {
    blobSha256: string;
    filePath: string;
    expectedFingerprint?: string;
  }): Promise<StoredArtifactBlob> {
    if (input.expectedFingerprint !== undefined) {
      const current = await this.fingerprintFile(input.filePath);
      if (current?.sha256 !== input.expectedFingerprint) {
        throw new ArtifactFingerprintConflictError(
          input.expectedFingerprint,
          current?.sha256 ?? null,
        );
      }
    }

    const bytes = await this.readBytes(input.blobSha256);
    await fs.mkdir(path.dirname(input.filePath), { recursive: true });
    const existingMode = await fs
      .stat(input.filePath)
      .then((stat) => stat.mode)
      .catch(() => null);
    const tempPath = path.join(
      path.dirname(input.filePath),
      `.${path.basename(input.filePath)}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(tempPath, bytes);
      // copyFile explicitly replaces an existing destination on Windows, while
      // rename-over-existing is not portable there. The temporary file keeps a
      // partial source write away from the live workspace path.
      await fs.copyFile(tempPath, input.filePath);
      if (existingMode !== null) await fs.chmod(input.filePath, existingMode).catch(() => {});
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    return { sha256: input.blobSha256, sizeBytes: bytes.byteLength };
  }

  /** Internal test/maintenance helper; never include this path in public records. */
  getBlobPath(blobSha256: string): string {
    return this.blobPath(blobSha256);
  }

  private blobPath(blobSha256: string): string {
    const normalized = blobSha256.trim().toLowerCase();
    if (!SHA256_PATTERN.test(normalized)) throw new Error("Invalid artifact object SHA-256");
    return path.join(this.rootDir, "objects", "sha256", normalized.slice(0, 2), normalized);
  }
}
