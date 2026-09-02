import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scratchRoots } from "../src/platform/sandbox";
import { __internal as pluginOperationsInternal } from "../src/plugins/operations";
import { scanSkillCatalog } from "../src/skills/catalog";
import { writeSkillInstallManifest } from "../src/skills/manifest";
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
    projectCoworkDir: path.join(root, ".cowork"),
    userCoworkDir: path.join(root, ".agent-user"),
    builtInDir: path.join(root, "builtin"),
    builtInConfigDir: path.join(root, "builtin-config"),
    skillsDirs: [path.join(root, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
  };
}

function makeProjectAndGlobalSkillsConfig(root: string): AgentConfig {
  const base = makeConfig(root);
  return {
    ...base,
    skillsDirs: [path.join(root, ".cowork", "skills"), path.join(root, ".agent-user", "skills")],
  };
}

describe("updateSkillInstallation", () => {
  let root: string;
  let skillDownloads = 0;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-operations-test-"));
    skillDownloads = 0;
    globalThis.fetch = mock(async (input) => {
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
        skillDownloads += 1;
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

    // The source is materialized once and reused for the preview, so SKILL.md is
    // downloaded exactly once (not re-fetched per preview).
    expect(skillDownloads).toBe(1);
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
  async function makeBatchFixture() {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0]!, "skills-install-batch-"));
    const config = makeConfig(root);
    const skillsDir = config.skillsDirs[0]!;
    const disabledDir = path.join(config.projectCoworkDir, "disabled-skills");
    const sourceRoot = path.join(root, "incoming");
    const originalFiles = new Map<string, string>();
    for (const [parent, name, description] of [
      [skillsDir, "alpha", "Existing enabled alpha"],
      [disabledDir, "alpha", "Existing disabled alpha"],
      [disabledDir, "beta", "Existing disabled beta"],
    ]) {
      const skillRoot = await createSkill(parent!, name!, description!);
      await writeSkillInstallManifest({
        skillRoot,
        installationId: `original-${description}`,
        installedAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      });
      await fs.writeFile(path.join(skillRoot, "notes.txt"), `${description} notes`);
      for (const file of ["SKILL.md", ".cowork-skill.json", "notes.txt"]) {
        const filePath = path.join(skillRoot, file);
        originalFiles.set(filePath, await fs.readFile(filePath, "utf-8"));
      }
    }
    for (const name of ["alpha", "beta", "gamma"]) {
      await createSkill(sourceRoot, name, `Replacement ${name}`);
    }
    return { root, config, skillsDir, disabledDir, sourceRoot, originalFiles };
  }

  test.each(["copy", "manifest", "activation"] as const)(
    "a later %s failure rolls back the whole plural install, including disabled copies",
    async (phase) => {
      const { root, config, skillsDir, sourceRoot, originalFiles } = await makeBatchFixture();
      const originalCp = fs.cp.bind(fs);
      const originalRename = fs.rename.bind(fs);
      let failed = false;
      const copySpy = spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
        if (phase === "copy" && String(source) === path.join(sourceRoot, "gamma")) {
          failed = true;
          throw new Error("simulated late batch failure");
        }
        await originalCp(source, destination, options);
      });
      const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        const target = String(destination);
        const failManifest =
          phase === "manifest" &&
          path.basename(target) === ".cowork-skill.json" &&
          path.basename(path.dirname(target)) === "gamma";
        const failActivation = phase === "activation" && target === path.join(skillsDir, "gamma");
        if (!failed && (failManifest || failActivation)) {
          failed = true;
          throw new Error("simulated late batch failure");
        }
        await originalRename(source, destination);
      });
      try {
        await expect(
          installSkillsFromSource({ config, input: sourceRoot, targetScope: "project" }),
        ).rejects.toThrow("simulated late batch failure");
        expect(failed).toBe(true);
        for (const [filePath, contents] of originalFiles) {
          expect(await fs.readFile(filePath, "utf-8")).toBe(contents);
        }
        expect(await fs.exists(path.join(skillsDir, "beta"))).toBe(false);
        expect(await fs.exists(path.join(skillsDir, "gamma"))).toBe(false);
        expect(
          (await fs.readdir(config.projectCoworkDir)).filter((entry) =>
            entry.startsWith(".skill-install-"),
          ),
        ).toEqual([]);
      } finally {
        copySpy.mockRestore();
        renameSpy.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test("a plural install activates every prepared skill and retires its old disabled copies", async () => {
    const { root, config, skillsDir, disabledDir, sourceRoot } = await makeBatchFixture();
    try {
      const result = await installSkillsFromSource({
        config,
        input: sourceRoot,
        targetScope: "project",
      });
      expect(result.installationIds).toHaveLength(3);
      expect(new Set(result.installationIds).size).toBe(3);
      for (const [index, name] of ["alpha", "beta", "gamma"].entries()) {
        expect(await fs.readFile(path.join(skillsDir, name, "SKILL.md"), "utf-8")).toContain(
          `Replacement ${name}`,
        );
        expect(result.catalog.effectiveSkills.find((entry) => entry.name === name)).toMatchObject({
          installationId: result.installationIds[index],
          enabled: true,
        });
        expect(await fs.exists(path.join(disabledDir, name))).toBe(false);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("prepares the entire batch before activating any live skill", async () => {
    const { root, config, sourceRoot, originalFiles } = await makeBatchFixture();
    const copyingLast = Promise.withResolvers<void>();
    const finishCopy = Promise.withResolvers<void>();
    const originalCp = fs.cp.bind(fs);
    const copySpy = spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      if (String(source) === path.join(sourceRoot, "gamma")) {
        copyingLast.resolve();
        await finishCopy.promise;
      }
      await originalCp(source, destination, options);
    });
    const installing = installSkillsFromSource({
      config,
      input: sourceRoot,
      targetScope: "project",
    });
    try {
      await copyingLast.promise;
      for (const [filePath, contents] of originalFiles) {
        expect(await fs.readFile(filePath, "utf-8")).toBe(contents);
      }
      finishCopy.resolve();
      expect((await installing).installationIds).toHaveLength(3);
    } finally {
      finishCopy.resolve();
      await installing.catch(() => {});
      copySpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("keeps named recovery copies when restoring an old installation also fails", async () => {
    const { root, config, skillsDir, sourceRoot, originalFiles } = await makeBatchFixture();
    const originalRename = fs.rename.bind(fs);
    const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(destination) === path.join(skillsDir, "gamma")) {
        throw new Error("simulated activation failure");
      }
      if (
        String(source).includes(`${path.sep}previous${path.sep}`) &&
        String(destination) === path.join(skillsDir, "alpha")
      ) {
        throw new Error("simulated rollback failure");
      }
      await originalRename(source, destination);
    });
    try {
      let installError: unknown;
      try {
        await installSkillsFromSource({ config, input: sourceRoot, targetScope: "project" });
      } catch (error) {
        installError = error;
      }
      expect(installError).toBeInstanceOf(AggregateError);
      const recoveryEntries = (await fs.readdir(config.projectCoworkDir)).filter((entry) =>
        entry.startsWith(".skill-install-"),
      );
      expect(recoveryEntries).toHaveLength(1);
      const recoveryDir = path.join(config.projectCoworkDir, recoveryEntries[0]!, "previous");
      expect((installError as Error).message).toContain(recoveryDir);
      expect(
        await fs.readFile(path.join(recoveryDir, "skills", "alpha", "SKILL.md"), "utf-8"),
      ).toBe(originalFiles.get(path.join(skillsDir, "alpha", "SKILL.md"))!);
      expect(
        await fs.readFile(path.join(recoveryDir, "skills", "alpha", ".cowork-skill.json"), "utf-8"),
      ).toBe(originalFiles.get(path.join(skillsDir, "alpha", ".cowork-skill.json"))!);
      expect(await fs.exists(path.join(skillsDir, "gamma"))).toBe(false);
    } finally {
      renameSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("can install a local skill whose directory contains the destination scope", async () => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0]!, "skills-install-overlap-"));
    try {
      const sourceRoot = await createSkill(root, "bundle", "Root skill");
      const config = makeConfig(sourceRoot);
      const result = await installSkillsFromSource({
        config,
        input: sourceRoot,
        targetScope: "project",
      });
      expect(result.installationIds).toHaveLength(1);
      const installedRoot = path.join(config.skillsDirs[0]!, "bundle");
      expect(await fs.readFile(path.join(installedRoot, "SKILL.md"), "utf-8")).toContain(
        "Root skill",
      );
      expect((await fs.readdir(installedRoot)).sort()).toEqual([".cowork-skill.json", "SKILL.md"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("reuses the materialized source during installs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-install-reuse-source-"));
    const originalFetch = globalThis.fetch;
    let skillDownloads = 0;
    globalThis.fetch = mock(async (input) => {
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
        skillDownloads += 1;
        return new Response(skillDoc("my-skill", "Remote skill"), { status: 200 });
      }
      return new Response(`Unexpected URL: ${url}`, { status: 404 });
    }) as typeof fetch;

    try {
      const config = makeConfig(root);
      const result = await installSkillsFromSource({
        config,
        input: "https://github.com/owner/repo/tree/main/my-skill",
        targetScope: "project",
      });

      expect(skillDownloads).toBe(1);
      expect(result.preview.candidates.map((candidate) => candidate.name)).toEqual(["my-skill"]);
      expect(
        await fs.readFile(path.join(config.skillsDirs[0]!, "my-skill", "SKILL.md"), "utf-8"),
      ).toContain('description: "Remote skill"');
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("records source hashes and treats matching sources as current", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-install-source-hash-"));
    try {
      const config = makeConfig(root);
      const sourceRoot = path.join(root, "source");
      await createSkill(sourceRoot, "my-skill", "Hash tracked skill");

      const result = await installSkillsFromSource({
        config,
        input: path.join(sourceRoot, "my-skill"),
        targetScope: "project",
      });

      const catalog = await scanSkillCatalog(config.skillsDirs, {
        includeDisabled: true,
        adoptManagedWritableInstalls: true,
      });
      const installation = catalog.installations.find(
        (entry) => entry.installationId === result.installationIds[0],
      );
      if (!installation) {
        throw new Error("Expected installed skill to be present in catalog");
      }
      expect(installation?.origin?.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);

      const updateCheck = await checkSkillInstallationUpdate({
        config,
        installation,
      });

      expect(updateCheck).toMatchObject({
        installationId: result.installationIds[0],
        canUpdate: false,
        reason: "This skill is already up to date.",
        installedSourceHash: installation.origin?.sourceHash,
        latestSourceHash: installation.origin?.sourceHash,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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

  test("preserves the existing install when the replacement copy fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-install-atomic-"));
    try {
      const config = makeConfig(root);
      await createSkill(config.skillsDirs[0]!, "my-skill", "Existing skill");
      const sourceRoot = path.join(root, "incoming");
      await createSkill(sourceRoot, "my-skill", "Replacement skill");

      pluginOperationsInternal.setCopyPluginRootImplForTests(async () => {
        throw new Error("simulated copy failure");
      });

      await expect(
        installSkillsFromSource({ config, input: sourceRoot, targetScope: "project" }),
      ).rejects.toThrow("simulated copy failure");

      expect(
        await fs.readFile(path.join(config.skillsDirs[0]!, "my-skill", "SKILL.md"), "utf-8"),
      ).toContain('description: "Existing skill"');
    } finally {
      pluginOperationsInternal.resetForTests();
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
