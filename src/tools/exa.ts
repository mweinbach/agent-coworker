import { z } from "zod";

import { getAiCoworkerPaths } from "../store/connections";
import { resolveAuthHomeDir } from "../utils/authHome";
import { readToolApiKey } from "./api-keys";
import type { ToolContext } from "./context";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const stringSchema = z.string();
const arraySchema = z.array(z.unknown());
const recordSchema = z.record(z.string(), z.unknown());
const exaTextObjectSchema = z.object({ text: stringSchema }).passthrough();
const exaContentsResultSchema = z
  .object({
    title: stringSchema.optional(),
    url: stringSchema.optional(),
    text: z.unknown().optional(),
    highlights: z.unknown().optional(),
    extras: z.unknown().optional(),
  })
  .passthrough();
const exaContentsResponseSchema = z
  .object({
    results: z.array(exaContentsResultSchema).optional(),
  })
  .passthrough();

export const EXA_MISSING_KEY_MESSAGE = "set EXA_API_KEY or save Exa API key in provider settings";

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = nonEmptyTrimmedStringSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function getExaText(value: unknown): string {
  const directText = stringSchema.safeParse(value);
  if (directText.success) return directText.data;

  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return "";

  const nestedText = exaTextObjectSchema.safeParse(parsed.data);
  if (nestedText.success) return nestedText.data.text;

  return "";
}

function getExaStringList(value: unknown): string[] {
  const parsed = arraySchema.safeParse(value);
  if (!parsed.success) return [];

  const items: string[] = [];
  for (const item of parsed.data) {
    const directString = nonEmptyTrimmedStringSchema.safeParse(item);
    if (directString.success) {
      items.push(directString.data);
      continue;
    }

    const nested = recordSchema.safeParse(item);
    if (!nested.success) continue;

    const nestedString = firstNonEmptyString(
      nested.data.url,
      nested.data.href,
      nested.data.src,
      nested.data.link,
    );
    if (nestedString) items.push(nestedString);
  }

  return [...new Set(items)];
}

export async function resolveExaApiKey(ctx: ToolContext): Promise<string | undefined> {
  try {
    const paths = getAiCoworkerPaths({ homedir: resolveAuthHomeDir(ctx.config) });
    const saved = await readToolApiKey({ name: "exa", paths });
    if (saved?.trim()) return saved.trim();
  } catch {
    // Fall back to ambient env only when the saved-key path is unavailable.
  }

  const fromEnv = process.env.EXA_API_KEY?.trim();
  return fromEnv || undefined;
}

export async function postExaJson(opts: {
  apiKey: string;
  path: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return fetchImpl(`https://api.exa.ai${opts.path}`, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts.body),
    signal: opts.abortSignal,
  });
}

export async function fetchExaContents(opts: {
  apiKey: string;
  url: string;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<{ text: string; title?: string; url?: string; links: string[]; imageLinks: string[] }> {
  const res = await postExaJson({
    apiKey: opts.apiKey,
    path: "/contents",
    body: {
      urls: [opts.url],
      text: true,
      highlights: {
        maxCharacters: 4000,
      },
      extras: {
        links: 10,
        imageLinks: 5,
      },
    },
    fetchImpl: opts.fetchImpl,
    abortSignal: opts.abortSignal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Exa contents failed: ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const parsed = exaContentsResponseSchema.safeParse(data);
  const result = parsed.success ? (parsed.data.results ?? [])[0] : undefined;
  if (!result) {
    throw new Error(`Exa contents returned no result for ${opts.url}`);
  }

  const extras = recordSchema.safeParse(result.extras);
  const links = getExaStringList(extras.success ? extras.data.links : undefined);
  const imageLinks = getExaStringList(extras.success ? extras.data.imageLinks : undefined);
  const text =
    getExaText(result.text).trim() || getExaStringList(result.highlights).join("\n\n").trim();
  if (!text && links.length === 0 && imageLinks.length === 0) {
    throw new Error(`Exa contents returned no content for ${opts.url}`);
  }

  return {
    text,
    title: firstNonEmptyString(result.title),
    url: firstNonEmptyString(result.url),
    links,
    imageLinks,
  };
}
