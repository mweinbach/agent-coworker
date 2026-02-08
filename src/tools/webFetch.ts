import { tool } from "ai";
import { z } from "zod";

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import type { ToolContext } from "./context";
import { truncateText } from "../utils/paths";

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

      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "agent-coworker/0.1" },
      });
      const html = await res.text();

      const dom = new JSDOM(html, { url });
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
