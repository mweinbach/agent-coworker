import fs, { type FileHandle } from "node:fs/promises";
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

type ProjectInstructionsIo = Pick<typeof fs, "stat"> & {
  open: (filePath: string, flags: "r") => Promise<Pick<FileHandle, "read" | "close">>;
};

async function findGitRoot(
  startDir: string,
  io: ProjectInstructionsIo = fs,
): Promise<string | undefined> {
  let current = path.resolve(startDir);
  for (;;) {
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
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
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
  while (end > 0 && end < buf.length && ((buf[end] ?? 0) & 0xc0) === 0x80) {
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
  const allowed = maxBytes - suffixBytes;
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
  truncated: boolean;
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
  maxBytes = PROJECT_INSTRUCTIONS_MAX_BYTES,
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
      const file = await io.open(abs, "r");
      try {
        // One extra byte detects truncation without reading an unbounded file.
        // Explicit offsets and a loop also handle short reads correctly.
        const buffer = Buffer.alloc(maxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        const content = utf8PrefixWithinByteLimit(buffer.subarray(0, bytesRead), maxBytes);
        return { directory: dir, displayPath, filename, content, truncated: bytesRead > maxBytes };
      } finally {
        await file.close();
      }
    } catch {
      // Keep searching ancestor directories when this optional instruction file is absent or unreadable.
    }
  }
  return null;
}

/**
 * Load AGENTS.override.md / AGENTS.md along the path from git root (if any) to workspace root.
 * Does not read `.cowork/AGENT.md` or other memory paths.
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
    const loadedFile = await loadAgentsFileForDirectory(
      dir,
      displayPathForDirectory(rootForLabels, dir),
      io,
    );
    if (loadedFile) {
      loaded.push(loadedFile);
    }
  }
  return loaded;
}

function renderProjectInstructionsSectionInner(files: LoadedAgentsFile[]): string {
  return joinProjectInstructionsParts([
    PROJECT_INSTRUCTIONS_HEADER,
    ...files.map(renderProjectInstructionsFileBlock),
  ]);
}

function renderProjectInstructionsSectionWithinByteLimit(
  files: LoadedAgentsFile[],
  maxBytes: number,
): string {
  const rendered = renderProjectInstructionsSectionInner(files);
  if (!files.some((file) => file.truncated) && Buffer.byteLength(rendered, "utf8") <= maxBytes) {
    return rendered;
  }

  const fileBlocks = files.map(renderProjectInstructionsFileBlock);
  const buildTruncatedSection = (blocks: string[]) =>
    joinProjectInstructionsParts([
      PROJECT_INSTRUCTIONS_HEADER,
      PROJECT_INSTRUCTIONS_TRUNCATED_NOTICE,
      ...blocks,
    ]);

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
    if (files[i]?.truncated) break;
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
  const ws = path.resolve(workspaceRoot);
  const gitRoot = await findGitRoot(ws, io);
  const dirs = directoriesFromGitRootToWorkspace(ws, gitRoot);
  const files: LoadedAgentsFile[] = [];
  let remainingBytes = PROJECT_INSTRUCTIONS_MAX_BYTES;
  // Start with the most specific instructions. Once an ancestor does not fit,
  // older ancestors cannot be included in the required contiguous suffix.
  for (const dir of dirs.reverse()) {
    const file = await loadAgentsFileForDirectory(
      dir,
      displayPathForDirectory(gitRoot ?? ws, dir),
      io,
      remainingBytes,
    );
    if (!file) continue;
    files.unshift(file);
    remainingBytes -= Buffer.byteLength(file.content, "utf8");
    if (
      file.truncated ||
      Buffer.byteLength(renderProjectInstructionsSectionInner(files), "utf8") >
        PROJECT_INSTRUCTIONS_MAX_BYTES
    ) {
      break;
    }
  }
  if (files.length === 0) {
    return "";
  }
  return renderProjectInstructionsSectionWithinByteLimit(files, PROJECT_INSTRUCTIONS_MAX_BYTES);
}
