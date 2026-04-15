import fs from "node:fs/promises";
import path from "node:path";

/** UTF-8 byte cap for the entire rendered "## Project Instructions" (AGENTS files) section. */
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const FILENAMES = ["AGENTS.override.md", "AGENTS.md"] as const;
const PROJECT_INSTRUCTIONS_HEADER = [
  "## Project Instructions",
  "",
  "These instructions are loaded automatically from AGENTS files in the workspace hierarchy.",
].join("\n");
const PROJECT_INSTRUCTIONS_TRUNCATED_NOTICE =
  "... (truncated: kept the most specific project instructions within the byte limit)";

type ProjectInstructionsIo = Pick<typeof fs, "stat" | "readFile">;

async function findGitRoot(startDir: string, io: ProjectInstructionsIo = fs): Promise<string | undefined> {
  let current = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(current, ".git");
    try {
      const stat = await io.stat(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Directories from git root down to and including workspace root, or `[workspaceRoot]` when not in a git repo.
 */
export function directoriesFromGitRootToWorkspace(
  workspaceRoot: string,
  gitRoot: string | undefined,
): string[] {
  const w = path.resolve(workspaceRoot);
  if (!gitRoot) {
    return [w];
  }
  const g = path.resolve(gitRoot);
  const rel = path.relative(g, w);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return [w];
  }
  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  const dirs: string[] = [g];
  let cur = g;
  for (const p of parts) {
    cur = path.join(cur, p);
    dirs.push(cur);
  }
  return dirs;
}

function displayPathForDirectory(gitRoot: string, dir: string): string {
  const rel = path.relative(gitRoot, dir);
  if (!rel || rel === "") {
    return ".";
  }
  return rel.split(path.sep).join("/");
}

function utf8PrefixWithinByteLimit(buf: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) {
    return value;
  }
  const suffix = "\n\n… (truncated: project instructions exceeded byte limit)";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let allowed = maxBytes - suffixBytes;
  if (allowed <= 0) {
    return utf8PrefixWithinByteLimit(buf, maxBytes);
  }
  const truncated = utf8PrefixWithinByteLimit(buf, allowed);
  if (!truncated) {
    return suffix.trimStart();
  }
  return `${truncated}${suffix}`;
}

export const __internal = {
  truncateUtf8Bytes,
};

export type LoadedAgentsFile = {
  directory: string;
  displayPath: string;
  filename: string;
  content: string;
};

function renderProjectInstructionsFileBlock(file: LoadedAgentsFile): string {
  const headingLabel = file.filename === "AGENTS.override.md" ? "AGENTS.override.md" : "AGENTS.md";
  return [`### ${headingLabel} for ${file.displayPath}`, "", file.content.trimEnd()].join("\n");
}

function joinProjectInstructionsParts(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n").trimEnd();
}

async function loadAgentsFileForDirectory(
  dir: string,
  displayPath: string,
  io: ProjectInstructionsIo = fs,
): Promise<LoadedAgentsFile | null> {
  for (const filename of FILENAMES) {
    const abs = path.join(dir, filename);
    try {
      const stat = await io.stat(abs);
      if (!stat.isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    try {
      const content = await io.readFile(abs, "utf8");
      return { directory: dir, displayPath, filename, content };
    } catch {
      // Fail open so unreadable AGENTS files do not block prompt construction.
      continue;
    }
  }
  return null;
}

/**
 * Load AGENTS.override.md / AGENTS.md along the path from git root (if any) to workspace root.
 * Does not read `.agent/AGENT.md` or other memory paths.
 */
export async function loadProjectAgentsFiles(
  workspaceRoot: string,
  io: ProjectInstructionsIo = fs,
): Promise<LoadedAgentsFile[]> {
  const ws = path.resolve(workspaceRoot);
  const gitRoot = await findGitRoot(ws, io);
  const dirs = directoriesFromGitRootToWorkspace(ws, gitRoot);
  const rootForLabels = gitRoot ?? ws;

  const loaded: LoadedAgentsFile[] = [];
  for (const dir of dirs) {
    const loadedFile = await loadAgentsFileForDirectory(dir, displayPathForDirectory(rootForLabels, dir), io);
    if (loadedFile) {
      loaded.push(loadedFile);
    }
  }
  return loaded;
}

function renderProjectInstructionsSectionInner(files: LoadedAgentsFile[]): string {
  return joinProjectInstructionsParts([PROJECT_INSTRUCTIONS_HEADER, ...files.map(renderProjectInstructionsFileBlock)]);
}

function renderProjectInstructionsSectionWithinByteLimit(files: LoadedAgentsFile[], maxBytes: number): string {
  const rendered = renderProjectInstructionsSectionInner(files);
  if (Buffer.byteLength(rendered, "utf8") <= maxBytes) {
    return rendered;
  }

  const fileBlocks = files.map(renderProjectInstructionsFileBlock);
  const buildTruncatedSection = (blocks: string[]) =>
    joinProjectInstructionsParts([PROJECT_INSTRUCTIONS_HEADER, PROJECT_INSTRUCTIONS_TRUNCATED_NOTICE, ...blocks]);

  const selectedBlocks: string[] = [];
  const mostSpecificBlock = fileBlocks[fileBlocks.length - 1];
  if (!mostSpecificBlock) {
    return "";
  }

  const mostSpecificSection = buildTruncatedSection([mostSpecificBlock]);
  if (Buffer.byteLength(mostSpecificSection, "utf8") > maxBytes) {
    const prefix = buildTruncatedSection([]);
    const remainingBytes = Math.max(0, maxBytes - Buffer.byteLength(`${prefix}\n\n`, "utf8"));
    const truncatedMostSpecificBlock = truncateUtf8Bytes(mostSpecificBlock, remainingBytes);
    return buildTruncatedSection(truncatedMostSpecificBlock ? [truncatedMostSpecificBlock] : []);
  }

  selectedBlocks.unshift(mostSpecificBlock);
  for (let i = fileBlocks.length - 2; i >= 0; i -= 1) {
    const block = fileBlocks[i];
    if (!block) {
      continue;
    }
    const candidate = buildTruncatedSection([block, ...selectedBlocks]);
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
      break;
    }
    selectedBlocks.unshift(block);
  }

  return buildTruncatedSection(selectedBlocks);
}

/**
 * Markdown section for hierarchical AGENTS files (empty string if none found).
 */
export async function loadProjectInstructionsSection(
  workspaceRoot: string,
  io: ProjectInstructionsIo = fs,
): Promise<string> {
  const files = await loadProjectAgentsFiles(workspaceRoot, io);
  if (files.length === 0) {
    return "";
  }
  return renderProjectInstructionsSectionWithinByteLimit(files, PROJECT_INSTRUCTIONS_MAX_BYTES);
}
