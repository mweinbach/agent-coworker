import fs from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "../types";
import { getAiCoworkerPaths } from "../store/connections";
import { isPathInsideOneOffChatsRoot } from "../utils/oneOffChats";

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

/**
 * Resolve the memory folder name for a session/config: `(chats)` for one-off
 * chats, otherwise a slug derived from the workspace root directory name.
 */
export function resolveMemoryFolderName(config: AgentConfig): string {
  const cwd = config.workingDirectory ?? process.cwd();
  try {
    if (isPathInsideOneOffChatsRoot(cwd)) return CHATS_FOLDER;
  } catch {
    // fall through to project resolution
  }
  // `projectCoworkDir` is `<workspaceRoot>/.cowork`; the workspace root is its parent.
  const workspaceRoot = config.projectCoworkDir
    ? path.dirname(config.projectCoworkDir)
    : cwd;
  return slugify(path.basename(workspaceRoot) || "workspace");
}

export function resolveMemoriesDir(config: AgentConfig): string {
  return config.memoriesDir ?? getAiCoworkerPaths().memoriesDir;
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
    return path.join(this.memoriesDir, folder);
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
    const slug = slugify(input.slug?.trim() || input.name);
    const dir = this.folderPath(folder);
    await fs.mkdir(dir, { recursive: true });
    const type = input.type?.trim() || "note";
    const content = serializeMemory({
      name: input.name.trim() || slug,
      description: input.description.trim(),
      type,
      originSessionId: input.originSessionId,
      body: input.body,
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
      const suffix = entry.description ? ` — ${entry.description}` : "";
      lines.push(`- [${entry.name}](${entry.slug}.md)${suffix}`);
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
      const suffix = entry.description ? ` — ${entry.description}` : "";
      lines.push(`- [${entry.name}](${entry.slug}.md)${suffix}`);
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
      "Use `readPastConversation` to revisit a prior session transcript by its sessionId.",
      "Treat memories as helpful context; resolve conflicts in favor of the latest explicit user instruction.",
      "",
      ...sections,
    ].join("\n");
  }
}
