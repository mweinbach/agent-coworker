import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "../../../../src/platform/fs";

const WINDOWS_SANDBOX_READINESS_FILE = "readiness.json";

const windowsSandboxReadinessSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.string().datetime({ offset: true }),
    state: z.enum(["ready", "setup-required", "setup-failed", "bundle-untrusted"]),
    bundleTrusted: z.boolean(),
    setupRequired: z.boolean(),
    enforcement: z
      .object({
        filesystem: z.boolean(),
        network: z.boolean(),
        process: z.boolean(),
        integrity: z.boolean(),
      })
      .strict(),
    message: z.string(),
  })
  .strict();

export type WindowsSandboxReadiness = z.infer<typeof windowsSandboxReadinessSchema>;

function readinessPath(userDataDir: string): string {
  return path.join(userDataDir, "windows-sandbox", WINDOWS_SANDBOX_READINESS_FILE);
}

export async function writeWindowsSandboxReadiness(
  userDataDir: string,
  readiness: Omit<WindowsSandboxReadiness, "schemaVersion" | "updatedAt">,
): Promise<void> {
  await writeFileAtomic(
    readinessPath(userDataDir),
    `${JSON.stringify(
      { ...readiness, schemaVersion: 1, updatedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export async function readWindowsSandboxReadiness(
  userDataDir: string,
): Promise<WindowsSandboxReadiness | null> {
  try {
    const result = windowsSandboxReadinessSchema.safeParse(
      JSON.parse(await fs.readFile(readinessPath(userDataDir), "utf8")),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
