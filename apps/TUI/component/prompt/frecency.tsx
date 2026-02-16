import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Frecency scoring: frequency × recency weighting.
 * Used to boost autocomplete results for frequently/recently used files.
 * Matches opencode's frecency algorithm.
 */

const MAX_FRECENCY_ENTRIES = 1000;
const STATE_DIR = path.join(os.homedir(), ".cowork", "state");
const FRECENCY_FILE = path.join(STATE_DIR, "frecency.jsonl");
const MS_PER_DAY = 86400000;

type FrecencyEntry = {
  path: string;
  frequency: number;
  lastOpen: number;
};

function calculateFrecency(entry?: FrecencyEntry): number {
  if (!entry) return 0;
  const daysSince = (Date.now() - entry.lastOpen) / MS_PER_DAY;
  const weight = 1 / (1 + daysSince); // Recency factor: 0 to 1
  return entry.frequency * weight; // Combine frequency + recency
}

function loadEntries(): Map<string, FrecencyEntry> {
  const map = new Map<string, FrecencyEntry>();
  try {
    const raw = fs.readFileSync(FRECENCY_FILE, "utf-8").trim();
    if (!raw) return map;
    for (const line of raw.split("\n")) {
      try {
        const entry = JSON.parse(line) as FrecencyEntry;
        map.set(entry.path, entry);
      } catch {
        // skip invalid lines
      }
    }
  } catch {
    // file doesn't exist yet
  }
  return map;
}

function saveEntries(map: Map<string, FrecencyEntry>) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Keep only the most recent MAX_FRECENCY_ENTRIES
    const sorted = [...map.values()].sort((a, b) => b.lastOpen - a.lastOpen);
    const trimmed = sorted.slice(0, MAX_FRECENCY_ENTRIES);
    const content = trimmed.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(FRECENCY_FILE, content + "\n");
  } catch {
    // ignore write errors
  }
}

export function createFrecencyTracker() {
  let entries = loadEntries();

  return {
    /** Get the frecency score for a path (0 if unknown). */
    getFrecency(filePath: string): number {
      const resolved = path.resolve(filePath);
      return calculateFrecency(entries.get(resolved));
    },

    /** Update frecency when a file is selected. */
    updateFrecency(filePath: string) {
      const resolved = path.resolve(filePath);
      const existing = entries.get(resolved);
      entries.set(resolved, {
        path: resolved,
        frequency: (existing?.frequency ?? 0) + 1,
        lastOpen: Date.now(),
      });
      saveEntries(entries);
    },

    /** Get all entries sorted by frecency score (descending). */
    getTopEntries(limit = 20): Array<{ path: string; score: number }> {
      return [...entries.entries()]
        .map(([p, entry]) => ({ path: p, score: calculateFrecency(entry) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
}
