import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getShellCommandPolicyViolation } from "../src/server/agents/commandPolicy";
import { __internal as bashInternal, createBashTool } from "../src/tools/bash";
import type { ToolContext } from "../src/tools/context";
import type { AgentConfig } from "../src/types";

function makeConfig(dir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  };
}

function makeCtx(dir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: makeConfig(dir),
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    shellPolicy: "full",
    ...overrides,
  };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-bash-policy-"));
}

describe("bash read-only shell policy", () => {
  afterEach(() => {
    bashInternal.resetRunShellCommandForTests();
  });

  test("blocks obvious project-mutating commands", () => {
    const blockedCommands = [
      ["touch README.tmp", "filesystem mutation command"],
      ["/bin/touch blocked.txt", "filesystem mutation command"],
      ["env /usr/bin/mkdir scratch", "filesystem mutation command"],
     ["env -C . touch bypass.txt", "filesystem mutation command"],
     ["env -C. touch bypass.txt", "filesystem mutation command"],
     ["env --chdir=. touch bypass.txt", "filesystem mutation command"],
      ["mkdir scratch", "filesystem mutation command"],
      ["rm -rf output", "filesystem mutation command"],
      ["ls 'x\\'; rm -rf /; echo 'y'", "filesystem mutation command"],
      ['sh -lc "touch bypass.txt"', "filesystem mutation command"],
     ['env /bin/sh -c "touch bypass.txt"', "filesystem mutation command"],
      ['env -S "sh -c \\"touch bypass.txt\\""', "filesystem mutation command"],
     ["time -p touch bypass.txt", "filesystem mutation command"],
      ["sudo -n touch bypass.txt", "filesystem mutation command"],
     ["bash -c $'touch bypass.txt'", "filesystem mutation command"],
      ["bash --rcfile /etc/profile -c \"touch bypass.txt\"", "filesystem mutation command"],
     ["bash -O extglob -c \"touch bypass.txt\"", "filesystem mutation command"],
      ['fish -C "echo ok" -c "touch secret.txt"', "filesystem mutation command"],
     ['bash --command="touch bypass.txt"', "filesystem mutation command"],
     ["bash -ctouch bypass.txt", "filesystem mutation command"],
     ['bash -c "bash -c \\"touch bypass.txt\\""', "filesystem mutation command"],
      ['bash -c "bash -c \\"bash -c \\\\\"touch bypass.txt\\\\\"\""' , "filesystem mutation command"],
      ['powershell -Command "mkdir bypass"', "filesystem mutation command"],
     ['pwsh -Command "mkdir bypass"', "filesystem mutation command"],
      ['eval "touch bypass.txt"', "filesystem mutation command"],
     ["echo `touch bypass.txt`", "filesystem mutation command"],
     ["echo $(touch bypass.txt)", "filesystem mutation command"],
     ["echo ok\ntouch bypass.txt", "filesystem mutation command"],
      ["if touch bypass.txt; then :; fi", "filesystem mutation command"],
      ["! touch bypass.txt", "filesystem mutation command"],
      ["for item in 1; do touch bypass.txt; done", "filesystem mutation command"],
     ['echo "hello" > out.txt', "shell redirection or tee write"],
      ['echo "hello" > "out.txt"', "shell redirection or tee write"],
     ["echo hello > 'out.txt'", "shell redirection or tee write"],
      ["true <> bypass.txt", "shell redirection or tee write"],
     ["{ touch bypass.txt; }", "filesystem mutation command"],
      ["echo hi>out.txt", "shell redirection or tee write"],
      ["echo hi>>out.txt", "shell redirection or tee write"],
      ["printf hi | tee out.txt", "shell redirection or tee write"],
      ["sed -i 's/a/b/' file.txt", "in-place editor"],
      ["perl -pi -e 's/a/b/' file.txt", "in-place editor"],
      ["git add .", "git write command"],
      ["git -C . add .", "git write command"],
      ["git --no-pager checkout main", "git write command"],
      ["/usr/bin/git -C . reset --hard HEAD", "git write command"],
      ['git -c "user.name=test" add .', "git write command"],
      ['git --work-tree "/tmp/worktree" commit -m "msg"', "git write command"],
     ["git checkout main", "git write command"],
     ["git reset --hard HEAD", "git write command"],
      ["git init", "git write command"],
      ["git clone foo bar", "git write command"],
      ["git stash", "git write command"],
     ["npm install", "package install command"],
      ["npm --no-audit install", "package install command"],
     ["/usr/bin/npm install", "package install command"],
     ["npm ci", "package install command"],
     ["pnpm add zod", "package install command"],
     ["pnpm --dir . add zod", "package install command"],
      ["pnpm -C . add zod", "package install command"],
     ["pnpm i", "package install command"],
     ["yarn", "package install command"],
     ["yarn install", "package install command"],
     ["yarn add lodash", "package install command"],
      ["yarn --cwd . add lodash", "package install command"],
     ["bun add zod", "package install command"],
     ["bun --cwd . add zod", "package install command"],
      ["bun -C /tmp install", "package install command"],
     ["bun i", "package install command"],
     ["python -m pip install requests", "package install command"],
      ["pip --quiet install requests", "package install command"],
      ["python -m pip --quiet install requests", "package install command"],
     ["cargo add serde", "package install command"],
   ] as const;

   const longNestedShellChain =
     Array.from({ length: 40 }, (_, i) => `bash -c "echo ${i}"`).join(" && ") +
     ' && bash -c "touch bypass.txt"';
    const backtick = String.fromCharCode(96);
    const backslash = String.fromCharCode(92);
    const nestedBacktickCommand =
      "echo " + backtick + "echo " + backslash + backtick + "touch bypass.txt" + backslash + backtick + backtick;

  expect(getShellCommandPolicyViolation(longNestedShellChain, "no_project_write")).toEqual({
    shellPolicy: "no_project_write",
    reason: "filesystem mutation command",
  });

    expect(getShellCommandPolicyViolation(nestedBacktickCommand, "no_project_write")).toEqual({
     shellPolicy: "no_project_write",
     reason: "filesystem mutation command",
   });

    for (const [command, reason] of blockedCommands) {
      expect(getShellCommandPolicyViolation(command, "no_project_write")).toEqual({
        shellPolicy: "no_project_write",
        reason,
      });
    }
  });

  test("allows read-only inspection and verification commands", () => {
    const allowedCommands = [
      "git status --short",
      "git -C . status --short",
      "git --no-pager diff --stat",
      "git diff --stat",
      'git -c "color.ui=always" status --short',
      "git log -1 --oneline",
      "ls -la",
      "find src -name '*.ts'",
      'rg "shellPolicy" src',
      "cat package.json",
      "head -n 5 README.md",
      "tail -n 5 README.md",
      "bun test test/tools.test.ts",
      "bun test test/tools.test.ts 2>&1",
      "bun test test/tools.test.ts 2>/dev/null",
      "bun run typecheck",
      "npm run build",
      "which yarn",
      "command -v yarn",
      "yarn test",
      'powershell -Command "git status --short"',
      '/bin/sh -c "git status --short"',
      "grep tee file.txt",
      "rg tee src/",
      "ls tee/",
    ];

    for (const command of allowedCommands) {
      expect(getShellCommandPolicyViolation(command, "no_project_write")).toBeNull();
    }
  });

  test("ignores redirection characters inside quoted strings", () => {
    expect(getShellCommandPolicyViolation('rg "a > b" src', "no_project_write")).toBeNull();
  });

  test("ignores mutation keywords inside quoted literals", () => {
    expect(getShellCommandPolicyViolation('rg "touch bypass.txt" src', "no_project_write")).toBeNull();
    expect(getShellCommandPolicyViolation('echo "git add ."', "no_project_write")).toBeNull();
  });

  test("blocks mutating commands before approval or execution", async () => {
    const dir = await tmpDir();
    const approveCommand = mock(async () => true);
    const runShell = mock(async () => ({
      stdout: "should not run",
      stderr: "",
      exitCode: 0,
    }));
    bashInternal.setRunShellCommandForTests(runShell);

    const tool: any = createBashTool(makeCtx(dir, {
      shellPolicy: "no_project_write",
      approveCommand,
    }));

    const res = await tool.execute({ command: "touch blocked.txt" });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Command blocked by shell policy "no_project_write"');
    expect(approveCommand).not.toHaveBeenCalled();
    expect(runShell).not.toHaveBeenCalled();
  });

  test("allows verification commands under no_project_write", async () => {
    const dir = await tmpDir();
    const approveCommand = mock(async () => true);
    const runShell = mock(async () => ({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
    }));
    bashInternal.setRunShellCommandForTests(runShell);

    const tool: any = createBashTool(makeCtx(dir, {
      shellPolicy: "no_project_write",
      approveCommand,
    }));

    const res = await tool.execute({ command: "bun run typecheck" });

    expect(res).toEqual({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
    });
    expect(approveCommand).toHaveBeenCalledWith("bun run typecheck");
    expect(runShell).toHaveBeenCalledWith({
      command: "bun run typecheck",
      cwd: dir,
      abortSignal: undefined,
    });
  });
});
