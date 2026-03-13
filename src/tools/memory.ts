import path from "node:path";

import { z } from "zod";

import { MemoryStore, type MemoryScope } from "../memoryStore";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { truncateText } from "../utils/paths";

function scopeFromInput(scope?: "workspace" | "user"): MemoryScope {
  return scope ?? "workspace";
}

export function createMemoryTool(
  ctx: ToolContext,
  _opts: { execFileImpl?: unknown } = {}
) {
  const memoryStore = new MemoryStore(
    path.join(ctx.config.projectAgentDir, "memory.sqlite"),
    path.join(ctx.config.userAgentDir, "memory.sqlite")
  );

  return defineTool({
    description: `Read or update persistent memory entries stored in SQLite.

Actions:
- read: read one memory by key, or list memories when no key is provided
- write: create/update memory
- search: search memories by query
- delete: remove a memory entry`,
    inputSchema: z.object({
      action: z.enum(["read", "write", "search", "delete"]),
      key: z.string().optional().describe("Memory key/path (for read/write/delete)"),
      content: z.string().optional().describe("Content to write (required for write)"),
      query: z.string().optional().describe("Search query (required for search)"),
      scope: z.enum(["workspace", "user"]).optional().describe("Memory scope (default workspace)"),
    }),
    execute: async ({
      action,
      key,
      content,
      query,
      scope,
    }: {
      action: "read" | "write" | "search" | "delete";
      key?: string;
      content?: string;
      query?: string;
      scope?: "workspace" | "user";
    }) => {
      ctx.log(`tool> memory ${JSON.stringify({ action, key, hasContent: !!content, query, scope })}`);

      if (!(ctx.config.enableMemory ?? true)) {
        return "Memory is disabled for this workspace.";
      }

      if (action === "write") {
        if (!content?.trim()) throw new Error("content is required for write action");
        if (ctx.config.memoryRequireApproval ?? false) {
          const answer = await ctx.askUser("Allow saving this memory?", ["approve", "deny"]);
          if (answer.trim().toLowerCase() !== "approve") {
            return "Memory save denied by user.";
          }
        }
        const saved = await memoryStore.upsert(scopeFromInput(scope), { id: key, content });
        return `Memory written: ${saved.id}`;
      }

      if (action === "delete") {
        if (!key?.trim()) throw new Error("key is required for delete action");
        const removed = await memoryStore.remove(scopeFromInput(scope), key);
        return removed ? `Memory deleted: ${key}` : `Memory key "${key}" not found.`;
      }

      if (action === "read") {
        if (key?.trim()) {
          const entry = await memoryStore.getById(key, scope);
          if (!entry) return `Memory key "${key}" not found.`;
          return entry.content;
        }
        const entries = await memoryStore.list(scope);
        if (entries.length === 0) return "No memory found.";
        return truncateText(entries.map((entry) => `[${entry.scope}] ${entry.id}: ${entry.content}`).join("\n"), 30000);
      }

      if (!query?.trim()) throw new Error("query is required for search action");
      const normalizedQuery = query.toLowerCase();
      const matches = (await memoryStore.list(scope)).filter(
        (entry) => entry.id.toLowerCase().includes(normalizedQuery) || entry.content.toLowerCase().includes(normalizedQuery)
      );
      if (matches.length === 0) return `No memory found for "${query}".`;
      return truncateText(matches.map((entry) => `[${entry.scope}] ${entry.id}: ${entry.content}`).join("\n"), 30000);
    },
  });
}
