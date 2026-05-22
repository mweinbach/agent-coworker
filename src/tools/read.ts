import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { z } from "zod";
import { supportsImageInput } from "../models/registry";
import { getAttachmentByteLengthValidationMessage } from "../shared/attachments";
import {
  googleMultimodalPartTypeForMime,
  isBinaryMediaMimeType,
  isGoogleMultimodalProvider,
  mimeTypeFromPath,
  multimodalPartLabel,
} from "../shared/multimodalMime";
import { resolveMaybeRelative, truncateLine } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

function binaryMediaGuardMessage(filePath: string, mimeType: string): string {
  const basename = path.basename(filePath);
  return [
    `Cannot read ${basename} as text (${mimeType}).`,
    "This file is binary media (image, audio, video, or PDF).",
    "The read tool does not return audio, video, or PDF bytes because large tool results can exceed provider response limits.",
    "If the file was attached to the turn, use the already-attached media content; otherwise use a dedicated transcription or extraction workflow and write large output to a workspace file.",
  ].join(" ");
}

export function createReadTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Read a file from the filesystem. Returns line-numbered text for text files. For images, returns visual content when the model supports image input. Audio, video, and PDF files are binary media and are not returned through read; use attached media or dedicated extraction/transcription workflows. Use offset/limit for large text files.",
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
        "read",
      );

      const mimeType = mimeTypeFromPath(abs);
      const modelSupportsImages = supportsImageInput(ctx.config.provider, ctx.config.model);
      const isGoogleProvider = isGoogleMultimodalProvider(ctx.config);
      const multimodalPartType =
        mimeType &&
        googleMultimodalPartTypeForMime(mimeType, {
          modelSupportsImages,
          isGoogleProvider,
        });

      if (multimodalPartType === "image") {
        const buffer = await fs.readFile(abs);
        const sizeMessage = getAttachmentByteLengthValidationMessage([buffer.length]);
        if (sizeMessage) {
          throw new Error(sizeMessage);
        }

        const result = {
          type: "content",
          content: [
            {
              type: "text",
              text: `${multimodalPartLabel(multimodalPartType)} file: ${path.basename(abs)}`,
            },
            {
              type: multimodalPartType,
              data: buffer.toString("base64"),
              mimeType,
            },
          ],
        };
        ctx.log(
          `tool< read ${JSON.stringify({
            multimodal: true,
            partType: multimodalPartType,
            mimeType,
            bytes: buffer.length,
          })}`,
        );
        return result;
      }

      if (mimeType && isBinaryMediaMimeType(mimeType)) {
        const message = binaryMediaGuardMessage(abs, mimeType);
        ctx.log(`tool< read ${JSON.stringify({ binaryGuard: true, mimeType })}`);
        return message;
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
