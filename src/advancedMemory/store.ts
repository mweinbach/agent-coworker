import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAiCoworkerPaths } from "../store/connections";
import type { AgentConfig } from "../types";
import { isPathInsideOneOffChatsRoot } from "../utils/oneOffChats";
import { canonicalWorkspacePath } from "../utils/workspacePath";

/**
 * Advanced (agent-driven, file-based) memory store.
 *
 * Layout: `<memoriesDir>/<folder>/` where `folder` is either a per-project slug
 * or the special `(chats)` folder for one-off chats. Each folder holds a set of
 * `<slug>.md` memory files (frontmatter + body) and a generated `MEMORY.md`
 * index whose first line is `# Memory Index`.
 */

export const CHATS_FOLDER = "(chats)";
export const MEMORY_INDEX_FILE = "MEMORY.md";
export const MEMORY_INDEX_HEADING = "# Memory Index";
export const MAX_ADVANCED_MEMORY_NAME_LENGTH = 200;
export const MAX_ADVANCED_MEMORY_DESCRIPTION_LENGTH = 500;
export const MAX_ADVANCED_MEMORY_BODY_LENGTH = 50_000;
const INVALID_FOLDER_CHARS = /[/\\\0]/;

export type AdvancedMemoryEntry = {
  /** File name without the `.md` extension. */
  slug: string;
  /** Human-facing memory name (frontmatter `name`). */
  name: string;
  /** Short one-line summary (frontmatter `description`). */
  description: string;
  /** Memory type, e.g. `feedback`, `project`, `note`. */
  type: string;
  /** Session that produced/last-edited the memory. */
  originSessionId?: string;
  /** Markdown body below the frontmatter. */
  body: string;
  /** ISO timestamp of the file's last modification. */
  updatedAt: string;
};

export type AdvancedMemoryWriteInput = {
  slug?: string;
  name: string;
  description: string;
  type?: string;
  originSessionId?: string;
  body: string;
};

function slugify(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "memory";
  return (
    trimmed
      .toLowerCase()
      .replace(/\.md$/i, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "memory"
  );
}

export function slugifyMemoryName(raw: string): string {
  return slugify(raw);
}

export function normalizeMemoryFolderName(raw: string): string {
  const folder = raw.trim();
  if (!folder || folder === "." || folder === ".." || INVALID_FOLDER_CHARS.test(folder)) {
    throw new Error(`Invalid memory folder: ${JSON.stringify(raw)}`);
  }
  return folder;
}

/**
 * Resolve the memory folder name for a session/config: `(chats)` for one-off
 * chats, otherwise a readable workspace slug plus a stable path hash. Advanced
 * memories live in one shared user-level directory, so basename-only project
 * folders would collide for unrelated workspaces named `app`, `client`, etc.
 */
export function resolveMemoryFolderName(config: AgentConfig): string {
  const cwd = config.workingDirectory ?? process.cwd();
  try {
    if (isPathInsideOneOffChatsRoot(cwd)) return CHATS_FOLDER;
  } catch {
    // fall through to project resolution
  }
  // `projectCoworkDir` is `<workspaceRoot>/.cowork`; the workspace root is its parent.
  const workspaceRoot = config.projectCoworkDir ? path.dirname(config.projectCoworkDir) : cwd;
  const canonicalRoot = canonicalWorkspacePath(workspaceRoot);
  const readableName = slugify(path.basename(workspaceRoot) || "workspace");
  const stableSuffix = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 12);
  return `${readableName}-${stableSuffix}`;
}

export function resolveMemoriesDir(config: AgentConfig): string {
  return config.memoriesDir ?? getAiCoworkerPaths().memoriesDir;
}

export type AdvancedMemoryAccessRoots = {
  memoriesDir: string;
  activeFolder: string;
  readableFolders: string[];
  writableFolder: string;
  readRoots: string[];
  writeRoots: string[];
};

export function resolveAdvancedMemoryAccessRoots(config: AgentConfig): AdvancedMemoryAccessRoots {
  const memoriesDir = resolveMemoriesDir(config);
  const store = new AdvancedMemoryStore(memoriesDir);
  const activeFolder = resolveMemoryFolderName(config);
  const readableFolders =
    activeFolder === CHATS_FOLDER ? [CHATS_FOLDER] : [activeFolder, CHATS_FOLDER];
  return {
    memoriesDir,
    activeFolder,
    readableFolders,
    writableFolder: activeFolder,
    readRoots: readableFolders.map((folder) => store.folderPath(folder)),
    writeRoots: [store.folderPath(activeFolder)],
  };
}

export function resolveAdvancedMemoryReadRoots(config: AgentConfig): string[] {
  if (!config.advancedMemory) return [];
  return resolveAdvancedMemoryAccessRoots(config).readRoots;
}

export function resolveAdvancedMemoryWriteRoots(config: AgentConfig): string[] {
  if (!config.advancedMemory) return [];
  return resolveAdvancedMemoryAccessRoots(config).writeRoots;
}

function escapeYamlValue(value: string): string {
  // Quote and escape for a YAML double-quoted scalar.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeMemory(entry: {
  name: string;
  description: string;
  type: string;
  originSessionId?: string;
  body: string;
}): string {
  const lines = [
    "---",
    `name: ${escapeYamlValue(entry.name)}`,
    `description: ${escapeYamlValue(entry.description)}`,
    "metadata:",
    "  node_type: memory",
    `  type: ${escapeYamlValue(entry.type)}`,
  ];
  if (entry.originSessionId) {
    lines.push(`  originSessionId: ${escapeYamlValue(entry.originSessionId)}`);
  }
  lines.push("---", "", entry.body.trim(), "");
  return lines.join("\n");
}

function assertMaxLength(value: string, limit: number, label: string): void {
  if (value.length > limit) {
    throw new Error(`${label} must be <= ${limit} characters.`);
  }
}

function normalizeAdvancedMemoryWriteInput(input: AdvancedMemoryWriteInput): {
  slug?: string;
  name: string;
  description: string;
  type: string;
  originSessionId?: string;
  body: string;
} {
  const slug = input.slug?.trim() || undefined;
  const name = input.name.trim();
  const description = input.description.trim();
  const type = input.type?.trim() || "note";
  const body = input.body.trim();
  assertMaxLength(name, MAX_ADVANCED_MEMORY_NAME_LENGTH, "advanced memory name");
  assertMaxLength(
    description,
    MAX_ADVANCED_MEMORY_DESCRIPTION_LENGTH,
    "advanced memory description",
  );
  assertMaxLength(body, MAX_ADVANCED_MEMORY_BODY_LENGTH, "advanced memory body");
  return {
    ...(slug ? { slug } : {}),
    name,
    description,
    type,
    ...(input.originSessionId ? { originSessionId: input.originSessionId } : {}),
    body,
  };
}

function truncateIndexField(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...[truncated]`;
}

function renderIndexLine(entry: AdvancedMemoryEntry): string {
  const name = truncateIndexField(entry.name, MAX_ADVANCED_MEMORY_NAME_LENGTH);
  const description = truncateIndexField(entry.description, MAX_ADVANCED_MEMORY_DESCRIPTION_LENGTH);
  const suffix = description ? ` — ${description}` : "";
  return `- [${name}](${entry.slug}.md)${suffix}`;
}

function splitFrontMatter(raw: string): { frontMatterRaw: string | null; body: string } {
  const re = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
  const match = raw.match(re);
  if (!match) return { frontMatterRaw: null, body: raw };
  return { frontMatterRaw: match[1] ?? "", body: raw.slice(match[0].length) };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseMemoryFile(slug: string, raw: string, updatedAt: string): AdvancedMemoryEntry {
  const { frontMatterRaw, body } = splitFrontMatter(raw);
  let name = slug;
  let description = "";
  let type = "note";
  let originSessionId: string | undefined;
  if (frontMatterRaw) {
    try {
      const parsed = Bun.YAML.parse(frontMatterRaw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object") {
        name = asString(parsed.name) ?? name;
        description = asString(parsed.description) ?? description;
        const metadata = parsed.metadata as Record<string, unknown> | undefined;
        if (metadata && typeof metadata === "object") {
          type = asString(metadata.type) ?? type;
          originSessionId = asString(metadata.originSessionId);
        }
      }
    } catch {
      // Treat unparseable frontmatter as a body-only memory.
    }
  }
  return {
    slug,
    name,
    description,
    type,
    originSessionId,
    body: body.trim(),
    updatedAt,
  };
}

export class AdvancedMemoryStore {
  constructor(private readonly memoriesDir: string) {}

  folderPath(folder: string): string {
    return path.join(this.memoriesDir, normalizeMemoryFolderName(folder));
  }

  private memoryFilePath(folder: string, slug: string): string {
    return path.join(this.folderPath(folder), `${slugify(slug)}.md`);
  }

  async listFolders(): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.memoriesDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          normalizeMemoryFolderName(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  }

  async listMemories(folder: string): Promise<AdvancedMemoryEntry[]> {
    const dir = this.folderPath(folder);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const entries: AdvancedMemoryEntry[] = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      if (name === MEMORY_INDEX_FILE) continue;
      const full = path.join(dir, name);
      let raw: string;
      let updatedAt: string;
      try {
        raw = await fs.readFile(full, "utf-8");
        const stat = await fs.stat(full);
        updatedAt = stat.mtime.toISOString();
      } catch {
        continue;
      }
      entries.push(parseMemoryFile(name.replace(/\.md$/i, ""), raw, updatedAt));
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readMemory(folder: string, slug: string): Promise<AdvancedMemoryEntry | null> {
    const full = this.memoryFilePath(folder, slug);
    try {
      const raw = await fs.readFile(full, "utf-8");
      const stat = await fs.stat(full);
      return parseMemoryFile(slugify(slug), raw, stat.mtime.toISOString());
    } catch {
      return null;
    }
  }

  async writeMemory(folder: string, input: AdvancedMemoryWriteInput): Promise<AdvancedMemoryEntry> {
    const normalized = normalizeAdvancedMemoryWriteInput(input);
    const slug = slugify(normalized.slug || normalized.name);
    const dir = this.folderPath(folder);
    await fs.mkdir(dir, { recursive: true });
    const content = serializeMemory({
      name: normalized.name || slug,
      description: normalized.description,
      type: normalized.type,
      originSessionId: normalized.originSessionId,
      body: normalized.body,
    });
    await fs.writeFile(path.join(dir, `${slug}.md`), content, "utf-8");
    await this.regenerateIndex(folder);
    return (await this.readMemory(folder, slug)) as AdvancedMemoryEntry;
  }

  async editMemory(
    folder: string,
    slug: string,
    patch: Partial<AdvancedMemoryWriteInput>,
  ): Promise<AdvancedMemoryEntry | null> {
    const existing = await this.readMemory(folder, slug);
    if (!existing) return null;
    return this.writeMemory(folder, {
      slug,
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      type: patch.type ?? existing.type,
      originSessionId: patch.originSessionId ?? existing.originSessionId,
      body: patch.body ?? existing.body,
    });
  }

  async deleteMemory(folder: string, slug: string): Promise<boolean> {
    const full = this.memoryFilePath(folder, slug);
    try {
      await fs.unlink(full);
    } catch {
      return false;
    }
    await this.regenerateIndex(folder);
    return true;
  }

  async regenerateIndex(folder: string): Promise<void> {
    const entries = await this.listMemories(folder);
    const lines = [MEMORY_INDEX_HEADING, ""];
    for (const entry of entries) {
      lines.push(renderIndexLine(entry));
    }
    lines.push("");
    const dir = this.folderPath(folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, MEMORY_INDEX_FILE), lines.join("\n"), "utf-8");
  }

  /** Raw `MEMORY.md` text for a folder (regenerated view), or "" if empty. */
  async renderIndex(folder: string): Promise<string> {
    const entries = await this.listMemories(folder);
    if (entries.length === 0) return "";
    const lines = [MEMORY_INDEX_HEADING, ""];
    for (const entry of entries) {
      lines.push(renderIndexLine(entry));
    }
    return lines.join("\n");
  }

  /**
   * System-prompt section that surfaces the active folder's index (plus the
   * shared `(chats)` index when distinct) and tells the model how to recall.
   */
  async renderPromptSection(activeFolder: string): Promise<string> {
    const sections: string[] = [];
    const activeIndex = await this.renderIndex(activeFolder);
    if (activeIndex) {
      sections.push(`### Memory Index — ${activeFolder}\n\n${activeIndex}`);
    }
    if (activeFolder !== CHATS_FOLDER) {
      const chatsIndex = await this.renderIndex(CHATS_FOLDER);
      if (chatsIndex) {
        sections.push(`### Memory Index — ${CHATS_FOLDER}\n\n${chatsIndex}`);
      }
    }
    if (sections.length === 0) return "";
    return [
      "## Memory",
      "",
      "Your long-term memory is maintained automatically as indexed entries below.",
      "Use `recallMemory` to read the full content of any listed memory by name.",
      "Use `manageMemory` for explicit user requests to list, create, edit, or refresh memories.",
      "Use `readPastConversation` to revisit a prior session transcript by its sessionId.",
      "Treat memories as helpful context; resolve conflicts in favor of the latest explicit user instruction.",
      "",
      ...sections,
    ].join("\n");
  }
}
