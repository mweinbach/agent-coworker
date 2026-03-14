import fs from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";

export type MemoryScope = "workspace" | "user";

const HOT_MEMORY_ID = "hot";

export type MemoryEntry = {
  id: string;
  scope: MemoryScope;
  content: string;
  createdAt: string;
  updatedAt: string;
};

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);
  `);
}

function normalizeMemoryId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "memory";
  return trimmed
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9/._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "memory";
}

function normalizeStoredMemoryId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "memory";
  if (/^(hot|agent\.md)$/i.test(trimmed)) return HOT_MEMORY_ID;
  return normalizeMemoryId(trimmed);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await fs.stat(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        await walk(full);
        continue;
      }
      if (stats.isFile() && name.toLowerCase().endsWith(".md")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

export class MemoryStore {
  constructor(
    private readonly workspaceDbPath: string,
    private readonly userDbPath: string,
  ) {}

  private dbPath(scope: MemoryScope): string {
    return scope === "workspace" ? this.workspaceDbPath : this.userDbPath;
  }

  private async ensureLegacyImported(
    scope: MemoryScope,
    db: Database,
    opts: { includeDeepStorage?: boolean } = {},
  ): Promise<void> {
    const imported = db.query("SELECT value FROM meta WHERE key = 'legacy_import_done'").get() as { value?: string } | null;
    if (imported?.value === "1") return;

    const dbPath = this.dbPath(scope);
    const agentDir = path.dirname(dbPath);
    const filesToImport: Array<{ id: string; content: string }> = [];

    const hotCachePath = path.join(agentDir, "AGENT.md");
    const hotCache = await readTextIfExists(hotCachePath);
    if (hotCache && hotCache.trim()) {
      filesToImport.push({ id: HOT_MEMORY_ID, content: hotCache });
    }

    if (opts.includeDeepStorage !== false) {
      const memoryDir = path.join(agentDir, "memory");
      const memoryFiles = await walkMarkdownFiles(memoryDir);
      for (const filePath of memoryFiles) {
        const content = await readTextIfExists(filePath);
        if (!content || !content.trim()) continue;
        const relative = path.relative(memoryDir, filePath);
        filesToImport.push({ id: normalizeMemoryId(relative), content });
      }
    }

    if (filesToImport.length > 0) {
      const timestamp = nowIso();
      const existingIds = new Set(
        (db.query("SELECT id FROM memories").all() as Array<{ id: string }>).map((row) => row.id)
      );
      const seenIds = new Set<string>();
      for (const item of filesToImport) {
        if (existingIds.has(item.id) || seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        db.query(
          "INSERT OR IGNORE INTO memories(id, content, created_at, updated_at) VALUES(?, ?, ?, ?)"
        ).run(item.id, item.content.trim(), timestamp, timestamp);
      }
    }

    db.query("INSERT OR REPLACE INTO meta(key, value) VALUES('legacy_import_done', '1')").run();
  }

  private async withDb<T>(
    scope: MemoryScope,
    op: (db: Database) => Promise<T> | T,
    opts: { includeDeepStorage?: boolean } = {},
  ): Promise<T> {
    const dbPath = this.dbPath(scope);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath, { create: true, strict: false });
    try {
      ensureSchema(db);
      await this.ensureLegacyImported(scope, db, opts);
      return await op(db);
    } finally {
      db.close(false);
    }
  }

  async list(scope?: MemoryScope): Promise<MemoryEntry[]> {
    if (scope) return this.listScope(scope);
    const [workspace, user] = await Promise.all([this.listScope("workspace"), this.listScope("user")]);
    return [...workspace, ...user].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async listScope(scope: MemoryScope): Promise<MemoryEntry[]> {
    return this.withDb(scope, (db) => {
      const rows = db.query("SELECT id, content, created_at, updated_at FROM memories ORDER BY updated_at DESC").all() as Array<{
        id: string;
        content: string;
        created_at: string;
        updated_at: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        scope,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  async getById(id: string, scope?: MemoryScope): Promise<MemoryEntry | null> {
    const normalizedId = normalizeStoredMemoryId(id);
    const scopes: MemoryScope[] = scope ? [scope] : ["workspace", "user"];
    for (const currentScope of scopes) {
      const match = await this.withDb(currentScope, (db) => {
        const row = db.query("SELECT id, content, created_at, updated_at FROM memories WHERE id = ?").get(normalizedId) as {
          id: string;
          content: string;
          created_at: string;
          updated_at: string;
        } | null;
        if (!row) return null;
        return {
          id: row.id,
          scope: currentScope,
          content: row.content,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        } satisfies MemoryEntry;
      });
      if (match) return match;
    }
    return null;
  }

  async upsert(scope: MemoryScope, input: { id?: string; content: string }): Promise<MemoryEntry> {
    const normalizedId = input.id?.trim() ? normalizeStoredMemoryId(input.id) : crypto.randomUUID();
    const content = input.content.trim();
    const timestamp = nowIso();
    return this.withDb(scope, (db) => {
      const existing = db.query("SELECT created_at FROM memories WHERE id = ?").get(normalizedId) as { created_at: string } | null;
      db.query(
        `INSERT INTO memories(id, content, created_at, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      ).run(normalizedId, content, existing?.created_at ?? timestamp, timestamp);
      return {
        id: normalizedId,
        scope,
        content,
        createdAt: existing?.created_at ?? timestamp,
        updatedAt: timestamp,
      };
    });
  }

  async remove(scope: MemoryScope, idRaw: string): Promise<boolean> {
    const id = normalizeStoredMemoryId(idRaw);
    return this.withDb(scope, (db) => {
      const result = db.query("DELETE FROM memories WHERE id = ?").run(id);
      return Number(result.changes ?? 0) > 0;
    });
  }

  async renderPromptSection(): Promise<string> {
    const workspaceHotCache = await this.getById(HOT_MEMORY_ID, "workspace");
    const activeHotCache = workspaceHotCache ?? await this.getById(HOT_MEMORY_ID, "user");
    if (!activeHotCache) return "";
    return [
      "## Memory",
      "",
      `This ${activeHotCache.scope} hot-cache memory is loaded into the system prompt.`,
      "Use the `memory` tool to read, write, search, or delete entries when the user asks to update memory.",
      "Treat memories as helpful context, but resolve conflicts in favor of the latest explicit user instruction.",
      "",
      "### Loaded Hot Cache",
      "",
      `#### ${activeHotCache.scope === "workspace" ? "Workspace" : "User"} Hot Cache`,
      "",
      activeHotCache.content,
    ].join("\n");
  }
}
