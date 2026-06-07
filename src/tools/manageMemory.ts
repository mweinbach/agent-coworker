import path from "node:path";
import { z } from "zod";

import {
  type AdvancedMemoryEntry,
  AdvancedMemoryStore,
  CHATS_FOLDER,
  MEMORY_INDEX_FILE,
  resolveAdvancedMemoryAccessRoots,
  resolveMemoriesDir,
  slugifyMemoryName,
} from "../advancedMemory/store";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const memoryTypeSchema = z.enum(["feedback", "project", "note"]);

const inputSchema = z.object({
  action: z
    .enum(["list", "read", "create", "edit", "refresh_index"])
    .describe("Memory management action to perform."),
  name: z
    .string()
    .optional()
    .describe("Human-facing memory name. Required for create; usable as a read target."),
  slug: z
    .string()
    .optional()
    .describe("Stable memory slug. Required for edit; optional for read/create."),
  description: z.string().optional().describe("Short one-line memory summary."),
  type: memoryTypeSchema.optional().describe("Memory type. Defaults to note when creating."),
  body: z.string().optional().describe("Markdown body for create or edit."),
  source: z
    .enum(["auto", "active", "chats"])
    .optional()
    .describe("Read source. Writes always target the active folder."),
});

type ManageMemoryInput = z.infer<typeof inputSchema>;

type MemorySummary = Pick<
  AdvancedMemoryEntry,
  "slug" | "name" | "description" | "type" | "originSessionId" | "updatedAt"
>;

function summarize(entry: AdvancedMemoryEntry): MemorySummary {
  return {
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    type: entry.type,
    ...(entry.originSessionId ? { originSessionId: entry.originSessionId } : {}),
    updatedAt: entry.updatedAt,
  };
}

function requireString(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`manageMemory ${field} is required.`);
  return trimmed;
}

function editPatch(input: ManageMemoryInput) {
  const patch: {
    name?: string;
    description?: string;
    type?: "feedback" | "project" | "note";
    body?: string;
  } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.type !== undefined) patch.type = input.type;
  if (input.body !== undefined) patch.body = input.body;
  if (Object.keys(patch).length === 0) {
    throw new Error("manageMemory edit requires at least one field to update.");
  }
  return patch;
}

async function findByNameOrSlug(
  store: AdvancedMemoryStore,
  folders: readonly string[],
  target: string,
): Promise<{ folder: string; entry: AdvancedMemoryEntry } | null> {
  const wanted = target.trim().toLowerCase();
  for (const folder of folders) {
    const bySlug = await store.readMemory(folder, target);
    if (bySlug) return { folder, entry: bySlug };

    const entries = await store.listMemories(folder);
    const byName = entries.find(
      (entry) => entry.name.trim().toLowerCase() === wanted || entry.slug === wanted,
    );
    if (byName) return { folder, entry: byName };
  }
  return null;
}

function readFoldersForSource(
  readableFolders: readonly string[],
  activeFolder: string,
  source: ManageMemoryInput["source"],
): string[] {
  if (source === "active") return [activeFolder];
  if (source === "chats") return readableFolders.includes(CHATS_FOLDER) ? [CHATS_FOLDER] : [];
  return [...readableFolders];
}

function assertWritableSource(input: ManageMemoryInput, activeFolder: string): void {
  if (input.source === "chats" && activeFolder !== CHATS_FOLDER) {
    throw new Error(`${CHATS_FOLDER} is read-only in this project workspace.`);
  }
}

function assertSandboxAllowsMemoryMutation(ctx: ToolContext): void {
  if (ctx.sandboxPolicy?.kind === "read-only") {
    throw new Error("manageMemory mutation blocked: sandbox is read-only.");
  }
}

async function notifyMemoryChanged(ctx: ToolContext, folder: string): Promise<void> {
  await ctx.onAdvancedMemoryChanged?.(folder);
}

/**
 * Lets the main agent inspect and update the advanced file-based memory store
 * without granting arbitrary filesystem mutation.
 */
export function createManageMemoryTool(ctx: ToolContext) {
  const store = new AdvancedMemoryStore(resolveMemoriesDir(ctx.config));

  return defineTool({
    description:
      "List, read, create, edit, or refresh advanced long-term memories for this session. Writes always target the active memory folder. Use list/read before creating or editing.",
    inputSchema,
    execute: async (input: ManageMemoryInput) => {
      const access = resolveAdvancedMemoryAccessRoots(ctx.config);
      ctx.log(`tool> manageMemory ${JSON.stringify({ action: input.action })}`);

      if (input.action === "list") {
        const folders = await Promise.all(
          access.readableFolders.map(async (folder) => ({
            folder,
            path: store.folderPath(folder),
            writable: folder === access.writableFolder,
            memories: (await store.listMemories(folder)).map(summarize),
          })),
        );
        return {
          activeFolder: access.activeFolder,
          writableFolder: access.writableFolder,
          readableFolders: access.readableFolders,
          memoriesDir: access.memoriesDir,
          writeRoots: access.writeRoots,
          readRoots: access.readRoots,
          folders,
        };
      }

      if (input.action === "read") {
        const target = requireString(input.slug ?? input.name, "read name or slug");
        const folders = readFoldersForSource(
          access.readableFolders,
          access.activeFolder,
          input.source,
        );
        const found = await findByNameOrSlug(store, folders, target);
        if (!found) {
          return {
            found: false,
            target,
            searchedFolders: folders,
          };
        }
        return {
          found: true,
          folder: found.folder,
          writable: found.folder === access.writableFolder,
          memory: found.entry,
        };
      }

      if (input.action === "create") {
        assertSandboxAllowsMemoryMutation(ctx);
        assertWritableSource(input, access.activeFolder);
        const name = requireString(input.name, "create name");
        const description = requireString(input.description, "create description");
        const body = requireString(input.body, "create body");
        const slug = slugifyMemoryName(input.slug ?? name);
        const existing = await store.readMemory(access.activeFolder, slug);
        if (existing) {
          throw new Error(
            `Memory "${slug}" already exists in active folder "${access.activeFolder}".`,
          );
        }
        const memory = await store.writeMemory(access.activeFolder, {
          slug,
          name,
          description,
          type: input.type ?? "note",
          originSessionId: ctx.sessionId,
          body,
        });
        await notifyMemoryChanged(ctx, access.activeFolder);
        return {
          ok: true,
          action: "create",
          folder: access.activeFolder,
          memory: summarize(memory),
        };
      }

      if (input.action === "edit") {
        assertSandboxAllowsMemoryMutation(ctx);
        assertWritableSource(input, access.activeFolder);
        const slug = requireString(input.slug, "edit slug");
        const memory = await store.editMemory(access.activeFolder, slug, {
          ...editPatch(input),
          originSessionId: ctx.sessionId,
        });
        if (!memory) {
          return {
            ok: false,
            action: "edit",
            folder: access.activeFolder,
            slug: slugifyMemoryName(slug),
            reason: "not_found",
          };
        }
        await notifyMemoryChanged(ctx, access.activeFolder);
        return {
          ok: true,
          action: "edit",
          folder: access.activeFolder,
          memory: summarize(memory),
        };
      }

      assertSandboxAllowsMemoryMutation(ctx);
      await store.regenerateIndex(access.activeFolder);
      await notifyMemoryChanged(ctx, access.activeFolder);
      return {
        ok: true,
        action: "refresh_index",
        folder: access.activeFolder,
        indexPath: path.join(store.folderPath(access.activeFolder), MEMORY_INDEX_FILE),
      };
    },
  });
}
