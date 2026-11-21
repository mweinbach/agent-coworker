import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_GITHUB_OWNER = "mweinbach";
export const DEFAULT_GITHUB_REPO = "agent-coworker";

export const VALID_UPDATER_PLATFORM_KEYS = [
  "macos-aarch64",
  "macos-x86_64",
  "windows-x86_64",
  "windows-aarch64",
  "linux-x86_64",
  "linux-aarch64",
] as const;

export type UpdaterPlatformKey = (typeof VALID_UPDATER_PLATFORM_KEYS)[number];
export type UpdaterPayloadFormat = "app" | "nsis" | "wix" | "appimage";

export interface UpdaterFragment {
  platformKey: UpdaterPlatformKey;
  version: string;
  format: UpdaterPayloadFormat;
  fileName: string;
  signature: string;
}

export interface LatestJsonPlatformEntry {
  url: string;
  signature: string;
  format: UpdaterPayloadFormat;
}

export interface LatestJsonManifest {
  version: string;
  notes?: string;
  pub_date: string;
  platforms: Partial<Record<UpdaterPlatformKey, LatestJsonPlatformEntry>>;
}

export interface BuildReleaseUrlParams {
  owner?: string;
  repo?: string;
  tag: string;
  fileName: string;
}

export interface BuildLatestJsonParams {
  version: string;
  tag: string;
  fragments: readonly UpdaterFragment[];
  owner?: string;
  repo?: string;
  notes?: string;
  pubDate?: string;
}

const VALID_FORMATS = new Set<UpdaterPayloadFormat>(["app", "nsis", "wix", "appimage"]);
const VALID_PLATFORM_KEY_SET = new Set<string>(VALID_UPDATER_PLATFORM_KEYS);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizeSemverVersion(raw: string): string {
  const trimmed = raw.trim().replace(/^v/i, "");
  if (!SEMVER_RE.test(trimmed)) {
    throw new Error(`Invalid semantic version "${raw}". Expected MAJOR.MINOR.PATCH[-pre][+build].`);
  }
  return trimmed;
}

export function buildReleaseDownloadUrl(params: BuildReleaseUrlParams): string {
  const owner = (params.owner ?? DEFAULT_GITHUB_OWNER).trim();
  const repo = (params.repo ?? DEFAULT_GITHUB_REPO).trim();
  const tag = params.tag.trim();
  const fileName = params.fileName.trim();
  if (!owner || !repo || !tag || !fileName) {
    throw new Error("GitHub release URL requires non-empty owner, repo, tag, and fileName.");
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

export function buildLatestJsonManifest(params: BuildLatestJsonParams): LatestJsonManifest {
  const version = normalizeSemverVersion(params.version);
  const pubDate = (params.pubDate ?? new Date().toISOString()).trim();
  if (!RFC3339_RE.test(pubDate)) {
    throw new Error(`Invalid RFC 3339 pub_date: "${pubDate}".`);
  }

  const platforms: Partial<Record<UpdaterPlatformKey, LatestJsonPlatformEntry>> = {};
  for (const fragment of params.fragments) {
    if (!VALID_PLATFORM_KEY_SET.has(fragment.platformKey)) {
      throw new Error(`Unsupported updater platform key "${fragment.platformKey}".`);
    }
    if (!VALID_FORMATS.has(fragment.format)) {
      throw new Error(`Unsupported updater format "${fragment.format}".`);
    }
    const fragmentVersion = normalizeSemverVersion(fragment.version);
    if (fragmentVersion !== version) {
      throw new Error(
        `Fragment for ${fragment.platformKey} has version ${fragmentVersion}, expected ${version}.`,
      );
    }
    const signature = fragment.signature.trim();
    if (!signature) {
      throw new Error(`Empty signature in updater fragment for ${fragment.platformKey}.`);
    }
    if (platforms[fragment.platformKey]) {
      throw new Error(`Duplicate updater fragment for ${fragment.platformKey}.`);
    }
    platforms[fragment.platformKey] = {
      url: buildReleaseDownloadUrl({
        owner: params.owner,
        repo: params.repo,
        tag: params.tag,
        fileName: fragment.fileName,
      }),
      signature,
      format: fragment.format,
    };
  }

  const manifest: LatestJsonManifest = {
    version,
    pub_date: pubDate,
    platforms,
  };
  const notes = params.notes?.trim();
  if (notes) {
    manifest.notes = notes;
  }

  validateLatestJsonManifest(manifest);
  return manifest;
}

export function validateLatestJsonManifest(manifest: LatestJsonManifest): void {
  normalizeSemverVersion(manifest.version);
  if (!RFC3339_RE.test(manifest.pub_date)) {
    throw new Error(`Invalid RFC 3339 pub_date: "${manifest.pub_date}".`);
  }
  const entries = Object.entries(manifest.platforms);
  if (entries.length === 0) {
    throw new Error("latest.json manifest must contain at least one platform entry.");
  }
  for (const [key, entry] of entries) {
    if (!VALID_PLATFORM_KEY_SET.has(key)) {
      throw new Error(`Invalid platform key "${key}" in latest.json manifest.`);
    }
    if (!entry) {
      throw new Error(`Missing entry object for platform "${key}".`);
    }
    if (!VALID_FORMATS.has(entry.format)) {
      throw new Error(`Invalid format "${entry.format}" for platform "${key}".`);
    }
    if (!entry.url.startsWith("https://")) {
      throw new Error(`Updater asset URL for "${key}" must use https:// (got "${entry.url}").`);
    }
    if (!entry.signature.trim()) {
      throw new Error(`Updater signature for "${key}" must not be empty.`);
    }
  }
}

async function collectFragmentFilesRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFragmentFilesRecursive(fullPath)));
    } else if (
      entry.isFile() &&
      entry.name.startsWith("updater-fragment-") &&
      entry.name.endsWith(".json")
    ) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

export async function readFragmentsFromDirectory(dir: string): Promise<UpdaterFragment[]> {
  const files = await collectFragmentFilesRecursive(dir);
  const fragments: UpdaterFragment[] = [];
  for (const file of files) {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<UpdaterFragment>;
    if (
      typeof raw.platformKey !== "string" ||
      typeof raw.version !== "string" ||
      typeof raw.format !== "string" ||
      typeof raw.fileName !== "string" ||
      typeof raw.signature !== "string"
    ) {
      throw new Error(`Malformed updater fragment file: ${file}`);
    }
    fragments.push({
      platformKey: raw.platformKey as UpdaterPlatformKey,
      version: raw.version,
      format: raw.format as UpdaterPayloadFormat,
      fileName: raw.fileName,
      signature: raw.signature,
    });
  }
  return fragments;
}

interface ManifestCliOptions {
  inDir: string;
  outPath: string;
  version: string;
  tag: string;
  owner: string;
  repo: string;
  notes?: string;
  pubDate?: string;
}

export function parseManifestCliArgs(argv: readonly string[]): ManifestCliOptions {
  const getValue = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length) {
      return argv[idx + 1];
    }
    const prefix = `${flag}=`;
    const eq = argv.find((arg) => arg.startsWith(prefix));
    return eq ? eq.slice(prefix.length) : undefined;
  };

  const inDir = getValue("--in-dir");
  const outPath = getValue("--out") ?? "latest.json";
  const version = getValue("--version");
  const tag = getValue("--tag") ?? (version ? `v${normalizeSemverVersion(version)}` : undefined);
  const owner = getValue("--owner") ?? DEFAULT_GITHUB_OWNER;
  const repo = getValue("--repo") ?? DEFAULT_GITHUB_REPO;
  const notes = getValue("--notes");
  const pubDate = getValue("--pub-date");

  if (!inDir) {
    throw new Error("Missing required --in-dir <directory-with-updater-fragments>.");
  }
  if (!version) {
    throw new Error("Missing required --version <semver>.");
  }
  if (!tag) {
    throw new Error("Missing required --tag <release-tag>.");
  }

  return {
    inDir: path.resolve(inDir),
    outPath: path.resolve(outPath),
    version,
    tag,
    owner,
    repo,
    notes,
    pubDate,
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: bun scripts/desktop_rune_release_manifest.ts --in-dir <dir> --version <semver> [--tag <tag>] [--out <latest.json>] [--owner <owner>] [--repo <repo>] [--notes <text>] [--pub-date <iso8601>]",
    );
    return;
  }
  const opts = parseManifestCliArgs(process.argv.slice(2));
  const fragments = await readFragmentsFromDirectory(opts.inDir);
  if (fragments.length === 0) {
    throw new Error(`No updater-fragment-*.json files found in ${opts.inDir}.`);
  }
  const manifest = buildLatestJsonManifest({
    version: opts.version,
    tag: opts.tag,
    owner: opts.owner,
    repo: opts.repo,
    notes: opts.notes,
    pubDate: opts.pubDate,
    fragments,
  });
  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.writeFile(opts.outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `[release-manifest] Wrote ${opts.outPath} (${Object.keys(manifest.platforms).length} platform(s))`,
  );
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
