import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

import { z } from "zod";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { isPathInside, truncateText } from "../utils/paths";

const abortByNameSchema = z.object({ name: z.literal("AbortError") }).passthrough();
const errorCodeSchema = z.object({ code: z.union([z.string(), z.number()]) }).passthrough();

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

function keyToPath(baseDir: string, key: string): string {
  const normalized = key.endsWith(".md") ? key : `${key}.md`;
  const resolved = path.resolve(baseDir, normalized);
  if (!isPathInside(baseDir, resolved)) {
    throw new Error(`Memory key resolves outside memory directory: ${key}`);
  }
  return resolved;
}

async function findHotCache(ctx: ToolContext): Promise<{ path: string; content: string } | null> {
  const candidates = [
    path.join(ctx.config.projectAgentDir, "AGENT.md"),
    path.join(ctx.config.userAgentDir, "AGENT.md"),
  ];

  for (const p of candidates) {
    const content = await readIfExists(p);
    if (content !== null) return { path: p, content };
  }
  return null;
}

export function createMemoryTool(
  ctx: ToolContext,
  opts: { execFileImpl?: typeof execFile } = {}
) {
  const execFileImpl = opts.execFileImpl ?? execFile;

  return defineTool({
    description: `Read or update persistent memory.

Memory has two tiers:
1) Hot cache: .agent/AGENT.md (project) or ~/.agent/AGENT.md (user)
2) Deep storage: .agent/memory/ and ~/.agent/memory/

Use action=read to retrieve memory, action=write to store new information, and action=search to find across memory files.`,
    inputSchema: z.object({
      action: z.enum(["read", "write", "search"]),
      key: z.string().optional().describe("Memory key/path, e.g. 'people/sarah' or 'glossary'"),
      content: z.string().optional().describe("Content to write (required for write)"),
      query: z.string().optional().describe("Search query (required for search)"),
    }),
    execute: async ({ action, key, content, query }) => {
      ctx.log(`tool> memory ${JSON.stringify({ action, key, hasContent: !!content, query })}`);

      const projectMemoryDir = path.join(ctx.config.projectAgentDir, "memory");
      const userMemoryDir = path.join(ctx.config.userAgentDir, "memory");

      if (action === "read") {
        if (!key || key === "hot" || key === "AGENT.md") {
          const hot = await findHotCache(ctx);
          const out = hot ? hot.content : "No hot cache found.";
          ctx.log(`tool< memory ${JSON.stringify({ action, chars: out.length })}`);
          return out;
        }

        for (const dir of [projectMemoryDir, userMemoryDir]) {
          const p = keyToPath(dir, key);
          const found = await readIfExists(p);
          if (found !== null) {
            ctx.log(`tool< memory ${JSON.stringify({ action, path: p })}`);
            return found;
          }
        }

        const out = `Memory key "${key}" not found.`;
        ctx.log(`tool< memory ${JSON.stringify({ action, found: false })}`);
        return out;
      }

      if (action === "write") {
        if (!content) throw new Error("content is required for write action");

        if (!key || key === "hot" || key === "AGENT.md") {
          await fs.mkdir(ctx.config.projectAgentDir, { recursive: true });
          const p = path.join(ctx.config.projectAgentDir, "AGENT.md");
          await fs.writeFile(p, content, "utf-8");
          ctx.log(`tool< memory ${JSON.stringify({ action, path: p })}`);
          return "Hot cache updated.";
        }

        await fs.mkdir(projectMemoryDir, { recursive: true });
        const p = keyToPath(projectMemoryDir, key);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, content, "utf-8");
        ctx.log(`tool< memory ${JSON.stringify({ action, path: p })}`);
        return `Memory written: ${key}`;
      }

      if (action === "search") {
        if (!query) throw new Error("query is required for search action");
        if (ctx.abortSignal?.aborted) throw new Error("Cancelled by user");

        const parts: string[] = [];

        const hot = await findHotCache(ctx);
        if (hot && hot.content.toLowerCase().includes(query.toLowerCase())) {
          const lines = hot.content
            .split("\n")
            .filter((l) => l.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 50)
            .join("\n");
          parts.push(`[AGENT.md]\n${lines}`);
        }

        const rgOut = await new Promise<string | null>((resolve) => {
          execFileImpl(
            "rg",
            ["-n", "--no-heading", "--", query, projectMemoryDir, userMemoryDir],
            {
              maxBuffer: 1024 * 1024 * 5,
              ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            },
            (err, stdout, stderr) => {
              const isAbortByName = abortByNameSchema.safeParse(err).success;
              const parsedErrorCode = errorCodeSchema.safeParse(err);
              const code = parsedErrorCode.success ? parsedErrorCode.data.code : undefined;
              if (isAbortByName || code === "ABORT_ERR") {
                return resolve(`Memory search aborted.`);
              }
              if (code === 1) return resolve(null);
              if (code === "ENOENT") return resolve(null);
              if (err) return resolve(String(stderr || err));
              return resolve(stdout.toString());
            }
          );
        });

        if (rgOut === "Memory search aborted.") {
          throw new Error("Cancelled by user");
        }
        if (rgOut) parts.push(rgOut);

        const out = parts.length ? truncateText(parts.join("\n\n"), 30000) : `No memory found for "${query}".`;
        ctx.log(`tool< memory ${JSON.stringify({ action, chars: out.length })}`);
        return out;
      }

      return "Unknown action.";
    },
  });
}
