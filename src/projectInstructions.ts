import fs from "node:fs/promises";
import path from "node:path";

/** UTF-8 byte cap for the entire rendered "## Project Instructions" (AGENTS files) section. */
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const FILENAMES = ["AGENTS.override.md", "AGENTS.md"] as const;

async function findGitRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(current, ".git");
    try {
      const stat = await fs.stat(gitPath);
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

async function pickAgentsFile(dir: string): Promise<{ filename: (typeof FILENAMES)[number]; abs: string } | null> {
  for (const name of FILENAMES) {
    const abs = path.join(dir, name);
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) {
        return { filename: name, abs };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function displayPathForDirectory(gitRoot: string, dir: string): string {
  const rel = path.relative(gitRoot, dir);
  if (!rel || rel === "") {
    return ".";
  }
  return rel.split(path.sep).join("/");
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
    return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  let end = allowed;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) {
    end -= 1;
  }
  if (end === 0) {
    return suffix.trimStart();
  }
  return `${buf.subarray(0, end).toString("utf8")}${suffix}`;
}

export type LoadedAgentsFile = {
  directory: string;
  displayPath: string;
  filename: string;
  content: string;
};

/**
 * Load AGENTS.override.md / AGENTS.md along the path from git root (if any) to workspace root.
 * Does not read `.agent/AGENT.md` or other memory paths.
 */
export async function loadProjectAgentsFiles(workspaceRoot: string): Promise<LoadedAgentsFile[]> {
  const ws = path.resolve(workspaceRoot);
  const gitRoot = await findGitRoot(ws);
  const dirs = directoriesFromGitRootToWorkspace(ws, gitRoot);
  const rootForLabels = gitRoot ?? ws;

  const loaded: LoadedAgentsFile[] = [];
  for (const dir of dirs) {
    const picked = await pickAgentsFile(dir);
    if (!picked) continue;
    const raw = await fs.readFile(picked.abs, "utf8");
    loaded.push({
      directory: dir,
      displayPath: displayPathForDirectory(rootForLabels, dir),
      filename: picked.filename,
      content: raw,
    });
  }
  return loaded;
}

function renderProjectInstructionsSectionInner(files: LoadedAgentsFile[]): string {
  const lines: string[] = [
    "## Project Instructions",
    "",
    "These instructions are loaded automatically from AGENTS files in the workspace hierarchy.",
    "",
  ];

  for (const file of files) {
    const headingLabel = file.filename === "AGENTS.override.md" ? "AGENTS.override.md" : "AGENTS.md";
    lines.push(`### ${headingLabel} for ${file.displayPath}`, "", file.content.trimEnd(), "", "");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Markdown section for hierarchical AGENTS files (empty string if none found).
 */
export async function loadProjectInstructionsSection(workspaceRoot: string): Promise<string> {
  const files = await loadProjectAgentsFiles(workspaceRoot);
  if (files.length === 0) {
    return "";
  }
  const rendered = renderProjectInstructionsSectionInner(files);
  const bytes = Buffer.byteLength(rendered, "utf8");
  if (bytes <= PROJECT_INSTRUCTIONS_MAX_BYTES) {
    return rendered;
  }
  return truncateUtf8Bytes(rendered, PROJECT_INSTRUCTIONS_MAX_BYTES);
}
