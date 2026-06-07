import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal, ensureCodexPrimaryRuntimeReady } from "../src/codexPrimaryRuntime";
import { buildZip, S_IFLNK, type ZipEntry } from "./fixtures/zipBuilder";

const DOWNLOAD_URL = "https://download.test/curated.zip";

const CURATED_SPECS = [
  ["documents", "documents", "documents", "documents"],
  ["presentations", "presentations", "presentations", "Presentations"],
  ["spreadsheets", "spreadsheets", "spreadsheets", "Spreadsheets"],
] as const;

/**
 * Build the curated-plugin repo layout `findCuratedRepoRoot` expects (manifest one
 * directory below the archive root, plus the three runtime skill sources).
 * `symlinkSkill` turns one SKILL.md into a malicious symlink member.
 */
function curatedArchiveEntries(symlinkSkill?: "documents"): ZipEntry[] {
  const repoRoot = "openai-plugins-main";
  const entries: ZipEntry[] = [
    { name: `${repoRoot}/.agents/plugins/marketplace.json`, data: "{}\n" },
  ];
  for (const [pluginName, sourceSkillName, targetName, sourceName] of CURATED_SPECS) {
    const skillPath = `${repoRoot}/plugins/openai-primary-runtime/plugins/${pluginName}/skills/${sourceSkillName}/SKILL.md`;
    if (symlinkSkill === pluginName) {
      entries.push({
        name: skillPath,
        data: "../../../../../../../../../../etc/hosts",
        unixMode: S_IFLNK | 0o777,
      });
      continue;
    }
    entries.push({
      name: skillPath,
      data: `---\nname: ${sourceName}\ndescription: ${targetName} skill\n---\n${targetName} body\n`,
    });
  }
  return entries;
}

function curatedFetch(archiveBytes: Uint8Array): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === __internal.CODEX_CURATED_PLUGINS_EXPORT_URL) {
      return new Response(JSON.stringify({ download_url: DOWNLOAD_URL }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === DOWNLOAD_URL) return new Response(archiveBytes, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-zip-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("codex primary runtime curated bootstrap with the real (safe) extractor", () => {
  test("installs curated skills from a benign archive into both install roots", async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, "home");
      const workspace = path.join(dir, "workspace");
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      const builtInSkillsDir = path.join(workspace, "built-in-skills");
      const globalPluginsDir = path.join(home, ".cowork", "plugins");

      const archiveBytes = new Uint8Array(buildZip(curatedArchiveEntries()));
      const result = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        builtInSkillsDir,
        globalSkillsDir: path.join(home, ".cowork", "skills"),
        globalPluginsDir,
        fetchImpl: curatedFetch(archiveBytes),
        force: true,
      });

      expect(result?.archive.status).toBe("downloaded");
      expect(
        await fs.readFile(path.join(builtInSkillsDir, "documents", "SKILL.md"), "utf-8"),
      ).toContain("documents body");
      expect(
        await fs.readFile(
          path.join(globalPluginsDir, "workspace-tools", "skills", "spreadsheets", "SKILL.md"),
          "utf-8",
        ),
      ).toContain("spreadsheets body");
      // Nothing should have been materialized as a symbolic link.
      const documentsStat = await fs.lstat(path.join(builtInSkillsDir, "documents", "SKILL.md"));
      expect(documentsStat.isSymbolicLink()).toBe(false);
    });
  });

  test("fails the curated bootstrap when a skill is a symlink and installs nothing", async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, "home");
      const workspace = path.join(dir, "workspace");
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      const builtInSkillsDir = path.join(workspace, "built-in-skills");
      const globalPluginsDir = path.join(home, ".cowork", "plugins");

      const archiveBytes = new Uint8Array(buildZip(curatedArchiveEntries("documents")));
      const result = await ensureCodexPrimaryRuntimeReady({
        homedir: home,
        workspaceDir: workspace,
        builtInSkillsDir,
        globalSkillsDir: path.join(home, ".cowork", "skills"),
        globalPluginsDir,
        fetchImpl: curatedFetch(archiveBytes),
        force: true,
      });

      expect(result?.archive.status).toBe("failed");
      expect(result?.archive.reason ?? "").toMatch(/symlink/i);
      expect(result?.skills.every((skill) => skill.status === "missing")).toBe(true);
      // No curated skill (symlink or otherwise) should have reached the install roots.
      await expect(fs.access(path.join(builtInSkillsDir, "documents"))).rejects.toThrow();
      await expect(fs.access(path.join(globalPluginsDir, "workspace-tools"))).rejects.toThrow();
    });
  });
});
