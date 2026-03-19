import { z } from "zod";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { EXA_MISSING_KEY_MESSAGE, postExaJson, resolveExaApiKey } from "./exa";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const stringSchema = z.string();
const recordSchema = z.record(z.string(), z.unknown());
const exaSnippetTextSchema = z.object({ text: stringSchema }).passthrough();
const exaHighlightsSchema = z.array(z.string()).optional();
const exaSearchTypeSchema = z.enum(["neural", "fast", "auto", "deep", "deep-reasoning", "instant"]);
const exaSearchCategorySchema = z.enum([
  "company",
  "research paper",
  "news",
  "tweet",
  "personal site",
  "financial report",
  "people",
]);
const exaSearchCategoryInputSchema = z.union([exaSearchCategorySchema, z.literal("news article")]);
const exaResultSchema = z.object({
  title: stringSchema.optional(),
  url: stringSchema.optional(),
  text: z.unknown().optional(),
  highlights: exaHighlightsSchema,
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

  const highlights = exaHighlightsSchema.safeParse(parsed.data.highlights);
  if (highlights.success && highlights.data) {
    const joined = highlights.data
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n\n");
    if (joined) return joined;
  }

  const text = parsed.data.text;
  const directText = stringSchema.safeParse(text);
  if (directText.success) return directText.data;

  const nestedText = exaSnippetTextSchema.safeParse(text);
  if (nestedText.success) return nestedText.data.text;

  return "";
}

function normalizeExaCategory(value: z.infer<typeof exaSearchCategoryInputSchema> | undefined): z.infer<typeof exaSearchCategorySchema> | undefined {
  if (value === undefined) return undefined;
  return value === "news article" ? "news" : value;
}

function createCustomWebSearchTool(ctx: ToolContext) {
  const webSearchInputSchema = z.object({
    query: z.string().min(1).optional().describe("Search query"),
    q: z.string().min(1).optional(),
    searchQuery: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    type: exaSearchTypeSchema.optional().describe(
      "Optional Exa search type for more deliberate retrieval. Defaults to auto when Exa is used."
    ),
    category: exaSearchCategoryInputSchema.optional().describe(
      "Optional Exa result category for focused search. Leave unset by default; use only when the query clearly targets one category."
    ),
    maxResults: z.number().int().min(1).max(20).optional().default(10),
  }).passthrough();

  return defineTool({
    description:
      "Search the web for current information using Exa. Requires EXA_API_KEY. Supports optional Exa search type/category controls and returns the raw Exa search response JSON with titles, URLs, and snippets/highlights.",
    inputSchema: webSearchInputSchema,
    execute: async (input) => {
      const parsedInput = webSearchInputSchema.safeParse(input);
      if (!parsedInput.success) {
        const out = 'webSearch requires a query. Call webSearch with {"query":"..."}';
        ctx.log(`tool< webSearch ${JSON.stringify({ ok: false, reason: "missing_query" })}`);
        return out;
      }

      const rawQuery = firstString(
        parsedInput.data.query,
        parsedInput.data.q,
        parsedInput.data.searchQuery,
        parsedInput.data.text,
        parsedInput.data.prompt
      ) ?? firstString(ctx.turnUserPrompt, ctx.getTurnUserPrompt?.());
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

      const maxResults = parsedInput.data.maxResults ?? 10;
      const exaType = parsedInput.data.type ?? "auto";
      const exaCategory = normalizeExaCategory(parsedInput.data.category);

      ctx.log(`tool> webSearch ${JSON.stringify({ query: safeQuery, maxResults, exaType, exaCategory })}`);

      const exaApiKey = await resolveExaApiKey(ctx);
      if (exaApiKey) {
        try {
          const res = await postExaJson({
            apiKey: exaApiKey,
            path: "/search",
            body: {
              query: safeQuery,
              numResults: maxResults,
              type: exaType,
              ...(exaCategory ? { category: exaCategory } : {}),
              contents: {
                highlights: {
                  maxCharacters: 2500,
                },
              },
            },
          });
          if (!res.ok) {
            const text = await res.text();
            const msg = `Exa search failed: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`;
            ctx.log(`tool< webSearch ${JSON.stringify({ ok: false })}`);
            return msg;
          }

          const data = await res.json();
          const rawResponse = recordSchema.safeParse(data);
          const parsedData = exaResponseSchema.safeParse(data);
          const exaResults = parsedData.success ? (parsedData.data.results ?? []) : [];
          const out = {
            provider: "exa" as const,
            request: {
              query: safeQuery,
              numResults: maxResults,
              type: exaType,
              ...(exaCategory ? { category: exaCategory } : {}),
            },
            count: exaResults.length,
            response: rawResponse.success
              ? rawResponse.data
              : {
                  results: exaResults.map((result) => ({
                    title: firstNonEmptyString(result.title),
                    url: firstNonEmptyString(result.url),
                    snippet: getExaSnippet(result),
                  })),
                },
          };
          ctx.log(`tool< webSearch ${JSON.stringify({ provider: "exa", count: exaResults.length })}`);
          return out;
        } catch (error) {
          const msg = `Exa search failed: ${error instanceof Error ? error.message : String(error)}`;
          ctx.log(`tool< webSearch ${JSON.stringify({ ok: false })}`);
          return msg;
        }
      }

      const out = `webSearch disabled: ${EXA_MISSING_KEY_MESSAGE}`;
      ctx.log(`tool< webSearch ${JSON.stringify({ disabled: true })}`);
      return out;
    },
  });
}

export function createWebSearchTool(ctx: ToolContext) {
  return createCustomWebSearchTool(ctx);
}
