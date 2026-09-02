import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { scanComplexity } from "../scripts/complexity";
import { compareRepositoryComplexity } from "../scripts/complexityCompare";
import { scratchRoots } from "../src/platform/sandbox/policy";

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Complexity Test",
      "-c",
      "user.email=complexity@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${path.join(root, "no-hooks")}`,
      ...args,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function complexFunction(name: string, depth: number) {
  return `export function ${name}(value: boolean) {\n${"  if (value) {\n".repeat(depth)}return 1;\n${"  }\n".repeat(depth)}return 0;\n}\n`;
}

async function repository() {
  const root = await mkdtemp(path.join(scratchRoots()[0], "cowork-complexity-test-"));
  git(root, ["init", "--quiet"]);
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "biome.json"),
    JSON.stringify({
      vcs: { enabled: true, clientKind: "git", useIgnoreFile: true },
      linter: { enabled: true },
    }),
  );
  await writeFile(path.join(root, "src", "example.ts"), complexFunction("existing", 6));
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "test: establish complexity baseline"]);
  return { root, base: git(root, ["rev-parse", "HEAD"]) };
}

function assertTemporaryWorktreeRemoved(root: string) {
  const entries = git(root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  expect(entries).toHaveLength(1);
}

describe("complexity comparison against Git revisions", () => {
  test("diagnostics-only scans skip inventory reads while default scans retain the full report", async () => {
    const { root } = await repository();
    try {
      const fullReport = await scanComplexity(root);
      expect(fullReport.trackedFiles).toBe(2);
      expect(fullReport.textLines).toBeGreaterThan(0);
      expect(fullReport.areas).toHaveLength(2);

      const read = spyOn(fs, "readFile");
      const stat = spyOn(fs, "lstat");
      const spawn = spyOn(Bun, "spawnSync");
      try {
        const diagnostics = await scanComplexity(root, { includeInventory: false });
        expect(read).not.toHaveBeenCalled();
        expect(stat).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0]?.[0]).toContain("--reporter=json");
        expect(diagnostics).toEqual({
          ...fullReport,
          trackedFiles: 0,
          textLines: 0,
          areas: [],
        });
      } finally {
        spawn.mockRestore();
        stat.mockRestore();
        read.mockRestore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("comparisons skip inventory reads for both revisions", async () => {
    const { root, base } = await repository();
    const read = spyOn(fs, "readFile");
    const stat = spyOn(fs, "lstat");
    const spawn = spyOn(Bun, "spawnSync");
    try {
      expect(await compareRepositoryComplexity(root, base)).toEqual({
        baseCommit: base,
        headCommit: base,
        baseHotspots: 1,
        headHotspots: 1,
        changes: [],
      });
      expect(read).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      const commands = spawn.mock.calls.map(([command]) => command);
      expect(
        commands.filter((command) => Array.isArray(command) && command.includes("lint")),
      ).toHaveLength(2);
      expect(
        commands.some((command) => Array.isArray(command) && command.includes("ls-files")),
      ).toBe(false);
      assertTemporaryWorktreeRemoved(root);
    } finally {
      spawn.mockRestore();
      stat.mockRestore();
      read.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not execute configured checkout hooks while measuring the base", async () => {
    const { root, base } = await repository();
    try {
      const hooks = path.join(root, "custom-hooks");
      const marker = path.join(root, "hook-executed");
      await mkdir(hooks);
      const destination = `'${marker.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
      await writeFile(
        path.join(hooks, "post-checkout"),
        `#!/bin/sh\nprintf executed > ${destination}\n`,
        { mode: 0o755 },
      );
      git(root, ["config", "core.hooksPath", hooks]);
      await compareRepositoryComplexity(root, base);
      expect(await Bun.file(marker).exists()).toBe(false);
      assertTemporaryWorktreeRemoved(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes worktree registration when checkout fails after Git creates it", async () => {
    const { root, base } = await repository();
    const realSpawn = Bun.spawnSync;
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((command: any, options?: any) => {
      const result = realSpawn(command, options);
      if (Array.isArray(command) && command.includes("worktree") && command.includes("add")) {
        return {
          ...result,
          exitCode: 1,
          stderr: Buffer.from("checkout failed after registration"),
        };
      }
      return result;
    });
    try {
      await expect(compareRepositoryComplexity(root, base)).rejects.toThrow(
        "checkout failed after registration",
      );
      assertTemporaryWorktreeRemoved(root);
    } finally {
      spawn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the installed scanner for both revisions and recognizes a renamed, shifted function", async () => {
    const { root, base } = await repository();
    try {
      await rename(path.join(root, "src", "example.ts"), path.join(root, "src", "renamed file.ts"));
      await writeFile(
        path.join(root, "src", "renamed file.ts"),
        `// shifted\n\n${complexFunction("existing", 6)}`,
      );
      git(root, ["add", "."]);
      git(root, ["commit", "--quiet", "-m", "refactor: move unchanged function"]);
      const comparison = await compareRepositoryComplexity(root, base);
      expect(comparison).toMatchObject({
        baseCommit: base,
        baseHotspots: 1,
        headHotspots: 1,
        changes: [],
      });
      assertTemporaryWorktreeRemoved(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects increases and newly introduced functions without installing base dependencies", async () => {
    const { root, base } = await repository();
    try {
      await writeFile(
        path.join(root, "src", "example.ts"),
        complexFunction("existing", 7) + complexFunction("introduced", 6),
      );
      git(root, ["add", "."]);
      git(root, ["commit", "--quiet", "-m", "test: introduce complexity growth"]);
      const comparison = await compareRepositoryComplexity(root, base);
      expect(comparison.changes).toHaveLength(2);
      expect(comparison.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "increased", previousScore: 21, score: 28 }),
          expect.objectContaining({ kind: "new", score: 21 }),
        ]),
      );
      assertTemporaryWorktreeRemoved(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid source and still removes its temporary worktree", async () => {
    const { root, base } = await repository();
    try {
      await writeFile(path.join(root, "src", "example.ts"), "export function broken( {\n");
      await expect(compareRepositoryComplexity(root, base)).rejects.toThrow("failed");
      assertTemporaryWorktreeRemoved(root);
      await expect(compareRepositoryComplexity(root, "--help")).rejects.toThrow("rev-parse failed");
      assertTemporaryWorktreeRemoved(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
