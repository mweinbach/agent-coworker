import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "./types";
import { getOneOffChatsRoot, isPathInsideOneOffChatsRoot } from "./utils/oneOffChats";

export const ADVANCED_MEMORY_ROOT_DIRNAME = "memories";
export const ADVANCED_MEMORY_INDEX_FILENAME = "MEMORY.md";
export const ADVANCED_MEMORY_INDEX_HEADING = "# Memory Index";
export const ADVANCED_MEMORY_CHATS_FOLDER = "(chats)";

export type AdvancedMemoryEntry = {
  name: string;
  fileName: string;
  path: string;
  content: string;
  updatedAt: string;
};

export type AdvancedMemoryIndex = {
  rootDir: string;
  folderName: string;
  folderPath: string;
  indexPath: string;
  indexContent: string;
  entries: AdvancedMemoryEntry[];
};

const RESERVED_NAMES = new Set([ADVANCED_MEMORY_INDEX_FILENAME.toLowerCase()]);

function slugifyProjectFolder(value: string): string {
  const normalized = value
    .trim()
    .replace(/^[A-Za-z]:/, "")
    .replace(/[\\/]+/g, "__")
    .replace(/[^A-Za-z0-9._()-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return normalized || "workspace";
}

function normalizeMemoryFileName(name: string): string {
  const rawBase = path.basename(name.trim());
  const withoutExtension = rawBase.replace(/\.md$/i, "");
  const safeBase = withoutExtension
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-_. ]+|[-_. ]+$/g, "");
  const fileName = `${safeBase || "memory"}.md`;
  if (RESERVED_NAMES.has(fileName.toLowerCase())) {
    throw new Error(`${ADVANCED_MEMORY_INDEX_FILENAME} is reserved for the generated index.`);
  }
  return fileName;
}

function displayNameFromFileName(fileName: string): string {
  return fileName.replace(/\.md$/i, "");
}

function assertInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error("Resolved memory path escapes the advanced memory directory.");
}

export function advancedMemoryRootForConfig(config: Pick<AgentConfig, "userCoworkDir">): string {
  return path.join(config.userCoworkDir, ADVANCED_MEMORY_ROOT_DIRNAME);
}

export function advancedMemoryFolderNameForConfig(
  config: Pick<AgentConfig, "workingDirectory">,
  homedir = os.homedir(),
): string {
  if (isPathInsideOneOffChatsRoot(config.workingDirectory, homedir)) {
    return ADVANCED_MEMORY_CHATS_FOLDER;
  }
  const relativeHome = path.relative(homedir, config.workingDirectory);
  const source =
    relativeHome &&
    relativeHome !== ".." &&
    !relativeHome.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeHome)
      ? relativeHome
      : config.workingDirectory;
  return slugifyProjectFolder(source);
}

export class AdvancedMemoryStore {
  constructor(
    private readonly rootDir: string,
    private readonly folderName: string,
  ) {}

  static fromConfig(
    config: Pick<AgentConfig, "userCoworkDir" | "workingDirectory">,
  ): AdvancedMemoryStore {
    return new AdvancedMemoryStore(
      advancedMemoryRootForConfig(config),
      advancedMemoryFolderNameForConfig(config),
    );
  }

  get folderPath(): string {
    const folderPath = path.join(this.rootDir, this.folderName);
    assertInside(this.rootDir, folderPath);
    return folderPath;
  }

  get indexPath(): string {
    return path.join(this.folderPath, ADVANCED_MEMORY_INDEX_FILENAME);
  }

  async ensureInitialized(): Promise<void> {
    await fs.mkdir(this.folderPath, { recursive: true });
    try {
      await fs.access(this.indexPath);
    } catch {
      await fs.writeFile(this.indexPath, `${ADVANCED_MEMORY_INDEX_HEADING}\n`, "utf-8");
    }
  }

  private resolveEntryPath(name: string): { fileName: string; path: string } {
    const fileName = normalizeMemoryFileName(name);
    const filePath = path.join(this.folderPath, fileName);
    assertInside(this.folderPath, filePath);
    return { fileName, path: filePath };
  }

  async list(): Promise<AdvancedMemoryEntry[]> {
    await this.ensureInitialized();
    const dirents = await fs.readdir(this.folderPath, { withFileTypes: true });
    const entries: AdvancedMemoryEntry[] = [];
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue;
      if (!dirent.name.toLowerCase().endsWith(".md")) continue;
      if (dirent.name.toLowerCase() === ADVANCED_MEMORY_INDEX_FILENAME.toLowerCase()) continue;
      const filePath = path.join(this.folderPath, dirent.name);
      const [stat, content] = await Promise.all([
        fs.stat(filePath),
        fs.readFile(filePath, "utf-8"),
      ]);
      entries.push({
        name: displayNameFromFileName(dirent.name),
        fileName: dirent.name,
        path: filePath,
        content,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return entries.sort((left, right) => left.fileName.localeCompare(right.fileName));
  }

  async read(name: string): Promise<AdvancedMemoryEntry | null> {
    await this.ensureInitialized();
    const resolved = this.resolveEntryPath(name);
    try {
      const [stat, content] = await Promise.all([
        fs.stat(resolved.path),
        fs.readFile(resolved.path, "utf-8"),
      ]);
      return {
        name: displayNameFromFileName(resolved.fileName),
        fileName: resolved.fileName,
        path: resolved.path,
        content,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw error;
    }
  }

  async upsert(name: string, content: string): Promise<AdvancedMemoryEntry> {
    await this.ensureInitialized();
    const resolved = this.resolveEntryPath(name);
    await fs.writeFile(resolved.path, `${content.trimEnd()}\n`, "utf-8");
    await this.regenerateIndex();
    const entry = await this.read(resolved.fileName);
    if (!entry) throw new Error(`Failed to read saved memory ${resolved.fileName}.`);
    return entry;
  }

  async remove(name: string): Promise<boolean> {
    await this.ensureInitialized();
    const resolved = this.resolveEntryPath(name);
    try {
      await fs.unlink(resolved.path);
      await this.regenerateIndex();
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return false;
      throw error;
    }
  }

  async regenerateIndex(): Promise<AdvancedMemoryIndex> {
    await this.ensureInitialized();
    const entries = await this.list();
    const lines = [ADVANCED_MEMORY_INDEX_HEADING, ""];
    if (entries.length === 0) {
      lines.push("No advanced memories have been saved for this target yet.");
    } else {
      for (const entry of entries) {
        const title = firstMarkdownTitle(entry.content) ?? entry.name;
        const summary = firstFrontmatterSummary(entry.content);
        lines.push(
          `- [${entry.fileName}](./${entry.fileName}) — ${title}${summary ? `: ${summary}` : ""}`,
        );
      }
    }
    const indexContent = `${lines.join("\n").trimEnd()}\n`;
    await fs.writeFile(this.indexPath, indexContent, "utf-8");
    return {
      rootDir: this.rootDir,
      folderName: this.folderName,
      folderPath: this.folderPath,
      indexPath: this.indexPath,
      indexContent,
      entries,
    };
  }

  async readIndex(): Promise<AdvancedMemoryIndex> {
    await this.ensureInitialized();
    const [entries, indexContent] = await Promise.all([
      this.list(),
      fs.readFile(this.indexPath, "utf-8"),
    ]);
    return {
      rootDir: this.rootDir,
      folderName: this.folderName,
      folderPath: this.folderPath,
      indexPath: this.indexPath,
      indexContent,
      entries,
    };
  }
}

function firstMarkdownTitle(content: string): string | null {
  for (const line of content.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function firstFrontmatterSummary(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const frontmatter = content.slice(4, end).split("\n");
  for (const line of frontmatter) {
    const match = /^summary:\s*(.+)\s*$/.exec(line);
    if (!match?.[1]) continue;
    return match[1].replace(/^["']|["']$/g, "").trim();
  }
  return null;
}

export function oneOffChatsAdvancedMemoryStore(homedir = os.homedir()): AdvancedMemoryStore {
  return new AdvancedMemoryStore(
    path.join(getOneOffChatsRoot(homedir), "..", ADVANCED_MEMORY_ROOT_DIRNAME),
    ADVANCED_MEMORY_CHATS_FOLDER,
  );
}
