import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

/**
 * Persistent prompt history stored as JSONL.
 * Matches opencode's history navigation pattern.
 */

const MAX_HISTORY_ENTRIES = 50;
const STATE_DIR = path.join(os.homedir(), ".cowork", "state");
const HISTORY_FILE = path.join(STATE_DIR, "prompt-history.jsonl");

export type PromptHistoryEntry = {
  input: string;
  mode?: "normal" | "shell";
  timestamp: number;
};

const promptHistoryEntrySchema: z.ZodType<PromptHistoryEntry> = z.object({
  input: z.string(),
  mode: z.enum(["normal", "shell"]).optional(),
  timestamp: z.number(),
});

function loadHistory(): PromptHistoryEntry[] {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => {
        try {
          const parsed = promptHistoryEntrySchema.safeParse(JSON.parse(line));
          if (!parsed.success) {
            return null;
          }
          return parsed.data;
        } catch {
          return null;
        }
      })
      .filter((e): e is PromptHistoryEntry => e !== null);
  } catch {
    return [];
  }
}

function saveHistory(entries: PromptHistoryEntry[]) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const content = entries.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(HISTORY_FILE, content + "\n");
  } catch {
    // ignore write errors
  }
}

export function createPromptHistory() {
  let entries = loadHistory();
  let index = -1;

  return {
    append(input: string, mode: "normal" | "shell" = "normal") {
      if (!input.trim()) return;
      // Remove duplicate if exists
      entries = entries.filter((e) => e.input !== input);
      entries.push({ input, mode, timestamp: Date.now() });
      // Trim to max
      if (entries.length > MAX_HISTORY_ENTRIES) {
        entries = entries.slice(-MAX_HISTORY_ENTRIES);
      }
      saveHistory(entries);
      index = -1;
    },

    navigateUp(currentInput: string): PromptHistoryEntry | null {
      if (entries.length === 0) return null;
      const next = index < entries.length - 1 ? index + 1 : index;
      index = next;
      return entries[entries.length - 1 - next] ?? null;
    },

    navigateDown(): PromptHistoryEntry | null {
      if (index <= 0) {
        index = -1;
        return { input: "", mode: "normal", timestamp: 0 };
      }
      index = index - 1;
      return entries[entries.length - 1 - index] ?? null;
    },

    resetIndex() {
      index = -1;
    },

    getEntries(): PromptHistoryEntry[] {
      return [...entries];
    },

    getIndex(): number {
      return index;
    },
  };
}
