import path from "node:path";

import { z } from "zod";

import { type MemoryScope, MemoryStore } from "../memoryStore";
import { truncateText } from "../utils/paths";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

// Memory is injected verbatim into future sessions' system prompts. Cap what a
// single entry can hold so the model cannot (a) persist an arbitrarily large
// payload that overflows the context window on the next session start, or
// (b) smuggle a huge instruction block into the prompt. Concise facts fit well
// under this; see also the render-time truncation in MemoryStore.
const MAX_MEMORY_CONTENT_LENGTH = 50_000;

function scopeFromInput(scope?: "workspace" | "user"): MemoryScope {
  return scope ?? "workspace";
}

function isHotCacheAlias(key?: string): boolean {
  if (!key) return false;
  return /^(hot|agent\.md)$/i.test(key.trim());
}

function defaultWriteKey(key?: string): string {
  return key?.trim() ? key : "hot";
}

function assertSandboxAllowsMemoryMutation(ctx: ToolContext): void {
  const sandboxKind = ctx.sandboxPolicy?.kind;
  if (sandboxKind === "read-only" || sandboxKind === "no-project-write") {
    throw new Error(`memory mutation blocked: sandbox is ${sandboxKind}.`);
  }
}

async function assertCanMutateMemory(ctx: ToolContext): Promise<void> {
  assertSandboxAllowsMemoryMutation(ctx);
  await ctx.assertCanMutate?.("memory");
}

export function createMemoryTool(ctx: ToolContext, _opts: { execFileImpl?: unknown } = {}) {
  const memoryStore = new MemoryStore(
    ctx.config.projectMemoryDbPath ?? path.join(ctx.config.projectCoworkDir, "memory.sqlite"),
    path.join(ctx.config.userCoworkDir, "memory.sqlite"),
  );

  return defineTool({
    description: `Read or update persistent memory entries stored in SQLite.

Actions:
- read: read one memory by key; omit key to read the hot cache
- write: create/update memory; omit key or use hot/AGENT.md to update the hot cache
- search: search memories by query
- delete: remove a memory entry`,
    inputSchema: z.object({
      action: z.enum(["read", "write", "search", "delete"]),
      key: z.string().optional().describe("Memory key/path (for read/write/delete)"),
      content: z
        .string()
        .max(
          MAX_MEMORY_CONTENT_LENGTH,
          `Memory content must be <= ${MAX_MEMORY_CONTENT_LENGTH} characters`,
        )
        .optional()
        .describe("Content to write (required for write)"),
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
      ctx.log(
        `tool> memory ${JSON.stringify({ action, key, hasContent: !!content, query, scope })}`,
      );

      try {
        if (!(ctx.config.enableMemory ?? true)) {
          ctx.log(`tool< memory ${JSON.stringify({ ok: false, action, reason: "disabled" })}`);
          return "Memory is disabled for this workspace.";
        }

        if (action === "write") {
          if (!content?.trim()) throw new Error("content is required for write action");
          await assertCanMutateMemory(ctx);
          if (ctx.config.memoryRequireApproval ?? false) {
            const answer = await ctx.askUser("Allow saving this memory?", ["approve", "deny"]);
            if (answer.trim().toLowerCase() !== "approve") {
              ctx.log(`tool< memory ${JSON.stringify({ ok: false, action, reason: "denied" })}`);
              return "Memory save denied by user.";
            }
            await assertCanMutateMemory(ctx);
          }
          const saved = await memoryStore.upsert(scopeFromInput(scope), {
            id: defaultWriteKey(key),
            content,
          });
          ctx.log(`tool< memory ${JSON.stringify({ ok: true, action, id: saved.id })}`);
          return `Memory written: ${saved.id}`;
        }

        if (action === "delete") {
          if (!key?.trim()) throw new Error("key is required for delete action");
          await assertCanMutateMemory(ctx);
          const removed = await memoryStore.remove(scopeFromInput(scope), key);
          ctx.log(`tool< memory ${JSON.stringify({ ok: removed, action, key })}`);
          return removed ? `Memory deleted: ${key}` : `Memory key "${key}" not found.`;
        }

        if (action === "read") {
          if (key?.trim()) {
            const entry = await memoryStore.getById(key, scope);
            if (!entry) {
              ctx.log(`tool< memory ${JSON.stringify({ ok: false, action, key, found: false })}`);
              return isHotCacheAlias(key)
                ? "No hot cache found."
                : `Memory key "${key}" not found.`;
            }
            ctx.log(
              `tool< memory ${JSON.stringify({ ok: true, action, key, chars: entry.content.length })}`,
            );
            return entry.content;
          }
          const hotEntry = await memoryStore.getById("hot", scope);
          if (!hotEntry) {
            ctx.log(
              `tool< memory ${JSON.stringify({ ok: false, action, key: "hot", found: false })}`,
            );
            return "No hot cache found.";
          }
          ctx.log(
            `tool< memory ${JSON.stringify({ ok: true, action, key: "hot", chars: hotEntry.content.length })}`,
          );
          return hotEntry.content;
        }

        if (!query?.trim()) throw new Error("query is required for search action");
        const normalizedQuery = query.toLowerCase();
        const matches = (await memoryStore.list(scope)).filter(
          (entry) =>
            entry.id.toLowerCase().includes(normalizedQuery) ||
            entry.content.toLowerCase().includes(normalizedQuery),
        );
        ctx.log(`tool< memory ${JSON.stringify({ ok: true, action, matches: matches.length })}`);
        if (matches.length === 0) return `No memory found for "${query}".`;
        return truncateText(
          matches.map((entry) => `[${entry.scope}] ${entry.id}: ${entry.content}`).join("\n"),
          30000,
        );
      } catch (error) {
        ctx.log(
          `tool< memory ${JSON.stringify({
            ok: false,
            action,
            error: error instanceof Error ? error.message : String(error),
          })}`,
        );
        throw error;
      }
    },
  });
}
