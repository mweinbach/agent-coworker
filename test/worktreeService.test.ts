import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../src/platform/sandbox";
import { getManagedWorktreesRoot, WorktreeService } from "../src/server/git/WorktreeService";
import type { ExecFileCompatResult } from "../src/utils/execFileCompat";

function ok(stdout = ""): ExecFileCompatResult {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("WorktreeService", () => {
  test("creates managed worktrees under ~/.cowork/worktrees with a validated branch", async () => {
    const homedir = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "cowork-worktree-home-"),
    );
    const repoRoot = path.join(homedir, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
    const execFile = async (
      file: string,
      args: string[],
      opts?: { cwd?: string },
    ): Promise<ExecFileCompatResult> => {
      calls.push({ file, args, cwd: opts?.cwd });
      if (args.join(" ") === "rev-parse --show-toplevel") return ok(`${repoRoot}\n`);
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok("abc123\n");
      if (args[0] === "check-ref-format") return ok();
      if (args[0] === "worktree" && args[1] === "add") {
        await fs.mkdir(args[4] as string, { recursive: true });
        return ok();
      }
      return { stdout: "", stderr: `unexpected git args: ${args.join(" ")}`, exitCode: 1 };
    };
    const service = new WorktreeService({ homedir, execFile });

    const result = await service.createWorktree({
      sourceCwd: repoRoot,
      ref: "main",
      branchName: "cowork/fork/example",
      titleHint: "Example Thread",
    });

    expect(result).toMatchObject({
      repoRoot: await fs.realpath(repoRoot),
      branchName: "cowork/fork/example",
      baseRef: "main",
      baseCommit: "abc123",
    });
    expect(result.path.startsWith(await fs.realpath(getManagedWorktreesRoot(homedir)))).toBe(true);
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--verify"],
      ["check-ref-format", "--branch"],
      ["worktree", "add"],
    ]);
    expect(calls.at(-1)?.args).toContain("cowork/fork/example");
  });

  test("rejects refs that could be parsed as git options", async () => {
    const homedir = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "cowork-worktree-home-"),
    );
    const repoRoot = path.join(homedir, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    const execFile = async (_file: string, args: string[]): Promise<ExecFileCompatResult> => {
      if (args.join(" ") === "rev-parse --show-toplevel") return ok(`${repoRoot}\n`);
      return ok("abc123\n");
    };
    const service = new WorktreeService({ homedir, execFile });

    await expect(service.createWorktree({ sourceCwd: repoRoot, ref: "--help" })).rejects.toThrow(
      "Worktree ref must not start with '-'",
    );
  });

  test("normalizes generated branch names from hidden or dotted title hints", async () => {
    const homedir = await fs.mkdtemp(
      path.join(scratchRoots()[0] ?? "/tmp", "cowork-worktree-home-"),
    );
    const repoRoot = path.join(homedir, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    const execFile = async (_file: string, args: string[]): Promise<ExecFileCompatResult> => {
      if (args.join(" ") === "rev-parse --show-toplevel") return ok(`${repoRoot}\n`);
      if (args[0] === "rev-parse") return ok("abc123\n");
      if (args[0] === "check-ref-format") return ok();
      if (args[0] === "worktree") {
        await fs.mkdir(args[4] as string, { recursive: true });
        return ok();
      }
      return { stdout: "", stderr: `unexpected git args: ${args.join(" ")}`, exitCode: 1 };
    };
    const service = new WorktreeService({ homedir, execFile });

    const result = await service.createWorktree({
      sourceCwd: repoRoot,
      titleHint: ".hidden foo..bar",
    });

    expect(result.branchName).toMatch(/^cowork\/fork\/hidden-foo-bar-[a-f0-9]{10}$/);
  });
});
