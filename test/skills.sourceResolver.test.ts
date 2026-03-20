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

function createGitHubSkillFetch(expectedApiUrl: string) {
  const downloadUrl = "https://downloads.example/commit/SKILL.md";
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requests.push(url);

    if (url === expectedApiUrl) {
      return new Response(JSON.stringify([
        {
          type: "file",
          name: "SKILL.md",
          path: "skills/commit/SKILL.md",
          url: `${expectedApiUrl}/SKILL.md`,
          download_url: downloadUrl,
        },
      ]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === downloadUrl) {
      return new Response(skillDoc("commit", "Commit skill."), { status: 200 });
    }

    return new Response(`Unexpected URL: ${url}`, { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, requests };
}

describe("resolveSkillSource", () => {
  test("parses skills.sh URLs", () => {
    const resolved = resolveSkillSource("https://skills.sh/openai/skills/imagegen");
    expect(resolved.kind).toBe("skills.sh");
    expect(resolved.repo).toBe("openai/skills");
    expect(resolved.requestedSkillName).toBe("imagegen");
  });

  test("parses GitHub shorthand and blob URLs", async () => {
    const cwd = await makeTmpDir();
    try {
      const shorthand = resolveSkillSource("openai/skills", cwd);
      expect(shorthand.kind).toBe("github_shorthand");
      expect(shorthand.repo).toBe("openai/skills");

      const blob = resolveSkillSource("https://github.com/openai/skills/blob/main/skills/commit/SKILL.md");
      expect(blob.kind).toBe("github_blob");
      expect(blob.repo).toBe("openai/skills");
      expect(blob.ref).toBe("main");
      expect(blob.subdir).toBe("skills/commit");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("prefers an existing relative local path over owner/repo shorthand", async () => {
    const root = await makeTmpDir();
    try {
      const relative = path.join("skills", "my-skill");
      const absoluteSkill = path.join(root, relative);
      await fs.mkdir(absoluteSkill, { recursive: true });
      await fs.writeFile(path.join(absoluteSkill, "SKILL.md"), skillDoc("my-skill", "Local skill."), "utf-8");

      const resolved = resolveSkillSource(relative, root);
      expect(resolved.kind).toBe("local_path");
      expect(resolved.localPath).toBe(path.resolve(root, relative));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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

describe("GitHub source materialization", () => {
  test("materializes tree URLs with slash-containing refs", async () => {
    const expectedApiUrl = "https://api.github.com/repos/openai/skills/contents/skills/commit?ref=feature%2Fbranch";
    const { fetchImpl, requests } = createGitHubSkillFetch(expectedApiUrl);

    const preview = await buildSkillInstallPreview({
      input: "https://github.com/openai/skills/tree/feature/branch/skills/commit",
      targetScope: "project",
      catalog: emptyCatalog,
      fetchImpl,
    });

    expect(preview.source.kind).toBe("github_tree");
    expect(preview.source.ref).toBe("feature/branch");
    expect(preview.source.subdir).toBe("skills/commit");
    expect(preview.candidates.map((candidate) => candidate.name)).toEqual(["commit"]);
    expect(requests).toContain(expectedApiUrl);
  });

  test("materializes blob URLs with slash-containing refs", async () => {
    const expectedApiUrl = "https://api.github.com/repos/openai/skills/contents/skills/commit?ref=feature%2Fbranch";
    const { fetchImpl, requests } = createGitHubSkillFetch(expectedApiUrl);

    const preview = await buildSkillInstallPreview({
      input: "https://github.com/openai/skills/blob/feature/branch/skills/commit/SKILL.md",
      targetScope: "project",
      catalog: emptyCatalog,
      fetchImpl,
    });

    expect(preview.source.kind).toBe("github_blob");
    expect(preview.source.ref).toBe("feature/branch");
    expect(preview.source.subdir).toBe("skills/commit");
    expect(preview.candidates.map((candidate) => candidate.name)).toEqual(["commit"]);
    expect(requests).toContain(expectedApiUrl);
  });
});
