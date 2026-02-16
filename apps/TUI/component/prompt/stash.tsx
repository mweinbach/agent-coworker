import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Prompt stash: temporary storage for prompt drafts.
 * LIFO stack with persistent storage.
 * Matches opencode's stash pattern.
 */

const MAX_STASH_ENTRIES = 50;
const STATE_DIR = path.join(os.homedir(), ".cowork", "state");
const STASH_FILE = path.join(STATE_DIR, "prompt-stash.jsonl");

export type StashEntry = {
  input: string;
  timestamp: number;
};

function loadStash(): StashEntry[] {
  try {
    const raw = fs.readFileSync(STASH_FILE, "utf-8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as StashEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is StashEntry => e !== null);
  } catch {
    return [];
  }
}

function saveStash(entries: StashEntry[]) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const content = entries.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(STASH_FILE, content + "\n");
  } catch {
    // ignore write errors
  }
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

export function createPromptStash() {
  let entries = loadStash();

  return {
    /** Push a prompt onto the stash. */
    push(input: string) {
      if (!input.trim()) return;
      entries.push({ input, timestamp: Date.now() });
      if (entries.length > MAX_STASH_ENTRIES) {
        entries = entries.slice(-MAX_STASH_ENTRIES);
      }
      saveStash(entries);
    },

    /** Pop the most recent stash entry. */
    pop(): StashEntry | null {
      if (entries.length === 0) return null;
      const entry = entries.pop()!;
      saveStash(entries);
      return entry;
    },

    /** List all stash entries (most recent last). */
    list(): StashEntry[] {
      return [...entries];
    },

    /** Remove a specific stash entry by index. */
    remove(index: number) {
      if (index >= 0 && index < entries.length) {
        entries.splice(index, 1);
        saveStash(entries);
      }
    },

    /** Get the count of stashed entries. */
    count(): number {
      return entries.length;
    },
  };
}
