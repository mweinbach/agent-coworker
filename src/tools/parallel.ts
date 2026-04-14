import { z } from "zod";

import { getAiCoworkerPaths } from "../store/connections";
import { resolveAuthHomeDir } from "../utils/authHome";
import { readToolApiKey } from "./api-keys";
import type { ToolContext } from "./context";

export const PARALLEL_MISSING_KEY_MESSAGE = "set PARALLEL_API_KEY or save Parallel API key in provider settings";

export async function resolveParallelApiKey(ctx: ToolContext): Promise<string | undefined> {
  try {
    const paths = getAiCoworkerPaths({ homedir: resolveAuthHomeDir(ctx.config) });
    const saved = await readToolApiKey({ name: "parallel", paths });
    if (saved?.trim()) return saved.trim();
  } catch {
    // Fall back to ambient env only when the saved-key path is unavailable.
  }

  const fromEnv = process.env.PARALLEL_API_KEY?.trim();
  return fromEnv || undefined;
}

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
    signal: opts.abortSignal,
  });
}

const stringSchema = z.string();
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const recordSchema = z.record(z.string(), z.unknown());
const parallelExtractResultSchema = z.object({
  url: stringSchema.optional(),
  title: z.union([stringSchema, z.null()]).optional(),
  excerpts: z.union([z.array(z.string()), z.null()]).optional(),
  full_content: z.union([z.array(z.string()), z.null()]).optional(),
  links: z.array(z.unknown()).optional(),
  image_links: z.array(z.unknown()).optional(),
  imageLinks: z.array(z.unknown()).optional(),
}).passthrough();
const parallelExtractResponseSchema = z.object({
  results: z.array(parallelExtractResultSchema).optional(),
}).passthrough();

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = nonEmptyTrimmedStringSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function normalizeMarkdownSections(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function collectMarkdownLinks(markdown: string): string[] {
  const matches = markdown.matchAll(/\[[^\]]*?\]\((https?:\/\/[^)\s]+)\)/g);
  const urls = new Set<string>();
  for (const match of matches) {
    const url = match[1]?.trim();
    if (url) urls.add(url);
  }
  return [...urls];
}

function collectImageLinks(markdown: string): string[] {
  const matches = markdown.matchAll(/!\[[^\]]*?\]\((https?:\/\/[^)\s]+)\)/g);
  const urls = new Set<string>();
  for (const match of matches) {
    const url = match[1]?.trim();
    if (url) urls.add(url);
  }
  return [...urls];
}

function collectExplicitUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls = new Set<string>();
  for (const entry of value) {
    const direct = firstNonEmptyString(entry);
    if (direct) {
      urls.add(direct);
      continue;
    }

    const parsed = recordSchema.safeParse(entry);
    if (!parsed.success) continue;
    const nested = firstNonEmptyString(
      parsed.data.url,
      parsed.data.href,
      parsed.data.src,
      parsed.data.link
    );
    if (nested) urls.add(nested);
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Parallel extract failed: ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const parsed = parallelExtractResponseSchema.safeParse(data);
  const result = parsed.success ? (parsed.data.results ?? [])[0] : undefined;
  if (!result) {
    throw new Error(`Parallel extract returned no result for ${opts.url}`);
  }

  const text =
    normalizeMarkdownSections(result.excerpts).trim()
    || normalizeMarkdownSections(result.full_content).trim();
  const links = [...new Set([
    ...collectExplicitUrls(result.links),
    ...collectMarkdownLinks(text),
  ])];
  const imageLinks = [...new Set([
    ...collectExplicitUrls(result.image_links),
    ...collectExplicitUrls(result.imageLinks),
    ...collectImageLinks(text),
  ])];
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
