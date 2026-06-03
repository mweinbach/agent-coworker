import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AdvancedMemoryStore,
  CHATS_FOLDER,
  MEMORY_INDEX_HEADING,
  resolveMemoryFolderName,
} from "../src/advancedMemory/store";
import type { AgentConfig } from "../src/types";

let tmpDir: string;
let store: AdvancedMemoryStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "adv-mem-"));
  store = new AdvancedMemoryStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("AdvancedMemoryStore", () => {
  test("write → index regen → read round-trips frontmatter", async () => {
    const entry = await store.writeMemory("proj", {
      name: "cs-report skill",
      description: "editorial report skill",
      type: "project",
      originSessionId: "sess-1",
      body: "Built a skill named cs-report.",
    });
    expect(entry.slug).toBe("cs-report-skill");

    const read = await store.readMemory("proj", "cs-report-skill");
    expect(read).not.toBeNull();
    expect(read?.name).toBe("cs-report skill");
    expect(read?.description).toBe("editorial report skill");
    expect(read?.type).toBe("project");
    expect(read?.originSessionId).toBe("sess-1");
    expect(read?.body).toBe("Built a skill named cs-report.");

    const indexRaw = await fs.readFile(path.join(tmpDir, "proj", "MEMORY.md"), "utf-8");
    expect(indexRaw.startsWith(MEMORY_INDEX_HEADING)).toBe(true);
    expect(indexRaw).toContain("[cs-report skill](cs-report-skill.md)");
    expect(indexRaw).toContain("editorial report skill");
  });

  test("edit updates an existing memory and preserves untouched fields", async () => {
    await store.writeMemory("proj", {
      name: "rule",
      description: "first",
      type: "feedback",
      originSessionId: "sess-orig",
      body: "original",
    });
    const edited = await store.editMemory("proj", "rule", { body: "updated body" });
    expect(edited?.body).toBe("updated body");
    expect(edited?.description).toBe("first");
    expect(edited?.type).toBe("feedback");
    // originSessionId must survive an edit that doesn't supply one.
    expect(edited?.originSessionId).toBe("sess-orig");
  });

  test("delete removes the file and regenerates the index", async () => {
    await store.writeMemory("proj", { name: "a", description: "da", body: "ba" });
    await store.writeMemory("proj", { name: "b", description: "db", body: "bb" });
    expect(await store.deleteMemory("proj", "a")).toBe(true);
    const remaining = await store.listMemories("proj");
    expect(remaining.map((m) => m.slug)).toEqual(["b"]);
    const indexRaw = await fs.readFile(path.join(tmpDir, "proj", "MEMORY.md"), "utf-8");
    expect(indexRaw).not.toContain("(a.md)");
    expect(indexRaw).toContain("(b.md)");
  });

  test("renderPromptSection surfaces active and chats indexes", async () => {
    await store.writeMemory("proj", { name: "p1", description: "proj memory", body: "x" });
    await store.writeMemory(CHATS_FOLDER, { name: "c1", description: "chat memory", body: "y" });
    const section = await store.renderPromptSection("proj");
    expect(section).toContain("## Memory");
    expect(section).toContain("recallMemory");
    expect(section).toContain("proj memory");
    expect(section).toContain("chat memory");
  });

  test("renderPromptSection is empty when no memories exist", async () => {
    expect(await store.renderPromptSection("proj")).toBe("");
  });
});

describe("resolveMemoryFolderName", () => {
  test("returns (chats) for one-off chat sessions", () => {
    const home = os.homedir();
    const config = {
      workingDirectory: path.join(home, ".cowork", "chats", "20260101-x-abc"),
      projectCoworkDir: path.join(home, ".cowork", "chats", "20260101-x-abc", ".cowork"),
    } as AgentConfig;
    expect(resolveMemoryFolderName(config)).toBe(CHATS_FOLDER);
  });

  test("derives a slug from the workspace root for projects", () => {
    const config = {
      workingDirectory: "/home/user/My Project",
      projectCoworkDir: "/home/user/My Project/.cowork",
    } as AgentConfig;
    expect(resolveMemoryFolderName(config)).toBe("my-project");
  });
});
