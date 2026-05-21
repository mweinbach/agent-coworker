import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CODEX_CURATED_PLUGINS_EXPORT_URL } from "./constants";
import { pathExists } from "./state";
import type { ExtractZipArchive, FetchLike } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(command, args, { cwd, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        reject(
          new Error(`${command} ${args.join(" ")} failed: ${String(stderr || error.message)}`),
        );
        return;
      }
      resolve();
    });
    child.on("error", reject);
  });
}

export async function defaultExtractZipArchive(
  archivePath: string,
  destinationDir: string,
): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true });
  if (process.platform === "win32") {
    const escapedArchivePath = archivePath.replaceAll("'", "''");
    const escapedDestinationDir = destinationDir.replaceAll("'", "''");
    await runCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${escapedArchivePath}' -DestinationPath '${escapedDestinationDir}' -Force`,
      ],
      destinationDir,
    );
    return;
  }
  await runCommand("unzip", ["-oq", archivePath, "-d", destinationDir], destinationDir);
}

async function fetchText(fetchImpl: FetchLike, url: string): Promise<string> {
  const response = await fetchImpl(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with status ${response.status}: ${body.slice(0, 400)}`);
  }
  return body;
}

async function fetchBytes(fetchImpl: FetchLike, url: string): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const text = new TextDecoder().decode(bytes.slice(0, 400));
    throw new Error(`GET ${url} failed with status ${response.status}: ${text}`);
  }
  return bytes;
}

export async function downloadCuratedPluginsArchive(opts: {
  fetchImpl: FetchLike;
  extractZipArchive: ExtractZipArchive;
  tmpRoot: string;
  log?: (line: string) => void;
}): Promise<string> {
  opts.log?.(
    `Fetching Codex curated plugin export metadata from ${CODEX_CURATED_PLUGINS_EXPORT_URL}`,
  );
  const metadata = JSON.parse(
    await fetchText(opts.fetchImpl, CODEX_CURATED_PLUGINS_EXPORT_URL),
  ) as unknown;
  if (!isRecord(metadata) || typeof metadata.download_url !== "string" || !metadata.download_url) {
    throw new Error("Codex curated plugin export metadata did not include download_url.");
  }

  opts.log?.("Downloading Codex curated plugin archive");
  const archiveBytes = await fetchBytes(opts.fetchImpl, metadata.download_url);
  const archivePath = path.join(opts.tmpRoot, "curated-plugins.zip");
  const extractDir = path.join(opts.tmpRoot, "curated-plugins");
  await fs.writeFile(archivePath, archiveBytes);
  await opts.extractZipArchive(archivePath, extractDir);
  return await findCuratedRepoRoot(extractDir);
}

export async function findCuratedRepoRoot(extractedDir: string): Promise<string> {
  const directManifest = path.join(extractedDir, ".agents", "plugins", "marketplace.json");
  if (await pathExists(directManifest)) return extractedDir;

  const entries = await fs.readdir(extractedDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractedDir, entry.name);
    if (await pathExists(path.join(candidate, ".agents", "plugins", "marketplace.json"))) {
      return candidate;
    }
  }

  throw new Error(`Could not locate curated plugin repository root under ${extractedDir}.`);
}
