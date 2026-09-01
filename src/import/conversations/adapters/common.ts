import fs from "node:fs/promises";
import path from "node:path";

import type {
  ConversationImportWarning,
  ConversationPreviewOptions,
  ExternalConversation,
} from "../types";

/** Keep a bounded preview while scanning past rows outside the current selection. */
export async function collectConversationPreviews<T>(
  candidates: Iterable<T>,
  parse: (candidate: T) => ExternalConversation | null | Promise<ExternalConversation | null>,
  opts: ConversationPreviewOptions,
): Promise<ExternalConversation[]> {
  const limit = Math.max(1, Math.floor(opts.limit ?? 250));
  const preferred: ExternalConversation[] = [];
  const fallback: ExternalConversation[] = [];
  for (const candidate of candidates) {
    const conversation = await parse(candidate);
    if (!conversation) continue;
    if (!opts.preferConversation || opts.preferConversation(conversation)) {
      preferred.push(conversation);
      fallback.length = Math.min(fallback.length, limit - preferred.length);
      if (preferred.length === limit) break;
    } else if (fallback.length < limit - preferred.length) {
      fallback.push(conversation);
    }
  }
  return [...preferred, ...fallback];
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

export async function readJsonlRecords(
  filePath: string,
  warnings: ConversationImportWarning[],
): Promise<Array<Record<string, unknown>>> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    warnings.push({
      code: "parse_partial",
      message: `Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return [];
  }

  const records: Array<Record<string, unknown>> = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch (error) {
      warnings.push({
        code: "parse_partial",
        message: `Unable to parse ${path.basename(filePath)} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return records;
}

export async function listFilesRecursive(
  root: string,
  predicate: (filePath: string) => boolean,
): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(next);
      } else if (entry.isFile() && predicate(next)) {
        result.push(next);
      }
    }
  }
  await visit(root);
  return result.sort();
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
