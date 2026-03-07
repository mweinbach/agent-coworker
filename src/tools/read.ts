import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { z } from "zod";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { resolveMaybeRelative, truncateLine } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";

function supportedImageMimeType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

export function createReadTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Read a file from the filesystem. Returns line-numbered text for text files and visual content for supported images. Use offset/limit for large text files.",
    inputSchema: z.object({
      filePath: z.string().describe("Path to the file (prefer absolute)"),
      offset: z.number().int().min(1).optional().describe("Start line (1-indexed)"),
      limit: z.number().int().min(1).max(20000).optional().default(2000).describe("Max lines"),
    }),
    execute: async ({
      filePath,
      offset,
      limit,
    }: {
      filePath: string;
      offset?: number;
      limit: number;
    }) => {
      ctx.log(`tool> read ${JSON.stringify({ filePath, offset, limit })}`);

      const abs = await assertReadPathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "read"
      );

      const imageMimeType = supportedImageMimeType(abs);
      if (imageMimeType) {
        const buffer = await fs.readFile(abs);
        const result = {
          type: "content",
          content: [
            { type: "text", text: `Image file: ${path.basename(abs)}` },
            { type: "image", data: buffer.toString("base64"), mimeType: imageMimeType },
          ],
        };
        ctx.log(
          `tool< read ${JSON.stringify({ image: true, mimeType: imageMimeType, bytes: buffer.length })}`
        );
        return result;
      }

      const start = (offset || 1) - 1;
      const end = start + limit;
      const numbered: string[] = [];

      let lineNo = 0;
      const stream = createReadStream(abs, { encoding: "utf-8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          lineNo += 1;
          if (lineNo <= start) continue;
          if (lineNo > end) break;
          if (ctx.abortSignal?.aborted) throw new Error("Cancelled by user");
          numbered.push(`${lineNo}\t${truncateLine(line, 2000)}`);
        }
      } finally {
        rl.close();
        stream.destroy();
      }

      if (lineNo === 0 && start === 0) {
        // Preserve existing behavior for empty files.
        numbered.push("1\t");
      }

      const res = numbered.join("\n");

      ctx.log(`tool< read ${JSON.stringify({ chars: res.length })}`);
      return res;
    },
  });
}
