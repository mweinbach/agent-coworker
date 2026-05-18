import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSkillInstallManifest, writeSkillInstallManifest } from "./skills/manifest";
import { getAiCoworkerPaths } from "./store/connections";

const CODEX_CURATED_PLUGINS_EXPORT_URL = "https://chatgpt.com/backend-api/plugins/export/curated";
const CODEX_RUNTIME_STATE_VERSION = 1;
const CODEX_RUNTIME_STATE_FILE = "codex-primary-runtime.json";

type FetchLike = typeof fetch;

type ExtractZipArchive = (archivePath: string, destinationDir: string) => Promise<void>;

type CodexRuntimeSkillName = "documents" | "presentations" | "spreadsheets";

type SkillSourceSpec = {
  name: CodexRuntimeSkillName;
  pluginName: "documents" | "presentations" | "spreadsheets";
  sourceSkillName: "documents" | "presentations" | "spreadsheets";
};

const CODEX_RUNTIME_SKILLS: readonly SkillSourceSpec[] = [
  { name: "documents", pluginName: "documents", sourceSkillName: "documents" },
  { name: "presentations", pluginName: "presentations", sourceSkillName: "presentations" },
  { name: "spreadsheets", pluginName: "spreadsheets", sourceSkillName: "spreadsheets" },
] as const;

const LEGACY_CODEX_RUNTIME_SKILLS = ["doc", "slides", "spreadsheet"] as const;

export type CodexPrimaryRuntimeSkillResult = {
  name: CodexRuntimeSkillName;
  status: "installed" | "already_installed" | "missing" | "skipped";
  source?: string;
  destination?: string;
  reason?: string;
};

export type CodexPrimaryRuntimeSetupResult = {
  runtimeDir: string;
  runtimeSourceDir?: string;
  stateFile: string;
  runtimeEnv: Record<string, string>;
  runtime: {
    status: "available" | "missing";
    source?: string;
    nodePath?: string;
    pythonPath?: string;
    nodeModulesPath?: string;
  };
  artifactTool: {
    status: "available" | "missing" | "skipped";
    source?: string;
    reason?: string;
  };
  skills: CodexPrimaryRuntimeSkillResult[];
  archive: {
    status: "downloaded" | "skipped" | "failed";
    endpoint: string;
    extractedDir?: string;
    reason?: string;
  };
};

type CodexPrimaryRuntimeState = {
  version: number;
  updatedAt: string;
  artifactSource?: string;
  installedSkills: CodexRuntimeSkillName[];
};

export type EnsureCodexPrimaryRuntimeOptions = {
  homedir?: string;
  workspaceDir?: string;
  builtInSkillsDir?: string;
  globalSkillsDir?: string;
  env?: Record<string, string | undefined>;
  bundledRuntimeDir?: string;
  fetchImpl?: FetchLike;
  extractZipArchive?: ExtractZipArchive;
  allowNetwork?: boolean;
  force?: boolean;
  log?: (line: string) => void;
};

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function shouldBootstrapCodexPrimaryRuntime(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !isTruthy(env.COWORK_SKIP_CODEX_PRIMARY_RUNTIME_BOOTSTRAP);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function codexRuntimeRoot(home: string): string {
  return path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime");
}

function codexPluginCacheRoot(home: string): string {
  return path.join(home, ".codex", "plugins", "cache", "openai-primary-runtime");
}

function bundledRuntimeDirFromOptions(opts: {
  bundledRuntimeDir?: string;
  builtInSkillsDir?: string;
  env: Record<string, string | undefined>;
}): string | undefined {
  const fromOption = opts.bundledRuntimeDir?.trim();
  if (fromOption) return path.resolve(fromOption);

  const fromEnv = opts.env.COWORK_BUNDLED_CODEX_PRIMARY_RUNTIME_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  if (opts.builtInSkillsDir) {
    return path.join(path.dirname(opts.builtInSkillsDir), "codex-primary-runtime");
  }

  return undefined;
}

function runtimeStateFile(homedir?: string): string {
  const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
  return path.join(paths.configDir, CODEX_RUNTIME_STATE_FILE);
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

async function defaultExtractZipArchive(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function downloadCuratedPluginsArchive(opts: {
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

async function findCuratedRepoRoot(extractedDir: string): Promise<string> {
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

async function sortedChildDirs(parent: string): Promise<string[]> {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
}

async function findOaiNamespaceInRuntimeRoot(root: string): Promise<string | null> {
  const candidates = [
    path.join(root, "node", "node_modules", "@oai"),
    path.join(root, "dependencies", "node", "node_modules", "@oai"),
    path.join(
      root,
      "python",
      "Lib",
      "site-packages",
      "artifact_tool_v2",
      "bin",
      "node_modules",
      "@oai",
    ),
    path.join(
      root,
      "dependencies",
      "python",
      "Lib",
      "site-packages",
      "artifact_tool_v2",
      "bin",
      "node_modules",
      "@oai",
    ),
  ];

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "artifact-tool", "package.json"))) return candidate;
  }

  return null;
}

async function findLocalOaiNamespace(
  home: string,
  runtimeRoots: readonly string[] = [],
): Promise<string | null> {
  for (const root of runtimeRoots) {
    const found = await findOaiNamespaceInRuntimeRoot(root);
    if (found) return found;
  }

  const root = codexRuntimeRoot(home);
  const cached = await findOaiNamespaceInRuntimeRoot(root);
  if (cached) return cached;

  const installRoots = await sortedChildDirs(path.join(home, ".cache", "codex-runtimes"));
  for (const installRoot of installRoots) {
    if (!path.basename(installRoot).startsWith("codex-runtime-install-")) continue;
    const payloadRoot = path.join(installRoot, "payload", "codex-primary-runtime");
    const found = await findOaiNamespaceInRuntimeRoot(payloadRoot);
    if (found) return found;
  }

  return null;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function dedupePathEntries(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

async function isRuntimeRootUsable(root: string): Promise<boolean> {
  return (
    (await pathExists(path.join(root, "runtime.json"))) ||
    (await findOaiNamespaceInRuntimeRoot(root)) !== null ||
    (await pathExists(path.join(root, "plugins", "openai-primary-runtime")))
  );
}

async function collectRuntimeRoots(home: string, bundledRuntimeDir?: string): Promise<string[]> {
  const candidates = [
    ...(bundledRuntimeDir ? [bundledRuntimeDir] : []),
    codexRuntimeRoot(home),
    ...(await sortedChildDirs(path.join(home, ".cache", "codex-runtimes"))).map((installRoot) =>
      path.join(installRoot, "payload", "codex-primary-runtime"),
    ),
  ];
  const roots: string[] = [];
  for (const candidate of dedupePaths(candidates)) {
    if (await isRuntimeRootUsable(candidate)) roots.push(candidate);
  }
  return roots;
}

async function findFirstExistingFile(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

function executableBasename(name: "node" | "python" | "python3"): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function resolveRuntimeExecutablePaths(
  runtimeRoots: readonly string[],
): Promise<CodexPrimaryRuntimeSetupResult["runtime"] & { runtimeEnv: Record<string, string> }> {
  for (const root of runtimeRoots) {
    const oaiNamespace = await findOaiNamespaceInRuntimeRoot(root);
    const nodePath = await findFirstExistingFile([
      path.join(root, "node", "bin", executableBasename("node")),
      path.join(root, "dependencies", "node", "bin", executableBasename("node")),
      path.join(root, "bin", executableBasename("node")),
    ]);
    const pythonPath = await findFirstExistingFile([
      path.join(root, "python", executableBasename("python")),
      path.join(root, "python", "bin", executableBasename("python3")),
      path.join(root, "dependencies", "python", executableBasename("python")),
      path.join(root, "dependencies", "python", "bin", executableBasename("python3")),
    ]);
    const nodeModulesPath = oaiNamespace ? path.dirname(oaiNamespace) : undefined;
    if (!nodePath && !pythonPath && !nodeModulesPath) continue;

    const runtimeEnv: Record<string, string> = {
      COWORK_CODEX_PRIMARY_RUNTIME_DIR: root,
    };
    if (nodePath) runtimeEnv.COWORK_CODEX_RUNTIME_NODE = nodePath;
    if (pythonPath) runtimeEnv.COWORK_CODEX_RUNTIME_PYTHON = pythonPath;
    if (nodeModulesPath) runtimeEnv.COWORK_CODEX_RUNTIME_NODE_MODULES = nodeModulesPath;

    return {
      status: "available",
      source: root,
      ...(nodePath ? { nodePath } : {}),
      ...(pythonPath ? { pythonPath } : {}),
      ...(nodeModulesPath ? { nodeModulesPath } : {}),
      runtimeEnv,
    };
  }

  return { status: "missing", runtimeEnv: {} };
}

function prependToolPath(
  env: Record<string, string | undefined>,
  runtimeEnv: Record<string, string>,
  dirs: string[],
): Record<string, string> {
  const cleanDirs = dirs.filter(Boolean);
  if (Object.keys(runtimeEnv).length === 0 && cleanDirs.length === 0) {
    return runtimeEnv;
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const existingPath = env[pathKey] ?? "";
  const existingParts = existingPath ? existingPath.split(path.delimiter) : [];
  const nextParts = dedupePathEntries([...cleanDirs, ...existingParts]);
  if (nextParts.length === 0) return runtimeEnv;
  return { ...runtimeEnv, [pathKey]: nextParts.join(path.delimiter) };
}

function prependNodePath(
  env: Record<string, string | undefined>,
  runtimeEnv: Record<string, string>,
  nodeModulesPath?: string,
): Record<string, string> {
  if (!nodeModulesPath) return runtimeEnv;
  const existingParts = env.NODE_PATH ? env.NODE_PATH.split(path.delimiter) : [];
  const nextParts = dedupePathEntries([nodeModulesPath, ...existingParts]);
  return { ...runtimeEnv, NODE_PATH: nextParts.join(path.delimiter) };
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true, verbatimSymlinks: false });
}

async function normalizeInstalledSkillName(skillRoot: string, name: string): Promise<void> {
  const skillFile = path.join(skillRoot, "SKILL.md");
  const raw = await fs.readFile(skillFile, "utf-8").catch(() => null);
  if (!raw) return;

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return;

  const frontMatter = match[1] ?? "";
  const nextFrontMatter = /^name\s*:/m.test(frontMatter)
    ? frontMatter.replace(/^name\s*:.*$/m, `name: ${name}`)
    : `name: ${name}\n${frontMatter}`;
  const nextRaw = raw.replace(match[0], `---\n${nextFrontMatter}\n---`);
  await fs.writeFile(skillFile, nextRaw, "utf-8");
}

async function resolveArtifactTool(opts: {
  home: string;
  runtimeRoots: readonly string[];
}): Promise<CodexPrimaryRuntimeSetupResult["artifactTool"]> {
  const source = await findLocalOaiNamespace(opts.home, opts.runtimeRoots);

  if (!source) {
    return {
      status: "missing",
      reason: "@oai/artifact-tool was not found in the local Codex primary runtime cache.",
    };
  }

  return { status: "available", source };
}

function skillSourceFromCuratedRepo(repoRoot: string, spec: SkillSourceSpec): string {
  return path.join(
    repoRoot,
    "plugins",
    "openai-primary-runtime",
    "plugins",
    spec.pluginName,
    "skills",
    spec.sourceSkillName,
  );
}

async function skillSourceFromPluginCache(
  home: string,
  spec: SkillSourceSpec,
): Promise<string | null> {
  const pluginRoot = path.join(codexPluginCacheRoot(home), spec.pluginName);
  for (const versionDir of await sortedChildDirs(pluginRoot)) {
    const candidate = path.join(versionDir, "skills", spec.sourceSkillName);
    if (await pathExists(path.join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

async function skillSourceFromRuntimeRoot(
  root: string,
  spec: SkillSourceSpec,
): Promise<string | null> {
  const candidate = path.join(
    root,
    "plugins",
    "openai-primary-runtime",
    "plugins",
    spec.pluginName,
    "skills",
    spec.sourceSkillName,
  );
  return (await pathExists(path.join(candidate, "SKILL.md"))) ? candidate : null;
}

async function findFirstRuntimeSkillSource(
  runtimeRoots: readonly string[],
  spec: SkillSourceSpec,
): Promise<string | null> {
  for (const runtimeRoot of runtimeRoots) {
    const source = await skillSourceFromRuntimeRoot(runtimeRoot, spec);
    if (source) return source;
  }
  return null;
}

async function shouldOverwriteGlobalSkill(destination: string, force: boolean): Promise<boolean> {
  if (force) return true;
  if (!(await pathExists(destination))) return true;
  const manifest = await readSkillInstallManifest(destination);
  return manifest?.origin?.kind === "bootstrap";
}

function isManagedLegacyRuntimeSkillManifest(
  manifest: Awaited<ReturnType<typeof readSkillInstallManifest>>,
  skillName: (typeof LEGACY_CODEX_RUNTIME_SKILLS)[number],
): boolean {
  if (manifest?.origin?.kind !== "bootstrap") return false;
  if (
    manifest.installationId === `bootstrap-${skillName}` ||
    manifest.installationId === `bootstrap-codex-primary-runtime-${skillName}`
  ) {
    return true;
  }

  const subdir = manifest.origin.subdir ?? "";
  const url = manifest.origin.url ?? "";
  return (
    subdir === `skills/.curated/${skillName}` ||
    subdir.endsWith(`/skills/.curated/${skillName}`) ||
    subdir.endsWith(`/skills/${skillName}`) ||
    url.includes(`/skills/.curated/${skillName}`)
  );
}

async function removeLegacyRuntimeSkills(opts: {
  destinationRoot?: string;
  global: boolean;
  log?: (line: string) => void;
}): Promise<void> {
  if (!opts.destinationRoot) return;

  for (const skillName of LEGACY_CODEX_RUNTIME_SKILLS) {
    const destination = path.join(opts.destinationRoot, skillName);
    if (!(await pathExists(destination))) continue;

    if (opts.global) {
      const manifest = await readSkillInstallManifest(destination);
      if (!isManagedLegacyRuntimeSkillManifest(manifest, skillName)) continue;
    }

    opts.log?.(`Removing legacy Codex ${skillName} skill from ${destination}`);
    await fs.rm(destination, { recursive: true, force: true });
  }
}

async function installSkill(opts: {
  spec: SkillSourceSpec;
  source: string | null;
  destinationRoot: string;
  global: boolean;
  force: boolean;
  log?: (line: string) => void;
}): Promise<CodexPrimaryRuntimeSkillResult> {
  const destination = path.join(opts.destinationRoot, opts.spec.name);
  if (!opts.source) {
    return { name: opts.spec.name, status: "missing", destination, reason: "No source found." };
  }
  if (!(await pathExists(path.join(opts.source, "SKILL.md")))) {
    return { name: opts.spec.name, status: "missing", source: opts.source, destination };
  }

  const overwrite = opts.global
    ? await shouldOverwriteGlobalSkill(destination, opts.force)
    : opts.force || !(await pathExists(destination));
  if (!overwrite) {
    return { name: opts.spec.name, status: "already_installed", source: opts.source, destination };
  }

  opts.log?.(`Installing Codex ${opts.spec.name} skill into ${destination}`);
  await copyDirectory(opts.source, destination);
  await normalizeInstalledSkillName(destination, opts.spec.name);
  if (opts.global) {
    await writeSkillInstallManifest({
      skillRoot: destination,
      installationId: `bootstrap-codex-primary-runtime-${opts.spec.name}`,
      origin: {
        kind: "bootstrap",
        url: CODEX_CURATED_PLUGINS_EXPORT_URL,
        subdir: `plugins/openai-primary-runtime/plugins/${opts.spec.pluginName}/skills/${opts.spec.sourceSkillName}`,
      },
    });
  }

  return { name: opts.spec.name, status: "installed", source: opts.source, destination };
}

async function installSkills(opts: {
  home: string;
  runtimeRoots: readonly string[];
  destinationRoot?: string;
  global: boolean;
  force: boolean;
  curatedRepoRoot?: string;
  log?: (line: string) => void;
}): Promise<CodexPrimaryRuntimeSkillResult[]> {
  if (!opts.destinationRoot) return [];
  const results: CodexPrimaryRuntimeSkillResult[] = [];
  for (const spec of CODEX_RUNTIME_SKILLS) {
    const source =
      (opts.curatedRepoRoot &&
      (await pathExists(
        path.join(skillSourceFromCuratedRepo(opts.curatedRepoRoot, spec), "SKILL.md"),
      ))
        ? skillSourceFromCuratedRepo(opts.curatedRepoRoot, spec)
        : null) ??
      (await findFirstRuntimeSkillSource(opts.runtimeRoots, spec)) ??
      (await skillSourceFromPluginCache(opts.home, spec));
    results.push(
      await installSkill({
        spec,
        source,
        destinationRoot: opts.destinationRoot,
        global: opts.global,
        force: opts.force,
        log: opts.log,
      }),
    );
  }
  return results;
}

async function writeState(opts: {
  stateFile: string;
  artifactSource?: string;
  skills: CodexPrimaryRuntimeSkillResult[];
}): Promise<void> {
  const state: CodexPrimaryRuntimeState = {
    version: CODEX_RUNTIME_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    ...(opts.artifactSource ? { artifactSource: opts.artifactSource } : {}),
    installedSkills: opts.skills
      .filter((skill) => skill.status === "installed" || skill.status === "already_installed")
      .map((skill) => skill.name),
  };
  await fs.mkdir(path.dirname(opts.stateFile), { recursive: true });
  await fs.writeFile(opts.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export async function ensureCodexPrimaryRuntimeReady(
  opts: EnsureCodexPrimaryRuntimeOptions = {},
): Promise<CodexPrimaryRuntimeSetupResult | null> {
  const env = opts.env ?? process.env;
  if (!shouldBootstrapCodexPrimaryRuntime(env)) return null;

  const home = path.resolve(opts.homedir ?? os.homedir());
  const paths = getAiCoworkerPaths({ homedir: home });
  await fs.mkdir(paths.configDir, { recursive: true });

  const force = opts.force || isTruthy(env.COWORK_CODEX_PRIMARY_RUNTIME_FORCE);
  const allowNetwork =
    opts.allowNetwork ??
    (opts.fetchImpl !== undefined ||
      force ||
      isTruthy(env.COWORK_CODEX_PRIMARY_RUNTIME_ALLOW_NETWORK));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const extractZipArchive = opts.extractZipArchive ?? defaultExtractZipArchive;
  const stateFile = runtimeStateFile(home);
  const tmpRoot = await fs.mkdtemp(path.join(paths.rootDir, ".codex-primary-runtime-"));
  const bundledRuntimeDir = bundledRuntimeDirFromOptions({
    bundledRuntimeDir: opts.bundledRuntimeDir,
    builtInSkillsDir: opts.builtInSkillsDir,
    env,
  });
  const runtimeRoots = await collectRuntimeRoots(home, bundledRuntimeDir);
  const runtime = await resolveRuntimeExecutablePaths(runtimeRoots);
  const runtimePathDirs = [
    runtime.nodePath ? path.dirname(runtime.nodePath) : "",
    runtime.pythonPath ? path.dirname(runtime.pythonPath) : "",
    runtime.pythonPath ? path.join(path.dirname(runtime.pythonPath), "Scripts") : "",
  ];
  const runtimeEnv = prependNodePath(
    env,
    prependToolPath(env, runtime.runtimeEnv, runtimePathDirs),
    runtime.nodeModulesPath,
  );
  let archive: CodexPrimaryRuntimeSetupResult["archive"] = {
    status: "skipped",
    endpoint: CODEX_CURATED_PLUGINS_EXPORT_URL,
  };
  let curatedRepoRoot: string | undefined;

  try {
    const localSkillProbe = await skillSourceFromPluginCache(home, CODEX_RUNTIME_SKILLS[0]);
    if ((force || !localSkillProbe) && allowNetwork) {
      try {
        curatedRepoRoot = await downloadCuratedPluginsArchive({
          fetchImpl,
          extractZipArchive,
          tmpRoot,
          log: opts.log,
        });
        archive = {
          status: "downloaded",
          endpoint: CODEX_CURATED_PLUGINS_EXPORT_URL,
          extractedDir: curatedRepoRoot,
        };
      } catch (error) {
        archive = {
          status: "failed",
          endpoint: CODEX_CURATED_PLUGINS_EXPORT_URL,
          reason: error instanceof Error ? error.message : String(error),
        };
        opts.log?.(`Codex curated plugin archive download failed: ${archive.reason}`);
      }
    } else if (!localSkillProbe && !allowNetwork) {
      archive = {
        status: "skipped",
        endpoint: CODEX_CURATED_PLUGINS_EXPORT_URL,
        reason: "Network bootstrap is disabled for this process.",
      };
    }

    const artifactTool = await resolveArtifactTool({
      home,
      runtimeRoots,
    });
    await removeLegacyRuntimeSkills({
      destinationRoot: opts.builtInSkillsDir,
      global: false,
      log: opts.log,
    });
    await removeLegacyRuntimeSkills({
      destinationRoot: opts.globalSkillsDir,
      global: true,
      log: opts.log,
    });
    const builtInSkillResults = await installSkills({
      home,
      runtimeRoots,
      destinationRoot: opts.builtInSkillsDir,
      global: false,
      force,
      curatedRepoRoot,
      log: opts.log,
    });
    const globalSkillResults = await installSkills({
      home,
      runtimeRoots,
      destinationRoot: opts.globalSkillsDir,
      global: true,
      force,
      curatedRepoRoot,
      log: opts.log,
    });
    const skills = [...builtInSkillResults, ...globalSkillResults];
    await writeState({ stateFile, artifactSource: artifactTool.source, skills });

    return {
      runtimeDir: codexRuntimeRoot(home),
      ...(runtime.source ? { runtimeSourceDir: runtime.source } : {}),
      stateFile,
      runtimeEnv,
      runtime: {
        status: runtime.status,
        ...(runtime.source ? { source: runtime.source } : {}),
        ...(runtime.nodePath ? { nodePath: runtime.nodePath } : {}),
        ...(runtime.pythonPath ? { pythonPath: runtime.pythonPath } : {}),
        ...(runtime.nodeModulesPath ? { nodeModulesPath: runtime.nodeModulesPath } : {}),
      },
      artifactTool,
      skills,
      archive,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export const __internal = {
  CODEX_CURATED_PLUGINS_EXPORT_URL,
  codexRuntimeRoot,
  codexPluginCacheRoot,
  findCuratedRepoRoot,
  findLocalOaiNamespace,
};
