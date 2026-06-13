import fs from "node:fs/promises";

import { z } from "zod";
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
      let content = await fs.readFile(abs, "utf-8");
      if (!content.includes(oldString)) throw new Error(`oldString not found in ${abs}`);

      const occurrences = content.split(oldString).length - 1;
      if (!replaceAll && occurrences > 1) {
        throw new Error(
          `oldString found ${occurrences} times in ${abs}. Provide more context or set replaceAll=true.`,
        );
      }

      // A replaceAll over many short matches can multiply the result far beyond
      // the input caps (e.g. 1M single-char matches × a 2MB replacement). Reject
      // before building the string so the edit cannot exhaust the heap.
      const replacedCount = replaceAll ? occurrences : Math.min(occurrences, 1);
      const projectedLength =
        content.length + replacedCount * (newString.length - oldString.length);
      if (projectedLength > MAX_EDIT_FILE_BYTES) {
        throw new Error(
          `edit blocked: result would be ~${projectedLength} bytes (max ${MAX_EDIT_FILE_BYTES}).`,
        );
      }

      content = replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);
      await fs.writeFile(abs, content, "utf-8");

      ctx.log(`tool< edit ${JSON.stringify({ ok: true })}`);
      return "Edit applied.";
    },
  });
}
