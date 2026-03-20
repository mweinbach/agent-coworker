import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSkillInstallPreview, materializeSkillSource, resolveSkillSource } from "../src/skills/sourceResolver";
import type { SkillCatalogSnapshot } from "../src/types";

async function makeTmpDir(prefix = "skills-source-resolver-test-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function skillDoc(name: string, description: string): string {
  return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", "# Instructions"].join("\n");
}

const emptyCatalog: SkillCatalogSnapshot = {
  scopes: [],
  effectiveSkills: [],
  installations: [],
};

describe("resolveSkillSource", () => {
  test("parses skills.sh URLs", () => {
    const resolved = resolveSkillSource("https://skills.sh/openai/skills/imagegen");
    expect(resolved.kind).toBe("skills.sh");
    expect(resolved.repo).toBe("openai/skills");
    expect(resolved.requestedSkillName).toBe("imagegen");
  });

  test("parses GitHub shorthand and blob URLs", () => {
    const shorthand = resolveSkillSource("openai/skills");
    expect(shorthand.kind).toBe("github_shorthand");
    expect(shorthand.repo).toBe("openai/skills");

    const blob = resolveSkillSource("https://github.com/openai/skills/blob/main/skills/commit/SKILL.md");
    expect(blob.kind).toBe("github_blob");
    expect(blob.repo).toBe("openai/skills");
    expect(blob.ref).toBe("main");
    expect(blob.subdir).toBe("skills/commit");
  });
});

describe("local source materialization and preview", () => {
  test("materializes a local skill directory and previews install impact", async () => {
    const root = await makeTmpDir();
    const localSkills = path.join(root, "local-skill-set");
    await fs.mkdir(path.join(localSkills, "alpha"), { recursive: true });
    await fs.writeFile(path.join(localSkills, "alpha", "SKILL.md"), skillDoc("alpha", "Alpha skill."), "utf-8");

    const materialized = await materializeSkillSource({ input: localSkills, cwd: root });
    try {
      expect(materialized.descriptor.kind).toBe("local_path");
      expect(materialized.candidates).toHaveLength(1);
      expect(materialized.candidates[0]?.name).toBe("alpha");
    } finally {
      await materialized.cleanup();
    }

    const preview = await buildSkillInstallPreview({
      input: localSkills,
      targetScope: "project",
      catalog: emptyCatalog,
      cwd: root,
    });
    expect(preview.targetScope).toBe("project");
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.name).toBe("alpha");
    expect(preview.candidates[0]?.wouldBeEffective).toBe(true);
  });
});
