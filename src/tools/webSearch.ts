import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";

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

export function createWebSearchTool(ctx: ToolContext) {
  return tool({
    description:
      "Search the web for current information. Requires BRAVE_API_KEY or TAVILY_API_KEY. Returns titles, URLs, and snippets.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      maxResults: z.number().int().min(1).max(20).optional().default(10),
    }),
    execute: async ({ query, maxResults }) => {
      ctx.log(`tool> webSearch ${JSON.stringify({ query, maxResults })}`);

      if (process.env.BRAVE_API_KEY) {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
          query
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

      if (process.env.TAVILY_API_KEY) {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
            max_results: maxResults,
            search_depth: "basic",
            include_answer: false,
            include_images: false,
            include_raw_content: false,
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          const msg = `Tavily search failed: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`;
          ctx.log(`tool< webSearch ${JSON.stringify({ ok: false })}`);
          return msg;
        }

        const data = (await res.json()) as any;
        const results = (data?.results || []).map((r: any) => ({
          title: r.title,
          url: r.url,
          description: r.content,
        }));

        const out = formatResults(results);
        ctx.log(`tool< webSearch ${JSON.stringify({ provider: "tavily" })}`);
        return out;
      }

      const out = "webSearch disabled: set BRAVE_API_KEY or TAVILY_API_KEY";
      ctx.log(`tool< webSearch ${JSON.stringify({ disabled: true })}`);
      return out;
    },
  });
}
