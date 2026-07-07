import fs from "node:fs/promises";

import { z } from "zod";
import { normalizeLineEndings, replaceRespectingEol } from "../platform/text";
import { resolveMaybeRelative } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

// Cap the input strings (mirrors the write tool's 2 MB content cap) and the
// target file size so a single edit cannot buffer a huge file into the heap.
const MAX_EDIT_STRING_LENGTH = 2_000_000;
const MAX_EDIT_FILE_BYTES = 10_000_000;

export function createEditTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Replace exact text in a file. The oldString must exist and be unique unless replaceAll is true.",
    inputSchema: z.object({
      filePath: z.string().min(1).describe("Path to the file (prefer absolute)"),
      oldString: z.string().min(1).max(MAX_EDIT_STRING_LENGTH).describe("Exact text to replace"),
      newString: z.string().max(MAX_EDIT_STRING_LENGTH).describe("Replacement text"),
      replaceAll: z.boolean().optional().default(false).describe("Replace all occurrences"),
    }),
    execute: async ({
      filePath,
      oldString,
      newString,
      replaceAll,
    }: {
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }) => {
      ctx.log(`tool> edit ${JSON.stringify({ filePath, replaceAll })}`);
      if (oldString === "") throw new Error("oldString cannot be empty");
      if (
        ctx.sandboxPolicy?.kind === "read-only" ||
        ctx.sandboxPolicy?.kind === "no-project-write"
      ) {
        throw new Error(`edit blocked: sandbox mode is ${ctx.sandboxPolicy.kind}`);
      }

      const abs = await assertWritePathAllowed(
        resolveMaybeRelative(filePath, ctx.config.workingDirectory),
        ctx.config,
        "edit",
        ctx.agentTargetPaths,
      );
      // Reject oversized files by stat() before reading them into a JS string.
      const stat = await fs.stat(abs);
      if (Number(stat.size) > MAX_EDIT_FILE_BYTES) {
        throw new Error(
          `edit blocked: ${abs} is ${Number(stat.size)} bytes (max ${MAX_EDIT_FILE_BYTES}).`,
        );
      }
      const content = await Bun.file(abs).text();

      // THE read/edit EOL contract (docs/platform-abstraction-plan.md row 5):
      // read presents an LF-normalized view, so a multi-line oldString the
      // model copies from read output carries bare \n. Match on LF-normalized
      // haystack+needle and re-emit the file's dominant EOL — on a CRLF
      // checkout the edit now succeeds AND the file stays CRLF instead of
      // being spliced into mixed line endings.
      const contentLf = normalizeLineEndings(content);
      const oldLf = normalizeLineEndings(oldString);
      if (!contentLf.includes(oldLf)) throw new Error(`oldString not found in ${abs}`);

      const occurrences = contentLf.split(oldLf).length - 1;
      if (!replaceAll && occurrences > 1) {
        throw new Error(
          `oldString found ${occurrences} times in ${abs}. Provide more context or set replaceAll=true.`,
        );
      }

      // A replaceAll over many short matches can multiply the result far beyond
      // the input caps (e.g. 1M single-char matches × a 2MB replacement). Reject
      // before building the string so the edit cannot exhaust the heap. CRLF
      // re-emission can add at most one byte per line; the cap is a soft heap
      // guard, so the LF-normalized projection is close enough.
      const replacedCount = replaceAll ? occurrences : Math.min(occurrences, 1);
      const projectedLength = contentLf.length + replacedCount * (newString.length - oldLf.length);
      if (projectedLength > MAX_EDIT_FILE_BYTES) {
        throw new Error(
          `edit blocked: result would be ~${projectedLength} bytes (max ${MAX_EDIT_FILE_BYTES}).`,
        );
      }

      const result = replaceRespectingEol(content, oldString, newString, { replaceAll });
      if (!result.ok) {
        // Defensive: the pre-checks above mirror replaceRespectingEol's rules.
        throw new Error(
          result.reason === "not_found"
            ? `oldString not found in ${abs}`
            : `oldString is not unique in ${abs}. Provide more context or set replaceAll=true.`,
        );
      }
      await ctx.assertCanMutate?.("edit");
      await Bun.write(abs, result.content);

      ctx.log(`tool< edit ${JSON.stringify({ ok: true })}`);
      return "Edit applied.";
    },
  });
}
