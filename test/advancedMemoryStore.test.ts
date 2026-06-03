import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ADVANCED_MEMORY_CHATS_FOLDER,
  ADVANCED_MEMORY_INDEX_FILENAME,
  ADVANCED_MEMORY_INDEX_HEADING,
  AdvancedMemoryStore,
  advancedMemoryFolderNameForConfig,
} from "../src/advancedMemoryStore";

describe("AdvancedMemoryStore", () => {
  test("creates a folder index and regenerates entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cowork-advanced-memory-"));
    const store = new AdvancedMemoryStore(root, "project");

    const index = await store.readIndex();
    expect(index.indexContent).toBe(`${ADVANCED_MEMORY_INDEX_HEADING}\n`);

    await store.upsert(
      "coding style",
      [
        "---",
        "summary: Prefer explicit types.",
        "---",
        "# Coding Style",
        "",
        "Prefer explicit types at module boundaries.",
      ].join("\n"),
    );

    const regenerated = await store.readIndex();
    expect(regenerated.entries).toHaveLength(1);
    expect(regenerated.entries[0]?.fileName).toBe("coding style.md");
    expect(regenerated.indexContent).toContain("# Memory Index");
    expect(regenerated.indexContent).toContain("coding style.md");
    expect(
      await readFile(path.join(root, "project", ADVANCED_MEMORY_INDEX_FILENAME), "utf-8"),
    ).toBe(regenerated.indexContent);
  });

  test("maps one-off chat workspaces to the shared chats folder", () => {
    const home = "/tmp/cowork-home";
    expect(
      advancedMemoryFolderNameForConfig(
        { workingDirectory: path.join(home, ".cowork", "chats", "chat-1") },
        home,
      ),
    ).toBe(ADVANCED_MEMORY_CHATS_FOLDER);
  });
});
