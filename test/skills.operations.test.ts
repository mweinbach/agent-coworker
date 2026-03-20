import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanSkillCatalog } from "../src/skills/catalog";
import { checkSkillInstallationUpdate, updateSkillInstallation } from "../src/skills/operations";
import type { AgentConfig } from "../src/types";

function skillDoc(name: string, description: string): string {
  return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", "# Body"].join("\n");
}

async function createSkill(parentDir: string, name: string, description: string): Promise<string> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillDoc(name, description), "utf-8");
  return skillDir;
}

function makeConfig(root: string): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5",
    preferredChildModel: "gpt-5",
    workingDirectory: root,
    userName: "Test User",
    knowledgeCutoff: "Unknown",
    projectAgentDir: path.join(root, ".agent"),
    userAgentDir: path.join(root, ".agent-user"),
    builtInDir: path.join(root, "builtin"),
    builtInConfigDir: path.join(root, "builtin-config"),
    skillsDirs: [path.join(root, ".agent", "skills")],
    memoryDirs: [],
    configDirs: [],
  };
}

describe("updateSkillInstallation", () => {
  let root: string;
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-operations-test-"));
    fetchCalls = 0;
    globalThis.fetch = mock(async (input) => {
      fetchCalls += 1;
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://api.github.com/repos/owner/repo/contents/my-skill?ref=main") {
        return new Response(JSON.stringify([
          {
            type: "file",
            name: "SKILL.md",
            path: "my-skill/SKILL.md",
            url: "https://api.github.com/repos/owner/repo/contents/my-skill/SKILL.md?ref=main",
            download_url: "https://raw.githubusercontent.com/owner/repo/main/my-skill/SKILL.md",
          },
        ]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://raw.githubusercontent.com/owner/repo/main/my-skill/SKILL.md") {
        return new Response(skillDoc("my-skill", "Updated skill"), { status: 200 });
      }
      return new Response(`Unexpected URL: ${url}`, { status: 404 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("reuses the materialized source during updates", async () => {
    const config = makeConfig(root);
    const existingSkillDir = await createSkill(config.skillsDirs[0]!, "my-skill", "Existing skill");

    const catalog = await scanSkillCatalog(config.skillsDirs, {
      includeDisabled: true,
      adoptManagedWritableInstalls: true,
    });
    const installation = {
      ...catalog.installations[0]!,
      origin: {
        kind: "github" as const,
        repo: "owner/repo",
        ref: "main",
        subdir: "my-skill",
      },
    };

    const result = await updateSkillInstallation({ config, installation });

    expect(fetchCalls).toBe(2);
    expect(result.preview.source.repo).toBe("owner/repo");
    expect(await fs.readFile(path.join(existingSkillDir, "SKILL.md"), "utf-8")).toContain('description: "Updated skill"');
  });

  test("checkSkillInstallationUpdate rejects missing original skill names", async () => {
    const config = makeConfig(root);
    await createSkill(config.skillsDirs[0]!, "my-skill", "Existing skill");
    const sourceRoot = path.join(root, "incoming");
    await createSkill(sourceRoot, "other-skill", "Other skill");

    const catalog = await scanSkillCatalog(config.skillsDirs, {
      includeDisabled: true,
      adoptManagedWritableInstalls: true,
    });
    const installation = {
      ...catalog.installations[0]!,
      origin: {
        kind: "local" as const,
        sourcePath: sourceRoot,
      },
    };

    const result = await checkSkillInstallationUpdate({ config, installation });

    expect(result.canUpdate).toBe(false);
    expect(result.reason).toBe('Recorded skill "my-skill" was not found in the update source.');
    expect(result.preview?.candidates.map((candidate) => candidate.name)).toEqual(["other-skill"]);
  });

  test("rejects updates when the original skill name is missing from the source", async () => {
    const config = makeConfig(root);
    const existingSkillDir = await createSkill(config.skillsDirs[0]!, "my-skill", "Existing skill");
    const sourceRoot = path.join(root, "incoming");
    await createSkill(sourceRoot, "other-skill", "Other skill");

    const catalog = await scanSkillCatalog(config.skillsDirs, {
      includeDisabled: true,
      adoptManagedWritableInstalls: true,
    });
    const installation = {
      ...catalog.installations[0]!,
      origin: {
        kind: "local" as const,
        sourcePath: sourceRoot,
      },
    };

    await expect(updateSkillInstallation({ config, installation })).rejects.toThrow(
      'Recorded skill "my-skill" was not found in the update source.'
    );
    expect(await fs.readFile(path.join(existingSkillDir, "SKILL.md"), "utf-8")).toContain('description: "Existing skill"');
    await expect(fs.access(path.join(config.skillsDirs[0]!, "other-skill"))).rejects.toBeDefined();
  });
});
