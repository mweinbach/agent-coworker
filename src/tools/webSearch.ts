import path from "node:path";

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { tool } from "ai";
import { z } from "zod";

import { getAiCoworkerPaths, readToolApiKey } from "../connect";
import type { ToolContext } from "./context";

interface CustomWebSearchToolOptions {
  exaOnly?: boolean;
}

function formatResults(results: Array<{ title?: string; url?: string; description?: string }>): string {
  return (
    results
      .map((r) => {
        const title = r.title || "(no title)";
        const url = r.url || "";
        const desc = r.description || "";
        return `${title}\n${url}\n${desc}`.trim();
      })
      .join("\n\n") || "No results"
  );
}

function sanitizeQuery(raw: string): string {
  const query = raw.replace(/\s+/g, " ").trim();
  if (!query) throw new Error("webSearch requires a non-empty query");
  if (query.length > 1000) throw new Error("webSearch query is too long (max 1000 characters)");
  if (/[\u0000-\u001f]/.test(query)) throw new Error("webSearch query contains unsupported control characters");
  return query;
}

function getExaSnippet(result: unknown): string {
  const text = (result as any)?.text;
  if (typeof text === "string") return text;
  if (text && typeof text === "object" && typeof text.text === "string") return text.text;
  return "";
}

function resolveHomeDirFromToolContext(ctx: ToolContext): string | undefined {
  const userAgentDir = ctx.config.userAgentDir;
  if (typeof userAgentDir !== "string" || !userAgentDir) return undefined;
  return path.dirname(userAgentDir);
}

async function resolveExaApiKey(ctx: ToolContext): Promise<string | undefined> {
  const fromEnv = process.env.EXA_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  try {
    const homedir = resolveHomeDirFromToolContext(ctx);
    const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
    return await readToolApiKey({ name: "exa", paths });
  } catch {
    return undefined;
  }
}

function createCustomWebSearchTool(ctx: ToolContext, options: CustomWebSearchToolOptions = {}) {
  const exaOnly = options.exaOnly ?? false;

  return tool({
    description: exaOnly
      ? "Search the web for current information using Exa. Requires EXA_API_KEY. Returns titles, URLs, and snippets."
      : "Search the web for current information. Requires BRAVE_API_KEY or EXA_API_KEY. Returns titles, URLs, and snippets.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      maxResults: z.number().int().min(1).max(20).optional().default(10),
    }),
    execute: async ({ query, maxResults }) => {
      const safeQuery = sanitizeQuery(query);
      ctx.log(`tool> webSearch ${JSON.stringify({ query: safeQuery, maxResults })}`);

      if (!exaOnly && process.env.BRAVE_API_KEY) {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
          safeQuery
        )}&count=${maxResults}`;
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": process.env.BRAVE_API_KEY,
          },
        });

        if (!res.ok) {
          const text = await res.text();
          const msg = `Brave search failed: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`;
          ctx.log(`tool< webSearch ${JSON.stringify({ ok: false })}`);
          return msg;
        }

        const data = (await res.json()) as any;
        const results = (data?.web?.results || []).map((r: any) => ({
          title: r.title,
          url: r.url,
          description: r.description,
        }));

        const out = formatResults(results);
        ctx.log(`tool< webSearch ${JSON.stringify({ provider: "brave" })}`);
        return out;
      }

      const exaApiKey = await resolveExaApiKey(ctx);
      if (exaApiKey) {
        try {
          const res = await fetch("https://api.exa.ai/search", {
            method: "POST",
            headers: {
              "x-api-key": exaApiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: safeQuery,
              numResults: maxResults,
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            const msg = `Exa search failed: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`;
            ctx.log(`tool< webSearch ${JSON.stringify({ ok: false })}`);
            return msg;
          }

          const data = (await res.json()) as any;
          const results = (data?.results || []).map((r: any) => ({
            title: r.title || undefined,
            url: r.url || "",
            description: getExaSnippet(r),
          }));

          const out = formatResults(results);
          ctx.log(`tool< webSearch ${JSON.stringify({ provider: "exa" })}`);
          return out;
        } catch (error) {
          const msg = `Exa search failed: ${error instanceof Error ? error.message : String(error)}`;
          ctx.log(`tool< webSearch ${JSON.stringify({ ok: false })}`);
          return msg;
        }
      }

      const out = exaOnly
        ? "webSearch disabled: set EXA_API_KEY or save Exa API key in provider settings"
        : "webSearch disabled: set BRAVE_API_KEY or EXA_API_KEY";
      ctx.log(`tool< webSearch ${JSON.stringify({ disabled: true })}`);
      return out;
    },
  });
}

export function createWebSearchTool(ctx: ToolContext) {
  switch (ctx.config.provider) {
    case "openai":
      return openai.tools.webSearch({});
    case "google":
      if (ctx.config.model.toLowerCase().includes("gemini")) {
        return createCustomWebSearchTool(ctx, { exaOnly: true });
      }
      return google.tools.googleSearch({});
    case "anthropic":
      return anthropic.tools.webSearch_20250305({});
    case "codex-cli":
      return createCustomWebSearchTool(ctx);
  }
}
