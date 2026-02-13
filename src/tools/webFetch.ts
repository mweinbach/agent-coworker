import { tool } from "ai";
import { z } from "zod";

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import type { ToolContext } from "./context";
import { truncateText } from "../utils/paths";
import { resolveSafeWebUrl } from "../utils/webSafety";

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function assertReadableContentType(contentType: string | null): void {
  if (!contentType) return;
  const normalized = contentType.toLowerCase();
  if (normalized.startsWith("text/")) return;
  if (normalized.includes("json")) return;
  if (normalized.includes("xml")) return;
  if (normalized.includes("javascript")) return;
  throw new Error(`Blocked non-text content type: ${contentType}`);
}

function buildPinnedUrl(resolved: { url: URL; addresses: { address: string; family: number }[] }): {
  pinnedUrl: URL;
  hostHeader: string;
} {
  const addr = resolved.addresses[0];
  if (!addr) throw new Error(`Blocked unresolved host: ${resolved.url.hostname}`);

  const pinnedUrl = new URL(resolved.url.toString());
  const hostHeader = pinnedUrl.host;
  pinnedUrl.hostname = addr.family === 6 ? `[${addr.address}]` : addr.address;
  return { pinnedUrl, hostHeader };
}

async function fetchWithSafeRedirects(url: string): Promise<Response> {
  let current = await resolveSafeWebUrl(url);

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const { pinnedUrl, hostHeader } = buildPinnedUrl(current);

    try {
      const res = await fetch(pinnedUrl, {
        redirect: "manual",
        headers: {
          "User-Agent": "agent-coworker/0.1",
          Host: hostHeader,
        },
        signal: controller.signal,
      });

      if (!isRedirectStatus(res.status)) return res;

      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`Redirect missing location header: ${current.url.toString()}`);
      }

      const next = new URL(location, current.url).toString();
      current = await resolveSafeWebUrl(next);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Too many redirects while fetching URL: ${url}`);
}

export function createWebFetchTool(ctx: ToolContext) {
  return tool({
    description:
      "Fetch a URL and return its content as clean markdown. Use to read documentation or web pages.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
      maxLength: z.number().int().min(1000).max(200000).optional().default(50000),
    }),
    execute: async ({ url, maxLength }) => {
      ctx.log(`tool> webFetch ${JSON.stringify({ url, maxLength })}`);

      const res = await fetchWithSafeRedirects(url);
      if (!res.ok) {
        throw new Error(`webFetch failed: ${res.status} ${res.statusText}`);
      }
      assertReadableContentType(res.headers.get("content-type"));
      const html = await res.text();

      const finalUrl = (await resolveSafeWebUrl(res.url || url)).url.toString();
      const dom = new JSDOM(html, { url: finalUrl });
      const article = new Readability(dom.window.document).parse();

      const turndown = new TurndownService();
      const md = article?.content
        ? turndown.turndown(article.content)
        : turndown.turndown(html);

      const out = truncateText(md, maxLength);
      ctx.log(`tool< webFetch ${JSON.stringify({ chars: out.length })}`);
      return out;
    },
  });
}
