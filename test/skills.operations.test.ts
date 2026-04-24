import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanSkillCatalog } from "../src/skills/catalog";
import {
  checkSkillInstallationUpdate,
  copySkillInstallationToScope,
  installSkillsFromSource,
  updateSkillInstallation,
} from "../src/skills/operations";
import type { AgentConfig } from "../src/types";

function skillDoc(name: string, description: string): string {
  return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", "# Body"].join(
    "\n",
  );
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

function makeProjectAndGlobalSkillsConfig(root: string): AgentConfig {
  const base = makeConfig(root);
  return {
    ...base,
    skillsDirs: [path.join(root, ".agent", "skills"), path.join(root, ".agent-user", "skills")],
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
        return new Response(
          JSON.stringify([
            {
              type: "file",
              name: "SKILL.md",
              path: "my-skill/SKILL.md",
              url: "https://api.github.com/repos/owner/repo/contents/my-skill/SKILL.md?ref=main",
              download_url: "https://raw.githubusercontent.com/owner/repo/main/my-skill/SKILL.md",
            },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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
    expect(await fs.readFile(path.join(existingSkillDir, "SKILL.md"), "utf-8")).toContain(
      'description: "Updated skill"',
    );
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
      'Recorded skill "my-skill" was not found in the update source.',
    );
    expect(await fs.readFile(path.join(existingSkillDir, "SKILL.md"), "utf-8")).toContain(
      'description: "Existing skill"',
    );
    await expect(fs.access(path.join(config.skillsDirs[0]!, "other-skill"))).rejects.toBeDefined();
  });

  test("checkSkillInstallationUpdate rejects duplicate valid candidates for the recorded skill name", async () => {
    const config = makeConfig(root);
    await createSkill(config.skillsDirs[0]!, "dup-skill", "Existing skill");
    const sourceRoot = path.join(root, "incoming");
    await createSkill(path.join(sourceRoot, "a"), "dup-skill", "One");
    await createSkill(path.join(sourceRoot, "b"), "dup-skill", "Two");

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
    expect(result.reason).toBe(
      'The update source contains more than one valid skill named "dup-skill". Split the source or remove duplicates so each skill name is unique.',
    );
    expect(result.preview?.candidates.map((candidate) => candidate.relativeRootPath)).toEqual([
      path.join("a", "dup-skill"),
      path.join("b", "dup-skill"),
    ]);
  });

  test("rejects updates when the source contains duplicate valid candidates for the recorded skill name", async () => {
    const config = makeConfig(root);
    const existingSkillDir = await createSkill(
      config.skillsDirs[0]!,
      "dup-skill",
      "Existing skill",
    );
    const sourceRoot = path.join(root, "incoming");
    await createSkill(path.join(sourceRoot, "a"), "dup-skill", "One");
    await createSkill(path.join(sourceRoot, "b"), "dup-skill", "Two");

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
      'The update source contains more than one valid skill named "dup-skill". Split the source or remove duplicates so each skill name is unique.',
    );
    expect(await fs.readFile(path.join(existingSkillDir, "SKILL.md"), "utf-8")).toContain(
      'description: "Existing skill"',
    );
  });

  test("can update a local installation in place without deleting its source first", async () => {
    const config = makeConfig(root);
    const existingSkillDir = await createSkill(config.skillsDirs[0]!, "my-skill", "Existing skill");

    const catalog = await scanSkillCatalog(config.skillsDirs, {
      includeDisabled: true,
      adoptManagedWritableInstalls: true,
    });
    const installation = {
      ...catalog.installations[0]!,
      origin: {
        kind: "local" as const,
        sourcePath: existingSkillDir,
      },
    };

    const result = await updateSkillInstallation({ config, installation });

    expect(
      result.catalog.installations.find((entry) => entry.name === "my-skill")?.installationId,
    ).toBe(installation.installationId);
    expect(await fs.readFile(path.join(existingSkillDir, "SKILL.md"), "utf-8")).toContain(
      'description: "Existing skill"',
    );
  });
});

describe("copySkillInstallationToScope", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-copy-test-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("rejects copy into the same writable scope so the source is not deleted first", async () => {
    const config = makeConfig(root);
    const skillDir = await createSkill(config.skillsDirs[0]!, "my-skill", "Skill body");
    const catalog = await scanSkillCatalog(config.skillsDirs, { includeDisabled: true });
    const installation = catalog.installations[0]!;
    expect(installation.scope).toBe("project");

    await expect(
      copySkillInstallationToScope({ config, installation, targetScope: "project" }),
    ).rejects.toThrow(/already lives there/);

    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toContain("Skill body");
  });

  test("allows copy from project scope into global scope", async () => {
    const config = makeProjectAndGlobalSkillsConfig(root);
    await createSkill(config.skillsDirs[0]!, "my-skill", "From project");
    const catalog = await scanSkillCatalog(config.skillsDirs, { includeDisabled: true });
    const installation = catalog.installations.find((entry) => entry.name === "my-skill")!;
    expect(installation.scope).toBe("project");

    const result = await copySkillInstallationToScope({
      config,
      installation,
      targetScope: "global",
    });

    expect(result.installationId.length).toBeGreaterThan(0);
    const copiedMd = path.join(config.skillsDirs[1]!, "my-skill", "SKILL.md");
    expect(await fs.readFile(copiedMd, "utf-8")).toContain("From project");
  });
});

describe("installSkillsFromSource", () => {
  test("rejects a source with two valid skills that share the same name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-install-dup-"));
    try {
      const config = makeConfig(root);
      const bundle = path.join(root, "bundle");
      await fs.mkdir(path.join(bundle, "a", "dup-skill"), { recursive: true });
      await fs.writeFile(
        path.join(bundle, "a", "dup-skill", "SKILL.md"),
        skillDoc("dup-skill", "One"),
        "utf-8",
      );
      await fs.mkdir(path.join(bundle, "b", "dup-skill"), { recursive: true });
      await fs.writeFile(
        path.join(bundle, "b", "dup-skill", "SKILL.md"),
        skillDoc("dup-skill", "Two"),
        "utf-8",
      );

      await expect(
        installSkillsFromSource({ config, input: bundle, targetScope: "project" }),
      ).rejects.toThrow(/more than one valid skill named "dup-skill"/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("can reinstall from an existing local skill directory without deleting it first", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-install-same-root-"));
    try {
      const config = makeConfig(root);
      const existingSkillDir = await createSkill(
        config.skillsDirs[0]!,
        "my-skill",
        "Existing skill",
      );

      const result = await installSkillsFromSource({
        config,
        input: existingSkillDir,
        targetScope: "project",
      });

      expect(result.installationIds).toHaveLength(1);
      expect(await fs.readFile(path.join(existingSkillDir, "SKILL.md"), "utf-8")).toContain(
        'description: "Existing skill"',
      );
      await fs.access(path.join(existingSkillDir, ".cowork-skill.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
