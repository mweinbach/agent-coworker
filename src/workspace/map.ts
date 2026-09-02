import fs from "node:fs";
import path from "node:path";

import type { AgentConfig } from "../types";
import { sameWorkspacePath } from "../utils/workspacePath";
import { deriveActiveWorkspaceContext } from "./context";

/** Directory names omitted from the workspace map (names only; no contents). */
export const WORKSPACE_MAP_IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const MAX_DEPTH = 2;
const MAX_ENTRIES_PER_DIR = 20;
const MAX_TOTAL_CHARS = 4000;
const MAX_DISPLAY_LABEL_CHARS = 512;

/**
 * Escapes raw filesystem names for embedding in markdown (including inside ``` fences).
 * Prevents newlines/backticks/control characters from breaking fences or injecting prompt text.
 */
export function sanitizeWorkspaceMapLabel(value: string): string {
  const replaceUnsafeControlChars = (input: string): string =>
    Array.from(input, (char) => {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) {
        return char;
      }
      if (
        char === "\n" ||
        (codePoint >= 0x00 && codePoint <= 0x08) ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
      ) {
        return "?";
      }
      return char;
    }).join("");
  let s = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/\u2028|\u2029/g, "?");
  s = replaceUnsafeControlChars(s);
  s = s.replace(/`/g, "'");
  if (s.length > MAX_DISPLAY_LABEL_CHARS) {
    return `${s.slice(0, MAX_DISPLAY_LABEL_CHARS - 1)}…`;
  }
  return s;
}

/** Lower score sorts earlier (more important). */
const PRIORITY_RULES: Array<{ test: (name: string) => boolean; score: number }> = [
  { test: (n) => n === "AGENTS.override.md", score: 0 },
  { test: (n) => n === "AGENTS.md", score: 1 },
  { test: (n) => n.startsWith("README"), score: 2 },
  { test: (n) => n === "package.json", score: 3 },
  { test: (n) => n === "pnpm-workspace.yaml", score: 4 },
  { test: (n) => n === "turbo.json", score: 5 },
  { test: (n) => n.startsWith("tsconfig"), score: 6 },
  { test: (n) => n === "pyproject.toml", score: 7 },
  { test: (n) => n === "Cargo.toml", score: 8 },
  { test: (n) => n === "go.mod", score: 9 },
  { test: (n) => n.startsWith("requirements") && n.endsWith(".txt"), score: 10 },
  { test: (n) => n === "Makefile", score: 11 },
];

function priorityScore(name: string): number {
  for (const rule of PRIORITY_RULES) {
    if (rule.test(name)) return rule.score;
  }
  return 100;
}

function compareEntries(a: string, b: string): number {
  const pa = priorityScore(a);
  const pb = priorityScore(b);
  if (pa !== pb) return pa - pb;
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function isIgnoredDir(name: string): boolean {
  return WORKSPACE_MAP_IGNORED_DIRS.has(name);
}

/** `stat` follows symlinks — use only when the target type is needed. */
function safeStatSync(absPath: string): fs.Stats | null {
  try {
    return fs.statSync(absPath);
  } catch {
    return null;
  }
}

/** `lstat` does not follow symlinks — use for traversal decisions. */
function safeLstatSync(absPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(absPath);
  } catch {
    return null;
  }
}

function displayAsDirectory(absPath: string, dirent: fs.Dirent): boolean {
  if (dirent.isSymbolicLink()) {
    const target = safeStatSync(absPath);
    return target?.isDirectory() ?? false;
  }
  return dirent.isDirectory();
}

type ListedChild = { name: string; isDirectory: boolean; recurse: boolean };

/**
 * Lists immediate children of `absDir`, filtered and sorted. At most `MAX_ENTRIES_PER_DIR` names.
 * Uses `readdir` with file types to avoid a stat per entry. Does not recurse into symlinked
 * directories (listed as a single name with a trailing `/` when the target is a directory).
 */
function* listFilteredChildren(absDir: string): Generator<ListedChild> {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  dirents.sort((left, right) => compareEntries(left.name, right.name));
  let listed = 0;
  for (const dirent of dirents) {
    if (listed >= MAX_ENTRIES_PER_DIR) return;
    const name = dirent.name;
    if (name === "." || name === "..") continue;

    if (dirent.isSymbolicLink()) {
      const displayDir = displayAsDirectory(path.join(absDir, name), dirent);
      if (displayDir && isIgnoredDir(name)) continue;
      listed++;
      yield { name, isDirectory: displayDir, recurse: false };
      continue;
    }

    if (dirent.isDirectory()) {
      if (isIgnoredDir(name)) continue;
      listed++;
      yield { name, isDirectory: true, recurse: true };
      continue;
    }

    listed++;
    yield { name, isDirectory: false, recurse: false };
  }
}

function isListableDirectoryRoot(rootAbs: string): boolean {
  const st = safeLstatSync(rootAbs);
  if (!st) return false;
  if (st.isSymbolicLink()) {
    const target = safeStatSync(rootAbs);
    return target?.isDirectory() ?? false;
  }
  return st.isDirectory();
}

/**
 * Builds indented tree lines for `rootAbs` (directory). `displayRootLabel` is the first line
 * (e.g. directory basename). Depth: children of the root are at tree depth 1; max depth 2 lists
 * two levels below the label line.
 */
function* iterateDirectoryTreeLines(rootAbs: string, displayRootLabel: string): Generator<string> {
  if (!isListableDirectoryRoot(rootAbs)) {
    yield `${sanitizeWorkspaceMapLabel(displayRootLabel)} (unavailable)`;
    return;
  }

  const normalizedLabel = displayRootLabel.endsWith(path.sep)
    ? displayRootLabel.slice(0, -1)
    : displayRootLabel;
  yield `${sanitizeWorkspaceMapLabel(normalizedLabel)}/`;

  function* walk(absDir: string, indent: string, treeDepth: number): Generator<string> {
    if (treeDepth > MAX_DEPTH) return;
    const children = listFilteredChildren(absDir);
    for (const { name, isDirectory, recurse } of children) {
      const suffix = isDirectory ? "/" : "";
      yield `${indent}${sanitizeWorkspaceMapLabel(name)}${suffix}`;
      if (recurse && treeDepth < MAX_DEPTH) {
        yield* walk(path.join(absDir, name), `${indent}  `, treeDepth + 1);
      }
    }
  }

  yield* walk(rootAbs, "  ", 1);
}

export function buildDirectoryTreeLines(rootAbs: string, displayRootLabel: string): string[] {
  return [...iterateDirectoryTreeLines(rootAbs, displayRootLabel)];
}

function truncateLines(
  lines: Iterable<string>,
  maxChars: number,
): { text: string; truncated: boolean } {
  let total = 0;
  const out: string[] = [];
  for (const line of lines) {
    const next = total + line.length + (out.length > 0 ? 1 : 0);
    if (next > maxChars) {
      return { text: out.join("\n"), truncated: true };
    }
    out.push(line);
    total = next;
  }
  return { text: out.join("\n"), truncated: false };
}

type MapRoot = { abs: string; heading: string };

function collectMapRoots(config: AgentConfig, platform: NodeJS.Platform): MapRoot[] {
  const ctx = deriveActiveWorkspaceContext(config, platform);
  const workspaceRoot = path.resolve(ctx.workspaceRoot);
  const working = path.resolve(ctx.executionCwd);
  const git = ctx.gitRoot ? path.resolve(ctx.gitRoot) : undefined;

  const roots: MapRoot[] = [{ abs: workspaceRoot, heading: "Workspace root" }];

  if (!sameWorkspacePath(workspaceRoot, working, platform)) {
    roots.push({ abs: working, heading: "Execution working directory" });
  }

  if (
    git &&
    !sameWorkspacePath(git, workspaceRoot, platform) &&
    !sameWorkspacePath(git, working, platform)
  ) {
    roots.push({ abs: git, heading: "Git repository root" });
  }

  return roots;
}

/**
 * Returns a markdown section (## Workspace Map …) with bounded directory trees (names only).
 * Omits duplicate trees when workspace, working directory, and git root coincide.
 */
export function buildWorkspaceMapSection(
  config: AgentConfig,
  platform: NodeJS.Platform = process.platform,
): string {
  const roots = collectMapRoots(config, platform);
  const intro = [
    "## Workspace Map",
    "",
    "Bounded overview of nearby paths (file and directory names only; no contents). Noisy dependency folders are omitted.",
    "",
  ].join("\n");

  if (roots.length === 0) {
    return `${intro}(Workspace paths unavailable.)`;
  }

  const parts: string[] = [intro];
  let remaining = MAX_TOTAL_CHARS - intro.length;

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    if (!root) continue;
    const { abs, heading } = root;
    const label = path.basename(abs) || abs;
    const subheading =
      roots.length === 1 ? "" : `### ${heading}\n\n\`${sanitizeWorkspaceMapLabel(abs)}\`\n\n`;
    const fenceOpen = "```\n";
    const fenceClose = "\n```";
    const overhead = subheading.length + fenceOpen.length + fenceClose.length;
    if (overhead > remaining) break;

    const maxTreeChars = remaining - overhead;
    const { text: treeBody, truncated } = truncateLines(
      iterateDirectoryTreeLines(abs, label),
      maxTreeChars,
    );
    const treeWithNote = truncated ? `${treeBody}\n… (truncated)` : treeBody;
    const piece = `${subheading}${fenceOpen}${treeWithNote}${fenceClose}`;

    if (piece.length > remaining) {
      const tighter = truncateLines(treeBody.split("\n"), Math.max(0, maxTreeChars - 32));
      const body = truncated || tighter.truncated ? `${tighter.text}\n… (truncated)` : tighter.text;
      parts.push(`${subheading}${fenceOpen}${body}${fenceClose}`);
      break;
    }

    parts.push(piece);
    remaining -= piece.length;
    if (i < roots.length - 1 && remaining >= 2) {
      parts.push("\n\n");
      remaining -= 2;
    }
  }

  const out = parts.join("");
  if (out.length > MAX_TOTAL_CHARS) {
    return `${out.slice(0, MAX_TOTAL_CHARS - 20)}\n… (truncated)`;
  }
  return out;
}
