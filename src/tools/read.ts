import path from "node:path";

import { z } from "zod";

import { defaultLocalToolExecutionBackend } from "../execution/local";
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
      const executionBackend = ctx.executionBackend ?? defaultLocalToolExecutionBackend;

      const imageMimeType = supportedImageMimeType(abs);
      if (imageMimeType) {
        const buffer = await executionBackend.readBinaryFile({ filePath: abs });
        const result = {
          type: "content",
          content: [
            { type: "text", text: `Image file: ${path.basename(abs)}` },
            { type: "image", data: Buffer.from(buffer).toString("base64"), mimeType: imageMimeType },
          ],
        };
        ctx.log(
          `tool< read ${JSON.stringify({ image: true, mimeType: imageMimeType, bytes: buffer.length })}`
        );
        return result;
      }

      const range = await executionBackend.readTextRange({
        filePath: abs,
        offset,
        limit,
        abortSignal: ctx.abortSignal,
      });
      const numbered = range.lines.map(({ lineNumber, text }) => `${lineNumber}\t${truncateLine(text, 2000)}`);

      if (range.totalLineCount === 0 && (offset || 1) === 1) {
        // Preserve existing behavior for empty files.
        numbered.push("1\t");
      }

      const res = numbered.join("\n");

      ctx.log(`tool< read ${JSON.stringify({ chars: res.length })}`);
      return res;
    },
  });
}
