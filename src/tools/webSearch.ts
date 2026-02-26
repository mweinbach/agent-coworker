import path from "node:path";

import { Type } from "@mariozechner/pi-ai";
import { z } from "zod";

import { getAiCoworkerPaths, readToolApiKey } from "../connect";
import { toAgentTool } from "../pi/toolAdapter";
import type { ToolContext } from "./context";

interface CustomWebSearchToolOptions {
  exaOnly?: boolean;
}

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const stringSchema = z.string();
const recordSchema = z.record(z.string(), z.unknown());
const exaSnippetTextSchema = z.object({ text: stringSchema }).passthrough();
const braveResultSchema = z.object({
  title: stringSchema.optional(),
  url: stringSchema.optional(),
  description: stringSchema.optional(),
}).passthrough();
const braveResponseSchema = z.object({
  web: z.object({
    results: z.array(braveResultSchema).optional(),
  }).passthrough().optional(),
}).passthrough();
const exaResultSchema = z.object({
  title: stringSchema.optional(),
  url: stringSchema.optional(),
  text: z.unknown().optional(),
}).passthrough();
const exaResponseSchema = z.object({
  results: z.array(exaResultSchema).optional(),
}).passthrough();

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = nonEmptyTrimmedStringSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = stringSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
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
  const parsed = recordSchema.safeParse(result);
  if (!parsed.success) return "";

  const text = parsed.data.text;
  const directText = stringSchema.safeParse(text);
  if (directText.success) return directText.data;

  const nestedText = exaSnippetTextSchema.safeParse(text);
  if (nestedText.success) return nestedText.data.text;

  return "";
}

function resolveHomeDirFromToolContext(ctx: ToolContext): string | undefined {
  const parsed = nonEmptyTrimmedStringSchema.safeParse(ctx.config.userAgentDir);
  if (!parsed.success) return undefined;
  return path.dirname(parsed.data);
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

  return toAgentTool({
    name: "webSearch",
    description: exaOnly
      ? "Search the web for current information using Exa. Requires EXA_API_KEY. Returns titles, URLs, and snippets."
      : "Search the web for current information. Requires BRAVE_API_KEY or EXA_API_KEY. Returns titles, URLs, and snippets.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query" })),
      q: Type.Optional(Type.String()),
      searchQuery: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      maxResults: Type.Optional(Type.Integer({ description: "Max results", minimum: 1, maximum: 20, default: 10 })),
    }),
    execute: async (input) => {
      const rawQuery = firstString(
        input.query,
        input.q,
        input.searchQuery,
        input.text,
        input.prompt
      ) ?? firstString(ctx.turnUserPrompt);
      if (rawQuery === undefined) {
        const out = 'webSearch requires a query. Call webSearch with {"query":"..."}';
        ctx.log(`tool< webSearch ${JSON.stringify({ ok: false, reason: "missing_query" })}`);
        return out;
      }

      let safeQuery: string;
      try {
        safeQuery = sanitizeQuery(rawQuery);
      } catch (error) {
        const out = `webSearch invalid query: ${error instanceof Error ? error.message : String(error)}`;
        ctx.log(`tool< webSearch ${JSON.stringify({ ok: false, reason: "invalid_query" })}`);
        return out;
      }

      const maxResults = input.maxResults ?? 10;
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

        const data = await res.json();
        const parsedData = braveResponseSchema.safeParse(data);
        const braveResults = parsedData.success ? (parsedData.data.web?.results ?? []) : [];
        const results = braveResults.map((r) => ({
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

          const data = await res.json();
          const parsedData = exaResponseSchema.safeParse(data);
          const exaResults = parsedData.success ? (parsedData.data.results ?? []) : [];
          const results = exaResults.map((r) => ({
            title: firstNonEmptyString(r.title),
            url: firstNonEmptyString(r.url) ?? "",
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
  // All providers use the custom Brave/Exa search implementation.
  // Provider-native tools (Anthropic webSearch_20250305, OpenAI tools.webSearch)
  // are not compatible with pi's AgentTool format.
  switch (ctx.config.provider) {
    case "google":
      return createCustomWebSearchTool(ctx, { exaOnly: true });
    default:
      return createCustomWebSearchTool(ctx);
  }
}
