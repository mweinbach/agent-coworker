import fs from "node:fs/promises";
import { z } from "zod";

export type SessionBackupMetadataSnapshot = {
  kind: "directory" | "tar_gz";
  path: string;
};

export type SessionBackupMetadataCheckpoint = {
  id: string;
  index: number;
  createdAt: string;
  trigger: "auto" | "manual";
  changed: boolean;
  patchBytes: number;
  fingerprint: string;
  snapshot: SessionBackupMetadataSnapshot;
};

export type SessionBackupMetadata = {
  version: 1;
  sessionId: string;
  workingDirectory: string;
  createdAt: string;
  state: "active" | "closed";
  closedAt?: string;
  originalSnapshot: SessionBackupMetadataSnapshot;
  checkpoints: SessionBackupMetadataCheckpoint[];
};

const snapshotRefSchema = z.object({
  kind: z.enum(["directory", "tar_gz"]),
  path: z.string().min(1),
});

const sessionBackupMetadataCheckpointSchema = z
  .object({
    id: z.string().min(1),
    index: z.number(),
    createdAt: z.string().min(1),
    trigger: z.enum(["auto", "manual"]),
    changed: z.boolean(),
    patchBytes: z.number(),
    fingerprint: z.string().min(1),
    snapshot: snapshotRefSchema,
  })
  .passthrough();

const sessionBackupMetadataSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    workingDirectory: z.string().min(1),
    createdAt: z.string().min(1),
    state: z.enum(["active", "closed"]),
    closedAt: z.string().optional(),
    originalSnapshot: snapshotRefSchema,
    checkpoints: z.array(sessionBackupMetadataCheckpointSchema),
  })
  .passthrough();

const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort only
  }
}

export async function readMetadata(filePath: string): Promise<SessionBackupMetadata | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid backup metadata JSON at ${filePath}: ${String(error)}`);
    }
    const parsed = sessionBackupMetadataSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `Invalid backup metadata schema at ${filePath}: ${parsed.error.issues[0]?.message ?? "validation_failed"}`
      );
    }
    return parsed.data;
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
}
