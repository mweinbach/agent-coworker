import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AdvancedMemoryStore } from "../src/advancedMemory/store";
import type { ToolContext } from "../src/tools/context";
import { createRecallMemoryTool } from "../src/tools/recallMemory";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "adv-mem-recall-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  return {
    config: {
      memoriesDir: tmpDir,
      workingDirectory: "/tmp/proj",
      projectCoworkDir: "/tmp/proj/.cowork",
    },
    log: () => {},
  } as unknown as ToolContext;
}

describe("recallMemory", () => {
  test("recalls by slug", async () => {
    const store = new AdvancedMemoryStore(tmpDir);
    await store.writeMemory("proj", {
      name: "cs-report skill",
      description: "d",
      body: "the body",
    });
    const tool = createRecallMemoryTool(makeCtx());
    const out = (await tool.execute({ name: "cs-report-skill" })) as string;
    expect(out).toContain("the body");
  });

  test("falls back to the display name when the slug diverges after a rename", async () => {
    const store = new AdvancedMemoryStore(tmpDir);
    // Create with one name, then rename (keeping the original slug stable).
    await store.writeMemory("proj", {
      slug: "cs-report-skill",
      name: "Original",
      description: "d",
      body: "b1",
    });
    await store.editMemory("proj", "cs-report-skill", { name: "Renamed Title", body: "b2" });

    const tool = createRecallMemoryTool(makeCtx());
    // The Memory Index would show "Renamed Title"; recalling by that name must hit.
    const out = (await tool.execute({ name: "Renamed Title" })) as string;
    expect(out).toContain("b2");
    expect(out).toContain("Renamed Title");
  });

  test("reports when nothing matches", async () => {
    const tool = createRecallMemoryTool(makeCtx());
    const out = (await tool.execute({ name: "does-not-exist" })) as string;
    expect(out).toContain("No memory named");
  });
});
