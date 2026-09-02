import { describe, expect, test } from "bun:test";

import { extractSkillTriggers, parseSkillDocument } from "../src/skills/metadata";

function skillDoc(frontMatter: string[], body = "# Body"): string {
  return ["---", ...frontMatter, "---", "", body].join("\n");
}

describe("skill metadata parser", () => {
  test("parses catalog fields and strips frontmatter from the body", () => {
    const parsed = parseSkillDocument(
      skillDoc([
        "name: alpha",
        "description: Alpha skill.",
        "license: MIT",
        "compatibility: Bun",
        'allowed-tools: "bash, read"',
        "metadata:",
        "  owner: docs",
      ]),
      { expectedName: "alpha", mode: "catalog" },
    );

    expect(parsed?.frontMatter).toEqual({
      name: "alpha",
      description: "Alpha skill.",
      license: "MIT",
      compatibility: "Bun",
      metadata: { owner: "docs" },
      allowedTools: "bash, read",
    });
    expect(parsed?.body).toBe("# Body");
  });

  test("keeps import discovery able to diagnose non-kebab names separately", () => {
    const raw = skillDoc(["name: Alpha Skill", "description: Importable enough to inspect."]);

    expect(parseSkillDocument(raw, { requireKebabName: false })?.frontMatter).toMatchObject({
      name: "Alpha Skill",
      description: "Importable enough to inspect.",
    });
    expect(parseSkillDocument(raw)).toBeNull();
  });

  test("preserves catalog metadata strictness without blocking basic consumers", () => {
    const raw = skillDoc([
      "name: alpha",
      "description: Alpha skill.",
      "metadata:",
      "  triggers:",
      "    - alpha",
    ]);

    expect(parseSkillDocument(raw, { mode: "catalog" })).toBeNull();
    expect(parseSkillDocument(raw)?.frontMatter.name).toBe("alpha");
  });

  test("extracts direct and metadata triggers with caller-specific defaults", () => {
    expect(extractSkillTriggers("alpha", { triggers: "a, b" })).toEqual(["a", "b"]);
    expect(extractSkillTriggers("alpha", { metadata: { triggers: ["m", "n"] } })).toEqual([
      "m",
      "n",
    ]);
    expect(
      extractSkillTriggers("xlsx", undefined, { defaults: { xlsx: ["spreadsheet"] } }),
    ).toEqual(["spreadsheet"]);
  });
});
