import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverSkills, stripSkillFrontMatter } from "../src/skills/index";

async function makeTmpDir(prefix = "skills-test-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function skillDoc(name: string, description: string, body = "# Body\n"): string {
  return ["---", `name: \"${name}\"`, `description: \"${description}\"`, "---", "", body].join("\n");
}

async function createSkill(parentDir: string, name: string, content: string): Promise<string> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
  return skillDir;
}

describe("discoverSkills (Agent Skills spec compliance)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTmpDir();
  });

  test("discovers skills with valid required frontmatter", async () => {
    await createSkill(tmp, "alpha", skillDoc("alpha", "Alpha description."));
    const entries = await discoverSkills([tmp]);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("alpha");
    expect(entries[0].description).toBe("Alpha description.");
    expect(entries[0].path).toBe(path.join(tmp, "alpha", "SKILL.md"));
  });

  test("rejects skill without frontmatter", async () => {
    await createSkill(tmp, "alpha", "# No frontmatter\n");
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects malformed frontmatter YAML", async () => {
    await createSkill(
      tmp,
      "alpha",
      ["---", "name: \"alpha\"", "description: [unterminated", "---", "", "# Body"].join("\n")
    );
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects when required name is missing", async () => {
    await createSkill(tmp, "alpha", ["---", "description: \"Only description\"", "---", "", "# Body"].join("\n"));
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects when required description is missing", async () => {
    await createSkill(tmp, "alpha", ["---", "name: \"alpha\"", "---", "", "# Body"].join("\n"));
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects when frontmatter name does not match directory", async () => {
    await createSkill(tmp, "alpha", skillDoc("different", "Alpha description."));
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects uppercase names", async () => {
    await createSkill(tmp, "alpha", skillDoc("Alpha", "Alpha description."));
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects names with consecutive hyphens", async () => {
    await createSkill(tmp, "alpha", skillDoc("a--b", "Alpha description."));
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects names that exceed 64 characters", async () => {
    const tooLong = "a".repeat(65);
    await createSkill(tmp, "alpha", skillDoc(tooLong, "Alpha description."));
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects empty descriptions", async () => {
    await createSkill(tmp, "alpha", skillDoc("alpha", "   "));
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects descriptions that exceed 1024 characters", async () => {
    const longDesc = "a".repeat(1025);
    await createSkill(tmp, "alpha", skillDoc("alpha", longDesc));
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("accepts optional spec fields when valid", async () => {
    await createSkill(
      tmp,
      "alpha",
      [
        "---",
        'name: "alpha"',
        'description: "Alpha description."',
        'license: "Apache-2.0"',
        'compatibility: "Requires git and network"',
        "metadata:",
        '  author: "example-org"',
        '  version: "1.0"',
        '  triggers: "alpha, beta"',
        'allowed-tools: "Bash(git:*) Read"',
        "---",
        "",
        "# Body",
      ].join("\n")
    );

    const entries = await discoverSkills([tmp]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("alpha");
    expect(entries[0].triggers).toEqual(["alpha", "beta"]);
  });

  test("rejects compatibility longer than 500 characters", async () => {
    const longCompat = "a".repeat(501);
    await createSkill(
      tmp,
      "alpha",
      [
        "---",
        'name: "alpha"',
        'description: "Alpha description."',
        `compatibility: "${longCompat}"`,
        "---",
        "",
        "# Body",
      ].join("\n")
    );

    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("rejects metadata values that are not strings", async () => {
    await createSkill(
      tmp,
      "alpha",
      [
        "---",
        'name: "alpha"',
        'description: "Alpha description."',
        "metadata:",
        "  count: 123",
        "---",
        "",
        "# Body",
      ].join("\n")
    );

    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("uses frontmatter triggers field when provided", async () => {
    await createSkill(
      tmp,
      "alpha",
      ["---", 'name: "alpha"', 'description: "Alpha description."', 'triggers: "one, two"', "---", "", "# Body"].join(
        "\n"
      )
    );

    const entries = await discoverSkills([tmp]);
    expect(entries).toHaveLength(1);
    expect(entries[0].triggers).toEqual(["one", "two"]);
  });

  test("falls back to default triggers by canonical name", async () => {
    await createSkill(tmp, "xlsx", skillDoc("xlsx", "Spreadsheet authoring skill."));
    const entries = await discoverSkills([tmp]);

    expect(entries).toHaveLength(1);
    expect(entries[0].triggers).toContain("spreadsheet");
    expect(entries[0].triggers).toContain("excel");
  });

  test("deduplicates by canonical name and keeps first match by directory order", async () => {
    const dir1 = await makeTmpDir("skills-order-1-");
    const dir2 = await makeTmpDir("skills-order-2-");

    await createSkill(dir1, "alpha", skillDoc("alpha", "First description."));
    await createSkill(dir2, "alpha", skillDoc("alpha", "Second description."));

    const entries = await discoverSkills([dir1, dir2]);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe("First description.");
    expect(entries[0].source).toBe("project");
  });

  test("assigns source by configured directory order", async () => {
    const project = await makeTmpDir("skills-project-");
    const global = await makeTmpDir("skills-global-");
    const user = await makeTmpDir("skills-user-");
    const builtIn = await makeTmpDir("skills-built-in-");

    await createSkill(project, "project-skill", skillDoc("project-skill", "Project skill."));
    await createSkill(global, "global-skill", skillDoc("global-skill", "Global skill."));
    await createSkill(user, "user-skill", skillDoc("user-skill", "User skill."));
    await createSkill(builtIn, "built-in-skill", skillDoc("built-in-skill", "Built-in skill."));

    const entries = await discoverSkills([project, global, user, builtIn]);

    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["project-skill"].source).toBe("project");
    expect(byName["global-skill"].source).toBe("global");
    expect(byName["user-skill"].source).toBe("user");
    expect(byName["built-in-skill"].source).toBe("built-in");
  });

  test("returns empty for empty or missing skill directories", async () => {
    expect(await discoverSkills([])).toEqual([]);
    expect(await discoverSkills(["/tmp/this-dir-does-not-exist-99999"])).toEqual([]);
  });
});

describe("stripSkillFrontMatter", () => {
  test("returns instructions body without YAML frontmatter", () => {
    const raw = ["---", 'name: "alpha"', 'description: "Alpha description."', "---", "", "# Instructions", "Use this."].join(
      "\n"
    );
    const stripped = stripSkillFrontMatter(raw);
    expect(stripped).toBe("# Instructions\nUse this.");
  });

  test("returns original content when frontmatter is absent", () => {
    const raw = "# Instructions\nUse this.";
    expect(stripSkillFrontMatter(raw)).toBe(raw);
  });
});
