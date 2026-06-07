import fs from "node:fs/promises";
import path from "node:path";
import { extractZipArchive } from "../utils/safeZip";
import { pathExists } from "./state";
import type { ExtractArchive, FetchLike } from "./types";

/**
 * Extract a downloaded artifact runtime archive into `destinationDir`.
 *
 * Extraction is done fully in-process with per-member containment checks (see
 * {@link extractZipArchive}) instead of shelling out to `unzip`/`Expand-Archive`.
 * Blind platform extraction honored archive-controlled symlinks and traversal
 * paths, which could escape the extraction tree and then be promoted into the
 * trusted artifact runtime cache.
 */
export async function defaultExtractArchive(
  archivePath: string,
  destinationDir: string,
): Promise<void> {
  await extractZipArchive(archivePath, destinationDir);
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

async function isRuntimeRoot(dir: string): Promise<boolean> {
  return (
    (await pathExists(path.join(dir, "runtime.json"))) ||
    (await pathExists(path.join(dir, "node", "node_modules", "@oai", "artifact-tool"))) ||
    (await pathExists(
      path.join(dir, "dependencies", "node", "node_modules", "@oai", "artifact-tool"),
    ))
  );
}

export async function findRuntimeRoot(extractedDir: string): Promise<string> {
  if (await isRuntimeRoot(extractedDir)) return extractedDir;

  const entries = await fs.readdir(extractedDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractedDir, entry.name);
    if (await isRuntimeRoot(candidate)) return candidate;
  }

  throw new Error(`Could not locate an artifact runtime root under ${extractedDir}.`);
}

/**
 * Download the standalone artifact runtime archive and copy it into the
 * Cowork-owned cache directory. Returns the populated cache directory.
 */
export async function downloadArtifactRuntimeArchive(opts: {
  fetchImpl: FetchLike;
  extractArchive: ExtractArchive;
  archiveUrl: string;
  cacheDir: string;
  tmpRoot: string;
  log?: (line: string) => void;
}): Promise<string> {
  opts.log?.(`Downloading artifact runtime archive from ${opts.archiveUrl}`);
  const archiveBytes = await fetchBytes(opts.fetchImpl, opts.archiveUrl);
  const archivePath = path.join(opts.tmpRoot, "artifact-runtime.zip");
  const extractDir = path.join(opts.tmpRoot, "artifact-runtime");
  await fs.writeFile(archivePath, archiveBytes);
  await opts.extractArchive(archivePath, extractDir);

  const runtimeRoot = await findRuntimeRoot(extractDir);
  await fs.rm(opts.cacheDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(opts.cacheDir), { recursive: true });
  await fs.cp(runtimeRoot, opts.cacheDir, { recursive: true, force: true });
  opts.log?.(`Installed artifact runtime into ${opts.cacheDir}`);
  return opts.cacheDir;
}
