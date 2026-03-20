import fs from "node:fs/promises";
import path from "node:path";

import { toolResultContentFromOutput, type PiToolResultContentPart } from "./piMessageBridge";

import {
  effectiveToolOutputOverflowChars,
  MODEL_SCRATCHPAD_DIRNAME,
  TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS,
} from "../shared/toolOutputOverflow";

type OverflowSummaryField = "exitCode" | "ok" | "count" | "provider";

const SUMMARY_FIELDS: OverflowSummaryField[] = ["exitCode", "ok", "count", "provider"];
const PRIVATE_SCRATCHPAD_DIR_MODE = 0o700;
const PRIVATE_SCRATCHPAD_FILE_MODE = 0o600;
// `read` is intentionally exempt so the model can inspect large file contents inline.
const TOOL_OUTPUT_OVERFLOW_EXEMPT_TOOLS = new Set(["read"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isTextContentPart(part: unknown): part is { type: "text"; text: string } {
  const record = asRecord(part);
  return !!record && record.type === "text" && typeof record.text === "string";
}

function isTextOnlyRichOutput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((part) => isTextContentPart(part));
  }

  const record = asRecord(value);
  if (!record || record.type !== "content" || !Array.isArray(record.content)) return false;
  return record.content.length > 0 && record.content.every((part) => isTextContentPart(part));
}

function joinToolResultText(parts: PiToolResultContentPart[]): string {
  return parts
    .filter((part): part is Extract<PiToolResultContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function serializeToolOutputForSpill(output: unknown): string | null {
  const content = toolResultContentFromOutput(output);
  if (content.some((part) => part.type !== "text")) return null;

  if (typeof output === "string") return output;
  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return String(output);
  }
  if (output === undefined || output === null) return "";
  if (isTextOnlyRichOutput(output)) {
    return joinToolResultText(content);
  }

  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

function sanitizeFileSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 64);
}

function buildOverflowPreview(text: string): string {
  if (text.length <= TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS) return text;
  const remainder = text.length - TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS;
  return `${text.slice(0, TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS)}\n...[preview truncated ${remainder} chars]`;
}

function buildOverflowPointerText(filePath: string, chars: number, preview: string): string {
  const sections = [
    `Tool output overflowed (${chars} chars). Full output saved to ${filePath}.`,
    "Use the read tool to inspect the saved file if you need the full result.",
  ];
  if (preview.trim()) {
    sections.push(`Preview (first ${TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS.toLocaleString()} chars):\n${preview}`);
  }
  return sections.join("\n\n");
}

function isToolOutputOverflowExempt(toolName: string): boolean {
  return TOOL_OUTPUT_OVERFLOW_EXEMPT_TOOLS.has(toolName);
}

function pickSummaryFields(output: unknown): Record<string, unknown> {
  const record = asRecord(output);
  if (!record) return {};

  const summary: Record<string, unknown> = {};
  for (const field of SUMMARY_FIELDS) {
    if (record[field] !== undefined) {
      summary[field] = record[field];
    }
  }
  return summary;
}

export type ToolOutputOverflowResolution = {
  output: Record<string, unknown>;
  file: {
    kind: "tool-output-overflow";
    toolName: string;
    toolCallId: string;
    path: string;
    chars: number;
    preview: string;
  };
};

export async function maybeSpillToolOutputToWorkspace(opts: {
  output: unknown;
  toolName: string;
  toolCallId: string;
  workingDirectory: string;
  toolOutputOverflowChars: number | null | undefined;
  log?: (line: string) => void;
}): Promise<ToolOutputOverflowResolution | null> {
  const threshold = effectiveToolOutputOverflowChars(opts.toolOutputOverflowChars);
  if (threshold === null) return null;
  if (isToolOutputOverflowExempt(opts.toolName)) return null;

  const content = toolResultContentFromOutput(opts.output);
  if (content.some((part) => part.type !== "text")) return null;

  const inlineText = joinToolResultText(content);
  if (inlineText.length <= threshold) return null;

  const spillText = serializeToolOutputForSpill(opts.output);
  if (spillText === null) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scratchDir = path.join(opts.workingDirectory, MODEL_SCRATCHPAD_DIRNAME);
  const fileName = [
    timestamp,
    sanitizeFileSegment(opts.toolName, "tool"),
    sanitizeFileSegment(opts.toolCallId, "call"),
  ].join("__") + ".txt";
  const filePath = path.join(scratchDir, fileName);

  try {
    await fs.mkdir(scratchDir, { recursive: true, mode: PRIVATE_SCRATCHPAD_DIR_MODE });
    await fs.chmod(scratchDir, PRIVATE_SCRATCHPAD_DIR_MODE).catch(() => {});
    await fs.writeFile(filePath, spillText, { encoding: "utf-8", mode: PRIVATE_SCRATCHPAD_FILE_MODE });
    await fs.chmod(filePath, PRIVATE_SCRATCHPAD_FILE_MODE).catch(() => {});
  } catch (error) {
    opts.log?.(
      `[warn] Failed to write tool overflow spill file for ${opts.toolName}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  const preview = buildOverflowPreview(spillText);
  const chars = inlineText.length;
  const pointerText = buildOverflowPointerText(filePath, chars, preview);
  const output = {
    type: "text",
    value: pointerText,
    overflow: true,
    filePath,
    chars,
    preview,
    ...pickSummaryFields(opts.output),
  };

  return {
    output,
    file: {
      kind: "tool-output-overflow",
      toolName: opts.toolName,
      toolCallId: opts.toolCallId,
      path: filePath,
      chars,
      preview,
    },
  };
}
