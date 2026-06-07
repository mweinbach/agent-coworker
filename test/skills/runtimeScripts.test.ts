import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function expectFile(relativePath: string): Promise<void> {
  const absolutePath = path.join(repoRoot, relativePath);
  const stat = await fs.stat(absolutePath);
  expect(stat.isFile()).toBe(true);
  expect(stat.size).toBeGreaterThan(0);
}

describe("bundled runtime skill scripts", () => {
  test("includes harness-critical presentation render scripts", async () => {
    await expectFile("skills/presentations/scripts/render_artifact_slide.mjs");
    await expectFile("skills/presentations/scripts/build_artifact_deck.mjs");
    await expectFile("skills/presentations/scripts/artifact_tool_utils.mjs");
  });

  test("keeps maintainer battle harness outside production scripts", async () => {
    await expectFile("skills/presentations/dev/run_prompt_battle.mjs");
    await expect(
      fs.stat(path.join(repoRoot, "skills/presentations/scripts/run_prompt_battle.mjs")),
    ).rejects.toThrow();
  });

  test("includes codex-primary-runtime skill entrypoints", async () => {
    await expectFile("skills/documents/SKILL.md");
    await expectFile("skills/memories/SKILL.md");
    await expectFile("skills/presentations/SKILL.md");
    await expectFile("skills/spreadsheets/SKILL.md");
  });
});
