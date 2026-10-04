import { z } from "zod";

import { withRequestTimeout } from "../utils/abortSignal";
import { resolveProviderToolApiKey } from "./api-keys";
import type { ToolContext } from "./context";
import { firstNonEmptyString, getExaStringList } from "./exa";
import { readWebResponseJson } from "./webResponse";

export const PARALLEL_MISSING_KEY_MESSAGE =
  "set PARALLEL_API_KEY or save Parallel API key in provider settings";

export async function resolveParallelApiKey(ctx: ToolContext): Promise<string | undefined> {
  return await resolveProviderToolApiKey(ctx, "parallel", "PARALLEL_API_KEY");
}

// Per-request ceiling so a hung Parallel endpoint cannot stall the whole turn.
const PARALLEL_REQUEST_TIMEOUT_MS = 30_000;

export async function postParallelJson(opts: {
  apiKey: string;
  path: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return fetchImpl(`https://api.parallel.ai${opts.path}`, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts.body),
    signal: withRequestTimeout(opts.abortSignal, PARALLEL_REQUEST_TIMEOUT_MS),
  });
}

const stringSchema = z.string();
const parallelExtractResultSchema = z
  .object({
    url: stringSchema.optional(),
    title: z.union([stringSchema, z.null()]).optional(),
    excerpts: z.union([z.array(z.string()), z.null()]).optional(),
    full_content: z.union([z.array(z.string()), z.null()]).optional(),
    links: z.array(z.unknown()).optional(),
    image_links: z.array(z.unknown()).optional(),
    imageLinks: z.array(z.unknown()).optional(),
  })
  .passthrough();
const parallelExtractResponseSchema = z
  .object({
    results: z.array(parallelExtractResultSchema).optional(),
  })
  .passthrough();

function normalizeMarkdownSections(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function collectMarkdownUrls(markdown: string, pattern: RegExp): string[] {
  const urls = new Set<string>();
  for (const match of markdown.matchAll(pattern)) {
    const url = match[1]?.trim();
    if (url) urls.add(url);
  }
  return [...urls];
}

export async function fetchParallelContents(opts: {
  apiKey: string;
  url: string;
  objective?: string;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<{ text: string; title?: string; url?: string; links: string[]; imageLinks: string[] }> {
  const objective = firstNonEmptyString(opts.objective);
  const res = await postParallelJson({
    apiKey: opts.apiKey,
    path: "/v1beta/extract",
    body: {
      urls: [opts.url],
      ...(objective ? { objective } : {}),
      excerpts: {
        max_chars_per_result: 4000,
        max_chars_total: 4000,
      },
      full_content: false,
    },
    fetchImpl: opts.fetchImpl,
    abortSignal: opts.abortSignal,
  });

  const data = await readWebResponseJson(res, "Parallel extract");
  const parsed = parallelExtractResponseSchema.safeParse(data);
  const result = parsed.success ? (parsed.data.results ?? [])[0] : undefined;
  if (!result) {
    throw new Error(`Parallel extract returned no result for ${opts.url}`);
  }

  const text =
    normalizeMarkdownSections(result.excerpts).trim() ||
    normalizeMarkdownSections(result.full_content).trim();
  const links = [
    ...new Set([
      ...getExaStringList(result.links),
      ...collectMarkdownUrls(text, /\[[^\]]*?\]\((https?:\/\/[^)\s]+)\)/g),
    ]),
  ];
  const imageLinks = [
    ...new Set([
      ...getExaStringList(result.image_links),
      ...getExaStringList(result.imageLinks),
      ...collectMarkdownUrls(text, /!\[[^\]]*?\]\((https?:\/\/[^)\s]+)\)/g),
    ]),
  ];
  if (!text && links.length === 0 && imageLinks.length === 0) {
    throw new Error(`Parallel extract returned no content for ${opts.url}`);
  }

  return {
    text,
    title: firstNonEmptyString(result.title),
    url: firstNonEmptyString(result.url),
    links,
    imageLinks,
  };
}
