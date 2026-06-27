import fs from "node:fs/promises";
import path from "node:path";

export const WINDOWS_SANDBOX_READINESS_FILE = "readiness.json";

export type WindowsSandboxReadiness = {
  schemaVersion: 1;
  updatedAt: string;
  state: "ready" | "setup-required" | "setup-failed" | "bundle-untrusted";
  bundleTrusted: boolean;
  setupRequired: boolean;
  enforcement: {
    filesystem: boolean;
    network: boolean;
    process: boolean;
    integrity: boolean;
  };
  message: string;
};

function readinessPath(userDataDir: string): string {
  return path.join(userDataDir, "windows-sandbox", WINDOWS_SANDBOX_READINESS_FILE);
}

export async function writeWindowsSandboxReadiness(
  userDataDir: string,
  readiness: Omit<WindowsSandboxReadiness, "schemaVersion" | "updatedAt">,
): Promise<void> {
  const destination = readinessPath(userDataDir);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await fs.writeFile(
    temporary,
    `${JSON.stringify(
      { schemaVersion: 1, updatedAt: new Date().toISOString(), ...readiness },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rm(destination, { force: true });
  await fs.rename(temporary, destination);
}

export async function readWindowsSandboxReadiness(
  userDataDir: string,
): Promise<WindowsSandboxReadiness | null> {
  try {
    const value = JSON.parse(
      await fs.readFile(readinessPath(userDataDir), "utf8"),
    ) as Partial<WindowsSandboxReadiness>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.updatedAt !== "string" ||
      !["ready", "setup-required", "setup-failed", "bundle-untrusted"].includes(
        value.state ?? "",
      ) ||
      typeof value.bundleTrusted !== "boolean" ||
      typeof value.setupRequired !== "boolean" ||
      typeof value.message !== "string" ||
      !value.enforcement ||
      Object.values(value.enforcement).some((entry) => typeof entry !== "boolean")
    ) {
      return null;
    }
    return value as WindowsSandboxReadiness;
  } catch {
    return null;
  }
}
