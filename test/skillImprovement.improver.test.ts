import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillImprover } from "../src/skillImprovement";
import { __internalSkillImprover } from "../src/skillImprovement/SkillImprover";
import type { SkillImproverRunInput } from "../src/skillImprovement/types";
import type { AgentConfig } from "../src/types";
import { makeConfig } from "./session/agentSession.harness";

const { resolveInsideRoot } = __internalSkillImprover;

type ToolMap = Record<string, { execute: (args: never) => unknown }>;

function skillDoc(name: string): string {
  return ["---", `name: "${name}"`, 'description: "Test skill."', "---", "", "# Body"].join("\n");
}

async function makeSkillDir(): Promise<{ root: string; skillRoot: string; skillPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-skill-improver-"));
  const skillRoot = path.join(root, "alpha");
  await fs.mkdir(skillRoot, { recursive: true });
  const skillPath = path.join(skillRoot, "SKILL.md");
  await fs.writeFile(skillPath, skillDoc("alpha"), "utf-8");
  return { root, skillRoot, skillPath };
}

function runInput(skillRoot: string, skillPath: string): SkillImproverRunInput {
  return {
    skillName: "alpha",
    skillRootDir: skillRoot,
    skillPath,
    sourceKind: "user",
    usageEvents: [],
    transcripts: [],
    allSkills: [],
  };
}

/** Build an improver whose "model turn" is a scripted function over the tools. */
function makeScriptedImprover(script: (tools: ToolMap) => Promise<void>): {
  improver: SkillImprover;
  config: AgentConfig;
} {
  const config = { ...makeConfig(os.tmpdir()) };
  const improver = new SkillImprover({
    createRuntime: (() => ({
      runTurn: async (opts: { tools: ToolMap }) => {
        await script(opts.tools);
      },
    })) as never,
    loadPrompt: async () => "test prompt",
  });
  return { improver, config };
}

describe("SkillImprover sandbox", () => {
  test("rejects absolute paths outside the skill directory", async () => {
    const { skillRoot } = await makeSkillDir();
    await expect(resolveInsideRoot(skillRoot, "/etc/passwd")).rejects.toThrow(/escapes/);
  });

  test("neutralizes leading traversal segments", async () => {
    const { skillRoot } = await makeSkillDir();
    const resolved = await resolveInsideRoot(skillRoot, "../../outside.txt");
    expect(resolved).toBe(path.join(skillRoot, "outside.txt"));
  });

  test("rejects paths that pass through a symlink escaping the skill directory", async () => {
    const { root, skillRoot } = await makeSkillDir();
    const outsideDir = path.join(root, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(skillRoot, "sneaky"));
    await expect(resolveInsideRoot(skillRoot, "sneaky/file.txt")).rejects.toThrow(/escapes/);
  });

  test("rejects a symlinked file pointing outside the skill directory", async () => {
    const { root, skillRoot } = await makeSkillDir();
    const outsideFile = path.join(root, "outside.txt");
    await fs.writeFile(outsideFile, "secret", "utf-8");
    await fs.symlink(outsideFile, path.join(skillRoot, "evil.txt"));
    await expect(resolveInsideRoot(skillRoot, "evil.txt")).rejects.toThrow(/escapes/);
  });
});

describe("SkillImprover runs", () => {
  test("reports changed=true when only a reference file is edited", async () => {
    const { skillRoot, skillPath } = await makeSkillDir();
    const { improver, config } = makeScriptedImprover(async (tools) => {
      await tools.write_file.execute({
        path: "references/notes.md",
        content: "New reference notes.",
      } as never);
      await tools.finish.execute({ summary: "added reference notes" } as never);
    });

    const result = await improver.run({ config, input: runInput(skillRoot, skillPath) });

    expect(result).toMatchObject({ ok: true, changed: true, message: "added reference notes" });
    expect(await fs.readFile(path.join(skillRoot, "references", "notes.md"), "utf-8")).toBe(
      "New reference notes.",
    );
    // SKILL.md itself is untouched — the dirty flag, not a SKILL.md diff,
    // must drive the changed signal.
    expect(await fs.readFile(skillPath, "utf-8")).toBe(skillDoc("alpha"));
  });

  test("reports changed=false when the model makes no edits", async () => {
    const { skillRoot, skillPath } = await makeSkillDir();
    const { improver, config } = makeScriptedImprover(async (tools) => {
      await tools.read_file.execute({ path: "SKILL.md" } as never);
    });

    const result = await improver.run({ config, input: runInput(skillRoot, skillPath) });
    expect(result).toMatchObject({ ok: true, changed: false, message: "No changes needed." });
  });

  test("fails when the run renames the skill in frontmatter", async () => {
    const { skillRoot, skillPath } = await makeSkillDir();
    const { improver, config } = makeScriptedImprover(async (tools) => {
      await tools.write_file.execute({ path: "SKILL.md", content: skillDoc("renamed") } as never);
    });

    const result = await improver.run({ config, input: runInput(skillRoot, skillPath) });
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.message).toContain("invalid frontmatter");
  });

  test("rejects oversized writes before touching disk", async () => {
    const { skillRoot, skillPath } = await makeSkillDir();
    let writeError: Error | null = null;
    const { improver, config } = makeScriptedImprover(async (tools) => {
      try {
        await tools.write_file.execute({
          path: "references/huge.md",
          content: "x".repeat(97 * 1024),
        } as never);
      } catch (error) {
        writeError = error as Error;
      }
    });

    const result = await improver.run({ config, input: runInput(skillRoot, skillPath) });
    expect(String(writeError)).toContain("too large");
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(await fs.exists(path.join(skillRoot, "references", "huge.md"))).toBe(false);
  });

  test("returns a failed result instead of throwing when the runtime crashes", async () => {
    const { skillRoot, skillPath } = await makeSkillDir();
    const config = { ...makeConfig(os.tmpdir()) };
    const improver = new SkillImprover({
      createRuntime: (() => ({
        runTurn: async () => {
          throw new Error("provider unreachable");
        },
      })) as never,
      loadPrompt: async () => "test prompt",
    });

    const result = await improver.run({ config, input: runInput(skillRoot, skillPath) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("provider unreachable");
  });
});
