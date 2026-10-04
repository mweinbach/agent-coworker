import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  asNumber,
  asRecord,
  asString,
  collectConversationPreviews,
  listFilesRecursive,
  pathExists,
  readJsonlRecords,
  statSafe,
} from "../../src/import/conversations/adapters/common";
import type { ExternalConversation } from "../../src/import/conversations/types";

const conversation = (sourceId: string, title = sourceId): ExternalConversation => ({
  source: "codex",
  sourceId,
  sourcePath: null,
  fingerprint: sourceId,
  cwd: null,
  title,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  originalProvider: null,
  originalModel: null,
  items: [],
  summary: null,
  warnings: [],
});

const preferKeep = (item: ExternalConversation) => item.sourceId.startsWith("keep");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-adapters-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("collectConversationPreviews", () => {
  test("prefers matching conversations, caps fallback slots, and floors invalid limits to 1", async () => {
    const preferredOnly = await collectConversationPreviews(
      ["keep-a", "skip-1", "keep-b", "skip-2", "skip-3", null, "keep-c"],
      async (id) => (id ? conversation(id) : null),
      { limit: 3, preferConversation: preferKeep },
    );
    expect(preferredOnly.map((item) => item.sourceId)).toEqual(["keep-a", "keep-b", "keep-c"]);

    const parsed: string[] = [];
    const floored = await collectConversationPreviews(
      ["keep-a", "skip-1", "keep-b", "keep-c"],
      (id) => {
        parsed.push(id);
        return conversation(id);
      },
      { limit: 0.4, preferConversation: preferKeep },
    );
    expect(floored.map((item) => item.sourceId)).toEqual(["keep-a"]);
    expect(parsed).toEqual(["keep-a"]);

    const withFallback = await collectConversationPreviews(
      ["skip-1", "keep-a", "skip-2", "skip-3"],
      (id) => conversation(id),
      { limit: 3, preferConversation: preferKeep },
    );
    expect(withFallback.map((item) => item.sourceId)).toEqual(["keep-a", "skip-1", "skip-2"]);
  });
});

describe("readJsonlRecords", () => {
  test("skips blanks, keeps objects, and records parse_partial on bad lines or missing files", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "rows.jsonl");
      await fs.writeFile(
        filePath,
        ['{"id":1}', "", "   ", "[1,2]", "not-json", '{"id":2}\r', ""].join("\n"),
        "utf8",
      );
      const warnings: Array<{ code: string; message: string }> = [];
      expect(await readJsonlRecords(filePath, warnings)).toEqual([{ id: 1 }, { id: 2 }]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe("parse_partial");
      expect(warnings[0]?.message).toContain("rows.jsonl line 5");

      const missingWarnings: Array<{ code: string; message: string }> = [];
      const missing = path.join(dir, "missing.jsonl");
      expect(await readJsonlRecords(missing, missingWarnings)).toEqual([]);
      expect(missingWarnings).toHaveLength(1);
      expect(missingWarnings[0]?.code).toBe("parse_partial");
      expect(missingWarnings[0]?.message).toContain(missing);
    });
  });
});

describe("import adapter helpers", () => {
  test("pathExists, statSafe, and listFilesRecursive fail closed on missing trees", async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, "nested");
      await fs.mkdir(nested);
      const keep = path.join(nested, "keep.jsonl");
      await fs.writeFile(keep, "{}\n", "utf8");
      await fs.writeFile(path.join(nested, "skip.txt"), "nope", "utf8");

      expect(await pathExists(keep)).toBe(true);
      expect(await pathExists(path.join(dir, "absent"))).toBe(false);
      expect((await statSafe(keep))?.isFile()).toBe(true);
      expect(await statSafe(path.join(dir, "absent"))).toBeNull();
      expect(await listFilesRecursive(path.join(dir, "missing-root"), () => true)).toEqual([]);
      expect(await listFilesRecursive(dir, (filePath) => filePath.endsWith(".jsonl"))).toEqual([
        keep,
      ]);
    });
  });

  test("asRecord, asString, and asNumber reject empty or non-finite values", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeNull();
    expect(asRecord("x")).toBeNull();
    expect(asString("  keep  ")).toBe("  keep  ");
    expect(asString("   ")).toBeNull();
    expect(asNumber(0)).toBe(0);
    expect(asNumber(Number.NaN)).toBeNull();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
