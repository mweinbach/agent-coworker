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

function conversation(sourceId: string, title = sourceId): ExternalConversation {
  return {
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
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-adapters-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("collectConversationPreviews", () => {
  test("prefers matching conversations and caps fallback to the remaining slots", async () => {
    const previews = await collectConversationPreviews(
      ["keep-a", "skip-1", "keep-b", "skip-2", "skip-3", null, "keep-c"],
      async (id) => (id ? conversation(id) : null),
      {
        limit: 3,
        preferConversation: (item) => item.sourceId.startsWith("keep"),
      },
    );

    expect(previews.map((item) => item.sourceId)).toEqual(["keep-a", "keep-b", "keep-c"]);
  });

  test("stops once preferred hits the limit and floors invalid limits to 1", async () => {
    const parsed: string[] = [];
    const previews = await collectConversationPreviews(
      ["keep-a", "skip-1", "keep-b", "keep-c"],
      (id) => {
        parsed.push(id);
        return conversation(id);
      },
      {
        limit: 0.4,
        preferConversation: (item) => item.sourceId.startsWith("keep"),
      },
    );

    expect(previews.map((item) => item.sourceId)).toEqual(["keep-a"]);
    expect(parsed).toEqual(["keep-a"]);
  });

  test("fills leftover slots with non-preferred conversations", async () => {
    const previews = await collectConversationPreviews(
      ["skip-1", "keep-a", "skip-2", "skip-3"],
      (id) => conversation(id),
      {
        limit: 3,
        preferConversation: (item) => item.sourceId.startsWith("keep"),
      },
    );

    expect(previews.map((item) => item.sourceId)).toEqual(["keep-a", "skip-1", "skip-2"]);
  });
});

describe("readJsonlRecords", () => {
  test("skips blanks, keeps objects, and records parse_partial without aborting", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "rows.jsonl");
      await fs.writeFile(
        filePath,
        ['{"id":1}', "", "   ", "[1,2]", "not-json", '{"id":2}\r', ""].join("\n"),
        "utf8",
      );
      const warnings: Array<{ code: string; message: string }> = [];
      const records = await readJsonlRecords(filePath, warnings);

      expect(records).toEqual([{ id: 1 }, { id: 2 }]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe("parse_partial");
      expect(warnings[0]?.message).toContain("rows.jsonl line 5");
    });
  });

  test("missing files become parse_partial warnings and an empty record list", async () => {
    await withTempDir(async (dir) => {
      const warnings: Array<{ code: string; message: string }> = [];
      const missing = path.join(dir, "missing.jsonl");
      const records = await readJsonlRecords(missing, warnings);
      expect(records).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe("parse_partial");
      expect(warnings[0]?.message).toContain(missing);
    });
  });
});

describe("import adapter helpers", () => {
  test("pathExists, statSafe, and listFilesRecursive fail closed on missing trees", async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, "nested");
      await fs.mkdir(nested);
      const keep = path.join(nested, "keep.jsonl");
      const skip = path.join(nested, "skip.txt");
      await fs.writeFile(keep, "{}\n", "utf8");
      await fs.writeFile(skip, "nope", "utf8");

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
