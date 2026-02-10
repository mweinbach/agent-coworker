import { describe, expect, test, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverSkills } from "../src/skills/index";

async function makeTmpDir(prefix = "skills-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkill(parentDir: string, name: string, content: string): Promise<string> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
  return skillDir;
}

// ---------------------------------------------------------------------------
// extractTriggers -- tested indirectly via discoverSkills (not exported)
// ---------------------------------------------------------------------------
describe("extractTriggers (via discoverSkills)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTmpDir();
  });

  test("extracts TRIGGER: (singular) line from content", async () => {
    await createSkill(tmp, "myskill", "# My Skill\nTRIGGER: alpha\n\nSome body.");
    const entries = await discoverSkills([tmp]);
    expect(entries).toHaveLength(1);
    expect(entries[0].triggers).toEqual(["alpha"]);
  });

  test("extracts TRIGGERS: (plural) line from content", async () => {
    await createSkill(tmp, "myskill", "# My Skill\nTRIGGERS: one, two, three\n\nBody.");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["one", "two", "three"]);
  });

  test("trigger keyword is case-insensitive (lowercase)", async () => {
    await createSkill(tmp, "lower", "# Lower\ntriggers: a, b\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["a", "b"]);
  });

  test("trigger keyword is case-insensitive (mixed case)", async () => {
    await createSkill(tmp, "mixed", "# Mixed\nTrIgGeRs: x, y\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["x", "y"]);
  });

  test("comma-separated triggers are split and trimmed", async () => {
    await createSkill(tmp, "trim", "# Trim\nTRIGGERS:  foo ,  bar  , baz  \n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["foo", "bar", "baz"]);
  });

  test("filters empty triggers from trailing commas", async () => {
    await createSkill(tmp, "empty", "# Empty\nTRIGGERS: a, , b, ,\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["a", "b"]);
  });

  test("filters empty triggers from leading comma", async () => {
    await createSkill(tmp, "leading", "# Leading\nTRIGGERS: , x\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["x"]);
  });

  test("returns defaults for known name xlsx when no TRIGGERS line", async () => {
    await createSkill(tmp, "xlsx", "# Excel Skill\n\nNo triggers line here.");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"]);
  });

  test("returns defaults for known name pptx when no TRIGGERS line", async () => {
    await createSkill(tmp, "pptx", "# Slides Skill\n\nSome description.");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"]);
  });

  test("returns defaults for known name pdf when no TRIGGERS line", async () => {
    await createSkill(tmp, "pdf", "# PDF Skill\n\nSome description.");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["pdf", ".pdf", "form", "merge", "split"]);
  });

  test("returns defaults for known name docx when no TRIGGERS line", async () => {
    await createSkill(tmp, "docx", "# Word Skill\n\nSome description.");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["document", "word", ".docx", "report", "letter", "memo"]);
  });

  test("returns [name] as default for unknown skill names with no TRIGGERS line", async () => {
    await createSkill(tmp, "custom-thing", "# Custom Thing\n\nNo triggers.");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["custom-thing"]);
  });

  test("custom triggers override defaults even for known names", async () => {
    await createSkill(tmp, "pdf", "# PDF Custom\nTRIGGERS: my-trigger, another\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["my-trigger", "another"]);
  });

  test("TRIGGER line with single value and no comma", async () => {
    await createSkill(tmp, "single", "# Single\nTRIGGER: only-one\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["only-one"]);
  });

  test("TRIGGERS line that appears later in the file is still found", async () => {
    await createSkill(tmp, "later", "# Later\n\nSome text.\n\nMore text.\nTRIGGERS: late-trigger\n\nEnd.");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["late-trigger"]);
  });

  test("first TRIGGERS line wins if multiple are present", async () => {
    await createSkill(tmp, "multi", "# Multi\nTRIGGERS: first, winner\nTRIGGERS: second, loser\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toEqual(["first", "winner"]);
  });
});

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------
describe("discoverSkills", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTmpDir();
  });

  test("discovers skills from directory with SKILL.md files", async () => {
    await createSkill(tmp, "alpha", "# Alpha Skill\nTRIGGERS: a\n");
    await createSkill(tmp, "beta", "# Beta Skill\nTRIGGERS: b\n");
    const entries = await discoverSkills([tmp]);
    expect(entries).toHaveLength(2);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("returns empty array for empty directories", async () => {
    const entries = await discoverSkills([tmp]);
    expect(entries).toEqual([]);
  });

  test("returns empty array for empty skillsDirs list", async () => {
    const entries = await discoverSkills([]);
    expect(entries).toEqual([]);
  });

  test("handles non-existent directories gracefully", async () => {
    const entries = await discoverSkills(["/tmp/this-dir-does-not-exist-99999"]);
    expect(entries).toEqual([]);
  });

  test("handles multiple non-existent directories", async () => {
    const entries = await discoverSkills(["/tmp/nope-aaa", "/tmp/nope-bbb", "/tmp/nope-ccc"]);
    expect(entries).toEqual([]);
  });

  test("extracts description from # header", async () => {
    await createSkill(tmp, "desc", "# My Cool Description\nTRIGGERS: d\n\nBody text.");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].description).toBe("My Cool Description");
  });

  test("extracts description from ## header", async () => {
    await createSkill(tmp, "desc2", "## Sub Header Skill\nTRIGGERS: s\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].description).toBe("Sub Header Skill");
  });

  test("uses skill name as description when no heading/frontmatter description exists", async () => {
    await createSkill(tmp, "noheader", "No header line here.\nTRIGGERS: n\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].description).toBe("noheader");
  });

  test("assigns project source to first directory", async () => {
    const dir1 = await makeTmpDir("project-");
    await createSkill(dir1, "proj-skill", "# Proj\nTRIGGERS: p\n");
    const entries = await discoverSkills([dir1]);
    expect(entries[0].source).toBe("project");
  });

  test("assigns user source to second directory", async () => {
    const dir1 = await makeTmpDir("project-");
    const dir2 = await makeTmpDir("user-");
    await createSkill(dir2, "user-skill", "# User\nTRIGGERS: u\n");
    const entries = await discoverSkills([dir1, dir2]);
    const userEntry = entries.find((e) => e.name === "user-skill");
    expect(userEntry).toBeDefined();
    expect(userEntry!.source).toBe("user");
  });

  test("assigns built-in source to third directory", async () => {
    const dir1 = await makeTmpDir("project-");
    const dir2 = await makeTmpDir("user-");
    const dir3 = await makeTmpDir("builtin-");
    await createSkill(dir3, "bi-skill", "# BuiltIn\nTRIGGERS: bi\n");
    const entries = await discoverSkills([dir1, dir2, dir3]);
    const biEntry = entries.find((e) => e.name === "bi-skill");
    expect(biEntry).toBeDefined();
    expect(biEntry!.source).toBe("built-in");
  });

  test("assigns built-in source to fourth+ directory", async () => {
    const dirs = await Promise.all([makeTmpDir("a-"), makeTmpDir("b-"), makeTmpDir("c-"), makeTmpDir("d-")]);
    await createSkill(dirs[3], "extra", "# Extra\nTRIGGERS: e\n");
    const entries = await discoverSkills(dirs);
    const extra = entries.find((e) => e.name === "extra");
    expect(extra).toBeDefined();
    expect(extra!.source).toBe("built-in");
  });

  test("deduplicates by name -- first wins", async () => {
    const dir1 = await makeTmpDir("first-");
    const dir2 = await makeTmpDir("second-");
    await createSkill(dir1, "dupe", "# First Version\nTRIGGERS: first\n");
    await createSkill(dir2, "dupe", "# Second Version\nTRIGGERS: second\n");
    const entries = await discoverSkills([dir1, dir2]);
    const dupes = entries.filter((e) => e.name === "dupe");
    expect(dupes).toHaveLength(1);
    expect(dupes[0].description).toBe("First Version");
    expect(dupes[0].triggers).toEqual(["first"]);
    expect(dupes[0].source).toBe("project");
  });

  test("includes triggers array in each entry", async () => {
    await createSkill(tmp, "triggered", "# Triggered\nTRIGGERS: t1, t2, t3\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].triggers).toBeDefined();
    expect(Array.isArray(entries[0].triggers)).toBe(true);
    expect(entries[0].triggers).toEqual(["t1", "t2", "t3"]);
  });

  test("skips directories without SKILL.md", async () => {
    const noSkillDir = path.join(tmp, "no-skill");
    await fs.mkdir(noSkillDir, { recursive: true });
    await fs.writeFile(path.join(noSkillDir, "README.md"), "# Not a skill\n", "utf-8");
    await createSkill(tmp, "real-skill", "# Real\nTRIGGERS: r\n");
    const entries = await discoverSkills([tmp]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("real-skill");
  });

  test("skips plain files at the top level of skills directory", async () => {
    await fs.writeFile(path.join(tmp, "not-a-dir.md"), "# nope\n", "utf-8");
    await createSkill(tmp, "valid", "# Valid\nTRIGGERS: v\n");
    const entries = await discoverSkills([tmp]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("valid");
  });

  test("each entry has correct path to SKILL.md", async () => {
    await createSkill(tmp, "pathtest", "# PathTest\nTRIGGERS: pt\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].path).toBe(path.join(tmp, "pathtest", "SKILL.md"));
  });

  test("each entry has name matching its directory name", async () => {
    await createSkill(tmp, "my-dir-name", "# Different Title\nTRIGGERS: mdn\n");
    const entries = await discoverSkills([tmp]);
    expect(entries[0].name).toBe("my-dir-name");
  });

  test("discovers skills from the real built-in skills directory", async () => {
    const builtInSkills = path.resolve(__dirname, "..", "skills");
    const entries = await discoverSkills([builtInSkills]);
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("pdf");
    expect(names).toContain("doc");
    expect(names).toContain("spreadsheet");
    expect(names).toContain("slides");
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  test("mixed existing and non-existing directories", async () => {
    await createSkill(tmp, "exists", "# Exists\nTRIGGERS: e\n");
    const entries = await discoverSkills(["/tmp/nope-does-not-exist-8888", tmp]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("exists");
    expect(entries[0].source).toBe("user");
  });

  test("empty SKILL.md uses directory name as description and [name] as trigger", async () => {
    await createSkill(tmp, "emptycontent", "");
    const entries = await discoverSkills([tmp]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("emptycontent");
    expect(entries[0].description).toBe("emptycontent");
    expect(entries[0].triggers).toEqual(["emptycontent"]);
  });
});
