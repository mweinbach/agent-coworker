import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { z } from "zod";
import { modelSupportsImageInputSync } from "../models/metadata";
import { getAttachmentByteLengthValidationMessage } from "../shared/attachments";
import {
  googleMultimodalPartTypeForMime,
  isBinaryMediaMimeType,
  isGoogleMultimodalProvider,
  mimeTypeFromPath,
  multimodalPartLabel,
} from "../shared/multimodalMime";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

type SniffedBom = "utf-8" | "utf-16le" | "utf-16be" | null;

const MAX_READ_LINE_CHARS = 2_000;

type ReadStreamFactory = (
  filePath: string,
  options?: { encoding?: BufferEncoding; start?: number },
) => ReturnType<typeof createReadStream>;

async function sniffBom(abs: string): Promise<SniffedBom> {
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(3);
    const { bytesRead } = await fh.read(buf, 0, 3, 0);
    if (bytesRead >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf-8";
    if (bytesRead >= 2) {
      if (buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
      if (buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
    }
    return null;
  } finally {
    await fh.close();
  }
}

function binaryMediaGuardMessage(filePath: string, mimeType: string): string {
  const basename = path.basename(filePath);
  return [
    `Cannot read ${basename} as text (${mimeType}).`,
    "This file is binary media (image, audio, video, or PDF).",
    "The read tool does not return audio, video, or PDF bytes because large tool results can exceed provider response limits.",
    "If the file was attached to the turn, use the already-attached media content; otherwise use a dedicated transcription or extraction workflow and write large output to a workspace file.",
  ].join(" ");
}

function createFileTextDecoder(encoding: SniffedBom) {
  const decoder = new StringDecoder(
    encoding === "utf-16le" || encoding === "utf-16be" ? "utf16le" : "utf8",
  );
  let firstText = true;
  let pendingByte: number | undefined;
  const withoutBom = (text: string) => {
    if (!firstText || text.length === 0) return text;
    firstText = false;
    return encoding && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  };
  return {
    write: (chunk: Uint8Array) => {
      let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (encoding === "utf-16be") {
        if (pendingByte !== undefined) bytes = Buffer.concat([Buffer.from([pendingByte]), bytes]);
        const evenLength = bytes.length - (bytes.length % 2);
        pendingByte = evenLength < bytes.length ? bytes[evenLength] : undefined;
        bytes = Buffer.from(bytes.subarray(0, evenLength)).swap16();
      }
      return withoutBom(decoder.write(bytes));
    },
    // Keep the existing read/edit decoding contract for dangling UTF-16 bytes
    // and unpaired surrogates instead of silently replacing them with U+FFFD.
    end: () => withoutBom(decoder.end()),
  };
}

/** Keep only the requested character window, never a whole unbounded source line. */
async function readTextRange(
  source: ReturnType<typeof createReadStream>,
  encoding: SniffedBom,
  opts: { offset: number; columnOffset: number; limit: number; signal?: AbortSignal },
): Promise<string> {
  const decoder = createFileTextDecoder(encoding);
  const lastLine = opts.offset + opts.limit - 1;
  const numbered: string[] = [];
  const lineBreak = /[\r\n]/g;
  let lineNo = 1;
  let lineLength = 0;
  let window = "";
  let skipLeadingLf = false;
  let sawText = false;
  const columnStart = () => (lineNo === opts.offset ? opts.columnOffset - 1 : 0);
  const emitLine = () => {
    if (lineNo < opts.offset || lineNo > lastLine) return;
    const nextColumn = columnStart() + window.length + 1;
    const continuation =
      lineLength >= nextColumn
        ? `... [line ${lineNo} continues; read offset=${lineNo} columnOffset=${nextColumn} limit=1]`
        : "";
    numbered.push(`${lineNo}\t${window}${continuation}`);
  };
  const consume = (text: string): boolean => {
    if (text.length === 0) return false;
    sawText = true;
    let cursor = skipLeadingLf && text[0] === "\n" ? 1 : 0;
    skipLeadingLf = false;
    lineBreak.lastIndex = cursor;
    while (cursor < text.length) {
      const separator = lineBreak.exec(text);
      const end = separator?.index ?? text.length;
      if (lineNo >= opts.offset && lineNo <= lastLine) {
        const start = Math.max(cursor, cursor + columnStart() - lineLength);
        const stop = Math.min(end, cursor + columnStart() + MAX_READ_LINE_CHARS - lineLength);
        if (start < stop) window += text.slice(start, stop);
      }
      lineLength += end - cursor;
      // Once the last requested line has a continuation, nothing after this
      // window can affect the result. Close even if that line spans gigabytes.
      if (lineNo === lastLine && lineLength > columnStart() + MAX_READ_LINE_CHARS) {
        emitLine();
        return true;
      }
      if (!separator) return false;
      emitLine();
      if (lineNo === lastLine) return true;
      lineNo += 1;
      lineLength = 0;
      window = "";
      cursor = end + 1;
      if (separator[0] === "\r") {
        if (cursor === text.length) skipLeadingLf = true;
        else if (text[cursor] === "\n") cursor += 1;
      }
      lineBreak.lastIndex = cursor;
    }
    return false;
  };

  const close = () => source.destroy();
  opts.signal?.addEventListener("abort", close, { once: true });
  try {
    opts.signal?.throwIfAborted();
    for await (const chunk of source) {
      opts.signal?.throwIfAborted();
      if (consume(decoder.write(chunk))) return numbered.join("\n");
    }
    opts.signal?.throwIfAborted();
    if (!consume(decoder.end()) && (lineLength > 0 || (lineNo === 1 && !sawText))) {
      emitLine();
    }
    return numbered.join("\n");
  } catch (error) {
    opts.signal?.throwIfAborted();
    throw error;
  } finally {
    opts.signal?.removeEventListener("abort", close);
    close();
  }
}

export function createReadTool(
  ctx: ToolContext,
  opts: { createReadStreamImpl?: ReadStreamFactory } = {},
) {
  const createStream: ReadStreamFactory =
    opts.createReadStreamImpl ?? ((filePath, options) => createReadStream(filePath, options));
  return defineTool({
    description:
      "Read a concrete file from the filesystem, not a directory. Returns line-numbered text for text files. Use offset/limit for large files and columnOffset to continue a source line longer than 2,000 characters. For images, returns visual content when the model supports image input. Audio, video, and PDF files are binary media and are not returned through read; use attached media or dedicated extraction/transcription workflows.",
    inputSchema: z.object({
      filePath: z.string().describe("Path to the file (prefer absolute)"),
      offset: z.number().int().min(1).optional().describe("Start line (1-indexed)"),
      columnOffset: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe("Start character in the first returned line (1-indexed)"),
      limit: z.number().int().min(1).max(20000).optional().default(2000).describe("Max lines"),
    }),
    execute: async ({
      filePath,
      offset,
      columnOffset = 1,
      limit,
    }: {
      filePath: string;
      offset?: number;
      columnOffset?: number;
      limit: number;
    }) => {
      ctx.log(`tool> read ${JSON.stringify({ filePath, offset, columnOffset, limit })}`);
      ctx.abortSignal?.throwIfAborted();

      const abs = await assertReadPathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "read",
        ctx.agentTargetPaths,
      );
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        const message = [
          `Cannot read ${path.basename(abs) || abs} because it is a directory.`,
          "The read tool accepts concrete file paths only.",
          "Use glob, grep, or a directory-listing tool when available, or choose a file inside the directory.",
        ].join(" ");
        ctx.log(`tool< read ${JSON.stringify({ directoryGuard: true })}`);
        return message;
      }
      if (!stat.isFile()) {
        throw new Error(`Cannot read ${path.basename(abs) || abs}: not a regular file.`);
      }

      const mimeType = mimeTypeFromPath(abs);
      const modelSupportsImages = modelSupportsImageInputSync(ctx.config);
      const isGoogleProvider = isGoogleMultimodalProvider(ctx.config);
      const multimodalPartType =
        mimeType &&
        googleMultimodalPartTypeForMime(mimeType, {
          modelSupportsImages,
          isGoogleProvider,
        });

      if (multimodalPartType === "image") {
        // Reject by stat() BEFORE reading the file into memory. A workspace can
        // contain an attacker-planted multi-GB file with an image extension;
        // reading it first would OOM the process before the size check fires.
        const preReadSizeMessage = getAttachmentByteLengthValidationMessage([Number(stat.size)]);
        if (preReadSizeMessage) {
          throw new Error(preReadSizeMessage);
        }
        const buffer = await fs.readFile(abs, { signal: ctx.abortSignal });
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

      // The documented canonical view: LF-normalized lines regardless of the
      // file's true EOL bytes; edit round-trips the real EOL (platform/text).
      // BOMs are decoded, never leaked into line 1 where a model would copy
      // them into an edit oldString. UTF-16 (a common PowerShell redirection
      // artifact on Windows) is decoded instead of mojibaked.
      const bom = await sniffBom(abs);
      ctx.abortSignal?.throwIfAborted();
      const res = await readTextRange(createStream(abs), bom, {
        offset: offset || 1,
        columnOffset,
        limit,
        signal: ctx.abortSignal,
      });

      ctx.log(`tool< read ${JSON.stringify({ chars: res.length })}`);
      return res;
    },
  });
}
