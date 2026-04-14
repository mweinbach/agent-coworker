import { z } from "zod";

import { getLocalWebSearchProviderFromProviderOptions, type LocalWebSearchProvider } from "../shared/openaiCompatibleOptions";
import { defineTool } from "./defineTool";
import type { ToolContext } from "./context";
import { EXA_MISSING_KEY_MESSAGE, postExaJson, resolveExaApiKey } from "./exa";
import { PARALLEL_MISSING_KEY_MESSAGE, postParallelJson, resolveParallelApiKey } from "./parallel";

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
const parallelResultSchema = z.object({
  url: stringSchema.optional(),
  title: z.union([stringSchema, z.null()]).optional(),
  publish_date: z.union([stringSchema, z.null()]).optional(),
  excerpts: z.union([z.array(z.string()), z.null()]).optional(),
}).passthrough();
const parallelResponseSchema = z.object({
  search_id: z.string().optional(),
  results: z.array(parallelResultSchema).optional(),
  warnings: z.array(z.unknown()).optional(),
  usage: z.array(z.unknown()).optional(),
}).passthrough();

type WebSearchProviderRequest = {
  query: string;
  maxResults: number;
  exaType: z.infer<typeof exaSearchTypeSchema>;
  exaCategory?: z.infer<typeof exaSearchCategorySchema>;
};

type WebSearchProviderOutput = {
  provider: LocalWebSearchProvider;
  request: Record<string, unknown>;
  count: number;
  response: Record<string, unknown>;
};

type WebSearchProviderDefinition = {
  label: string;
  description: string;
  missingKeyMessage: string;
  resolveApiKey: (ctx: ToolContext) => Promise<string | undefined>;
  execute: (opts: {
    apiKey: string;
    request: WebSearchProviderRequest;
  }) => Promise<WebSearchProviderOutput>;
};

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

function getParallelSnippet(result: unknown): string {
  const parsed = parallelResultSchema.safeParse(result);
  if (!parsed.success) return "";
  return (parsed.data.excerpts ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");
}

function normalizeExaCategory(value: z.infer<typeof exaSearchCategoryInputSchema> | undefined): z.infer<typeof exaSearchCategorySchema> | undefined {
  if (value === undefined) return undefined;
  return value === "news article" ? "news" : value;
}

const WEB_SEARCH_PROVIDERS: Record<LocalWebSearchProvider, WebSearchProviderDefinition> = {
  exa: {
    label: "Exa",
    description:
      "Search the web for current information using Exa. Requires EXA_API_KEY. Supports optional Exa search type/category controls and returns raw search response JSON with titles, URLs, and snippets/highlights.",
    missingKeyMessage: EXA_MISSING_KEY_MESSAGE,
    resolveApiKey: resolveExaApiKey,
    execute: async ({ apiKey, request }) => {
      const response = await postExaJson({
        apiKey,
        path: "/search",
        body: {
          query: request.query,
          numResults: request.maxResults,
          type: request.exaType,
          ...(request.exaCategory ? { category: request.exaCategory } : {}),
          contents: {
            highlights: {
              maxCharacters: 2500,
            },
          },
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Exa search failed: ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
      }

      const data = await response.json();
      const rawResponse = recordSchema.safeParse(data);
      const parsedData = exaResponseSchema.safeParse(data);
      const results = parsedData.success ? (parsedData.data.results ?? []) : [];
      return {
        provider: "exa",
        request: {
          query: request.query,
          numResults: request.maxResults,
          type: request.exaType,
          ...(request.exaCategory ? { category: request.exaCategory } : {}),
        },
        count: results.length,
        response: rawResponse.success
          ? rawResponse.data
          : {
              results: results.map((result) => ({
                title: firstNonEmptyString(result.title),
                url: firstNonEmptyString(result.url),
                snippet: getExaSnippet(result),
              })),
            },
      };
    },
  },
  parallel: {
    label: "Parallel",
    description:
      "Search the web for current information using Parallel. Requires PARALLEL_API_KEY. Returns raw search response JSON with titles, URLs, and LLM-ready excerpts.",
    missingKeyMessage: PARALLEL_MISSING_KEY_MESSAGE,
    resolveApiKey: resolveParallelApiKey,
    execute: async ({ apiKey, request }) => {
      const response = await postParallelJson({
        apiKey,
        path: "/v1beta/search",
        body: {
          objective: request.query,
          search_queries: [request.query],
          mode: "agentic",
          max_results: request.maxResults,
          excerpts: {
            max_chars_per_result: 2500,
            max_chars_total: Math.max(request.maxResults * 2500, 1000),
          },
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Parallel search failed: ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
      }

      const data = await response.json();
      const rawResponse = recordSchema.safeParse(data);
      const parsedData = parallelResponseSchema.safeParse(data);
      const results = parsedData.success ? (parsedData.data.results ?? []) : [];
      return {
        provider: "parallel",
        request: {
          objective: request.query,
          search_queries: [request.query],
          mode: "agentic",
          max_results: request.maxResults,
        },
        count: results.length,
        response: rawResponse.success
          ? rawResponse.data
          : {
              results: results.map((result) => ({
                title: firstNonEmptyString(result.title),
                url: firstNonEmptyString(result.url),
                publishDate: firstNonEmptyString(result.publish_date),
                snippet: getParallelSnippet(result),
              })),
            },
      };
    },
  },
};

function createCustomWebSearchTool(ctx: ToolContext) {
  const webSearchInputSchema = z.object({
    query: z.string().min(1).optional().describe("Search query"),
    q: z.string().min(1).optional(),
    searchQuery: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    type: exaSearchTypeSchema.optional().describe(
      "Optional Exa-only search type for more deliberate retrieval. Ignored by other web search providers."
    ),
    category: exaSearchCategoryInputSchema.optional().describe(
      "Optional Exa-only result category for focused search. Ignored by other web search providers."
    ),
    maxResults: z.number().int().min(1).max(20).optional().default(10),
  }).passthrough();
  const provider = WEB_SEARCH_PROVIDERS[getLocalWebSearchProviderFromProviderOptions(ctx.config.providerOptions)];

  return defineTool({
    description: provider.description,
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

      const request: WebSearchProviderRequest = {
        query: safeQuery,
        maxResults: parsedInput.data.maxResults ?? 10,
        exaType: parsedInput.data.type ?? "auto",
        exaCategory: normalizeExaCategory(parsedInput.data.category),
      };

      ctx.log(`tool> webSearch ${JSON.stringify({
        provider: provider.label.toLowerCase(),
        query: request.query,
        maxResults: request.maxResults,
        exaType: request.exaType,
        exaCategory: request.exaCategory,
      })}`);

      const apiKey = await provider.resolveApiKey(ctx);
      if (!apiKey) {
        const out = `webSearch disabled: ${provider.missingKeyMessage}`;
        ctx.log(`tool< webSearch ${JSON.stringify({ disabled: true, provider: provider.label.toLowerCase() })}`);
        return out;
      }

      try {
        const result = await provider.execute({ apiKey, request });
        ctx.log(`tool< webSearch ${JSON.stringify({ provider: result.provider, count: result.count })}`);
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.log(`tool< webSearch ${JSON.stringify({ ok: false, provider: provider.label.toLowerCase() })}`);
        return msg;
      }
    },
  });
}

export function createWebSearchTool(ctx: ToolContext) {
  return createCustomWebSearchTool(ctx);
}
