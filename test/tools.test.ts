import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type { AgentConfig } from "../src/types";
import type { ToolContext } from "../src/tools/context";

import { createReadTool } from "../src/tools/read";
import { createWriteTool } from "../src/tools/write";
import { createEditTool } from "../src/tools/edit";
import { __internal as bashInternal, createBashTool } from "../src/tools/bash";
import { createGlobTool } from "../src/tools/glob";
import { createGrepTool } from "../src/tools/grep";
import { createWebSearchTool } from "../src/tools/webSearch";
import { __internal as webFetchInternal, createWebFetchTool } from "../src/tools/webFetch";
import { createAskTool } from "../src/tools/ask";
import { createTodoWriteTool, currentTodos, onTodoChange } from "../src/tools/todoWrite";
import { createNotebookEditTool } from "../src/tools/notebookEdit";
import { createSkillTool } from "../src/tools/skill";
import { createMemoryTool } from "../src/tools/memory";
import { createTools, listSessionToolNames } from "../src/tools/index";
import { getAiCoworkerPaths, writeConnectionStore } from "../src/connect";
import { __internal as webSafetyInternal } from "../src/utils/webSafety";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withEnv<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[key];
  if (typeof value === "string") process.env[key] = value;
  else delete process.env[key];

  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

async function withAuthHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnv("HOME", homeDir, async () => await run());
}

function makeConfig(dir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  const userAgentDir = overrides.userAgentDir ?? path.join(dir, ".agent-user");
  const authHomeDir = path.dirname(userAgentDir);
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
    userAgentDir,
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: overrides.skillsDirs ?? [path.join(authHomeDir, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    ...overrides,
  };
}

function makeCtx(dir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: makeConfig(dir),
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    ...overrides,
  };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-coworker-test-"));
}

// ---------------------------------------------------------------------------
// read tool
// ---------------------------------------------------------------------------

describe("read tool", () => {
  test("numbers lines starting from 1", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "alpha\nbeta\ngamma\n", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("1\talpha");
    expect(lines[1]).toBe("2\tbeta");
    expect(lines[2]).toBe("3\tgamma");
  });

  test("respects offset and limit", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "a\nb\nc\nd\ne\n", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, offset: 2, limit: 2 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("2\tb");
    expect(lines[1]).toBe("3\tc");
    expect(lines.length).toBe(2);
  });

  test("handles empty files", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "empty.txt");
    await fs.writeFile(p, "", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    // Empty file splits into [""], so one empty line numbered 1
    expect(out).toBe("1\t");
  });

  test("truncates lines longer than 2000 chars", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "long.txt");
    const longLine = "x".repeat(3000);
    await fs.writeFile(p, longLine, "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    // truncateLine slices to 2000 and appends "..."
    const content = out.split("\t").slice(1).join("\t");
    expect(content.length).toBeLessThanOrEqual(2003); // 2000 + "..."
    expect(content.endsWith("...")).toBe(true);
  });

  test("throws for non-existent files", async () => {
    const dir = await tmpDir();
    const t: any = createReadTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: path.join(dir, "nope.txt"), limit: 2000 })
    ).rejects.toThrow();
  });

  test("default limit of 2000 lines", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "big.txt");
    const lines = Array.from({ length: 2500 }, (_, i) => `line${i}`);
    await fs.writeFile(p, lines.join("\n"), "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    const outputLines = out.split("\n");
    expect(outputLines.length).toBe(2000);
  });

  test("single-line files", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "single.txt");
    await fs.writeFile(p, "only line", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, limit: 2000 });
    expect(out).toBe("1\tonly line");
  });

  test("resolves relative paths from workingDirectory", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "rel.txt");
    await fs.writeFile(p, "hello", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: "rel.txt", limit: 2000 });
    expect(out).toBe("1\thello");
  });

  test("offset beyond file length returns empty result", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "short.txt");
    await fs.writeFile(p, "one\ntwo\n", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    const out: string = await t.execute({ filePath: p, offset: 100, limit: 10 });
    expect(out).toBe("");
  });

  test("rejects reads outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const outsideFile = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideFile, "secret", "utf-8");

    const t: any = createReadTool(makeCtx(dir));
    await expect(t.execute({ filePath: outsideFile, limit: 10 })).rejects.toThrow(/blocked/i);
  });

  test("returns multimodal content for supported image files", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "pixel.png");
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";
    await fs.writeFile(p, Buffer.from(pngBase64, "base64"));

    const t: any = createReadTool(makeCtx(dir));
    const out = await t.execute({ filePath: p, limit: 2000 });

    expect(out).toEqual({
      type: "content",
      content: [
        { type: "text", text: "Image file: pixel.png" },
        { type: "image", data: pngBase64, mimeType: "image/png" },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// write tool
// ---------------------------------------------------------------------------

describe("write tool", () => {
  test("creates file with content", async () => {
    const dir = await tmpDir();
    const t: any = createWriteTool(makeCtx(dir));
    const p = path.join(dir, "new.txt");
    const res: string = await t.execute({ filePath: p, content: "hello world" });
    expect(res).toContain("11"); // 11 chars
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("hello world");
  });

  test("creates parent directories recursively", async () => {
    const dir = await tmpDir();
    const t: any = createWriteTool(makeCtx(dir));
    const p = path.join(dir, "a", "b", "c", "deep.txt");
    await t.execute({ filePath: p, content: "deep" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("deep");
  });

  test("overwrites existing file", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "exist.txt");
    await fs.writeFile(p, "old content", "utf-8");

    const t: any = createWriteTool(makeCtx(dir));
    await t.execute({ filePath: p, content: "new content" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("new content");
  });

  test("writes empty string", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "empty.txt");

    const t: any = createWriteTool(makeCtx(dir));
    const res: string = await t.execute({ filePath: p, content: "" });
    expect(res).toContain("0 chars");
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("");
  });

  test("rejects paths outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();

    const t: any = createWriteTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: path.join(outsideDir, "bad.txt"), content: "nope" })
    ).rejects.toThrow(/blocked/i);
  });

  test("returns descriptive result string", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "desc.txt");
    const t: any = createWriteTool(makeCtx(dir));
    const res: string = await t.execute({ filePath: p, content: "abc" });
    expect(res).toContain("Wrote");
    expect(res).toContain("3 chars");
    expect(res).toContain(p);
  });

  test("writes multiline content", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "multi.txt");
    const t: any = createWriteTool(makeCtx(dir));
    await t.execute({ filePath: p, content: "line1\nline2\nline3" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("line1\nline2\nline3");
  });

  test("writes to output directory", async () => {
    const dir = await tmpDir();
    const outDir = path.join(dir, "output");
    await fs.mkdir(outDir, { recursive: true });
    const p = path.join(outDir, "result.txt");

    const t: any = createWriteTool(makeCtx(dir));
    await t.execute({ filePath: p, content: "output content" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("output content");
  });

  test("rejects write through symlink segment to outside directory", async () => {
    if (process.platform === "win32") return;

    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const link = path.join(dir, "outside-link");
    await fs.symlink(outsideDir, link);

    const t: any = createWriteTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: path.join(link, "blocked.txt"), content: "nope" })
    ).rejects.toThrow(/blocked/i);
  });
});

// ---------------------------------------------------------------------------
// edit tool
// ---------------------------------------------------------------------------

describe("edit tool", () => {
  test("replaces single occurrence", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "hello world", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    const res = await t.execute({
      filePath: p,
      oldString: "world",
      newString: "earth",
      replaceAll: false,
    });
    expect(res).toBe("Edit applied.");
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("hello earth");
  });

  test("throws when oldString not found", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "hello world", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "missing", newString: "x", replaceAll: false })
    ).rejects.toThrow(/oldString not found/);
  });

  test("throws when multiple occurrences without replaceAll", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "foo\nfoo\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "foo", newString: "bar", replaceAll: false })
    ).rejects.toThrow(/found 2 times/);
  });

  test("replaces all occurrences with replaceAll", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "foo\nfoo\nfoo\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    const res = await t.execute({
      filePath: p,
      oldString: "foo",
      newString: "bar",
      replaceAll: true,
    });
    expect(res).toBe("Edit applied.");
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("bar\nbar\nbar\n");
  });

  test("handles empty newString (deletion)", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "hello world", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await t.execute({ filePath: p, oldString: " world", newString: "", replaceAll: false });
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("hello");
  });

  test("throws when oldString is empty", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "content", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "", newString: "new", replaceAll: false })
    ).rejects.toThrow("oldString cannot be empty");
  });

  test("case-sensitive matching", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "Hello World", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    // Lowercase "hello" should not match "Hello"
    await expect(
      t.execute({ filePath: p, oldString: "hello", newString: "hi", replaceAll: false })
    ).rejects.toThrow(/oldString not found/);
  });

  test("rejects path outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const p = path.join(outsideDir, "blocked.txt");
    await fs.writeFile(p, "content", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "content", newString: "new", replaceAll: false })
    ).rejects.toThrow(/blocked/i);
  });

  test("rejects edit through symlink segment to outside directory", async () => {
    if (process.platform === "win32") return;

    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const outsideFile = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideFile, "outside", "utf-8");

    const link = path.join(dir, "outside-link");
    await fs.symlink(outsideDir, link);

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({
        filePath: path.join(link, "outside.txt"),
        oldString: "outside",
        newString: "new",
        replaceAll: false,
      })
    ).rejects.toThrow(/blocked/i);
  });

  test("preserves file content around the edit", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "line1\nTARGET\nline3\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await t.execute({ filePath: p, oldString: "TARGET", newString: "REPLACED", replaceAll: false });
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("line1\nREPLACED\nline3\n");
  });

  test("replaces multiline oldString", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "start\nmiddle\nend\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await t.execute({
      filePath: p,
      oldString: "start\nmiddle",
      newString: "replaced",
      replaceAll: false,
    });
    const content = await fs.readFile(p, "utf-8");
    expect(content).toBe("replaced\nend\n");
  });

  test("reports correct count for three occurrences", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "file.txt");
    await fs.writeFile(p, "aaa\naaa\naaa\n", "utf-8");

    const t: any = createEditTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: p, oldString: "aaa", newString: "bbb", replaceAll: false })
    ).rejects.toThrow(/found 3 times/);
  });
});

// ---------------------------------------------------------------------------
// bash tool
// ---------------------------------------------------------------------------

describe("bash tool", () => {
  afterEach(() => {
    bashInternal.resetRunShellCommandForTests();
  });

  test("advertises Windows PowerShell guidance in the tool description", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    expect(t.description).toContain("preferring `pwsh` and falling back to `powershell.exe`");
    expect(t.description).toContain("do not rely on `&&`, `export`, or `source`");
    expect(t.description).toContain("prefer `py -3` or `python`");
  });

  test("prefers pwsh before powershell.exe on Windows", async () => {
    const seen: string[] = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: "C:/tmp",
      platform: "win32",
      execRunner: async (file: string) => {
        seen.push(file);
        if (file === "pwsh") {
          return { stdout: "hi\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1, errorCode: "ENOENT" };
      },
    });

    expect(seen).toEqual(["pwsh"]);
    expect(result.stdout.trim()).toBe("hi");
  });

  test("falls back to powershell.exe when pwsh is unavailable", async () => {
    const seen: string[] = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: "C:/tmp",
      platform: "win32",
      execRunner: async (file: string) => {
        seen.push(file);
        if (file === "pwsh") {
          return { stdout: "", stderr: "", exitCode: 1, errorCode: "ENOENT" };
        }
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
    });

    expect(seen).toEqual(["pwsh", "powershell.exe"]);
    expect(result.stdout.trim()).toBe("hi");
  });

  test("executes simple command and returns stdout", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    }));
    const res = await t.execute({ command: "echo hello" });
    expect(res.stdout.trim()).toBe("hello");
    expect(res.exitCode).toBe(0);
  });

  test("returns exit code on failure", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({ command: "exit 42" });
    expect(res.exitCode).not.toBe(0);
  });

  test("calls approveCommand before execution", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true);
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;

    const t: any = createBashTool(ctx);
    await t.execute({ command: "echo test" });
    expect(approveFn).toHaveBeenCalledWith("echo test");
  });

  test("returns rejection when command not approved", async () => {
    const dir = await tmpDir();
    const ctx = makeCtx(dir);
    ctx.approveCommand = async () => false;

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "echo secret" });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("rejected");
  });

  test("handles stderr output", async () => {
    const dir = await tmpDir();
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "",
      stderr: "error\n",
      exitCode: 0,
    }));
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({
      command: `bun -e "console.error('error')"`,
    });
    expect(res.stderr.trim()).toBe("error");
  });

  test("uses workingDirectory as cwd", async () => {
    const dir = await tmpDir();
    const seen: Array<{ command: string; cwd: string; abortSignal?: AbortSignal }> = [];
    bashInternal.setRunShellCommandForTests(async (opts) => {
      seen.push(opts);
      return {
        stdout: `${opts.cwd}\n`,
        stderr: "",
        exitCode: 0,
      };
    });
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({ command: `bun -e "console.log(process.cwd())"` });
    // Resolve symlinks for macOS /private/var/... vs /var/...
    const normalizedStdout = await fs.realpath(res.stdout.trim());
    const normalizedDir = await fs.realpath(dir);
    expect(seen[0]?.cwd).toBe(dir);
    expect(normalizedStdout).toBe(normalizedDir);
  });

  test("returns full large stdout so the runtime spill layer can handle overflow", async () => {
    const dir = await tmpDir();
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "x".repeat(50000),
      stderr: "",
      exitCode: 0,
    }));
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({
      command: `bun -e "process.stdout.write('x'.repeat(50000))"`,
    });
    expect(res.stdout).toHaveLength(50000);
  });

  test("returns stdout and stderr together", async () => {
    const dir = await tmpDir();
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 0,
    }));
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({
      command: `bun -e "console.log('out'); console.error('err')"`,
    });
    expect(res.stdout.trim()).toBe("out");
    expect(res.stderr.trim()).toBe("err");
  });

  test("rejected command does not execute the command", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "should-not-exist.txt");
    const ctx = makeCtx(dir);
    ctx.approveCommand = async () => false;

    const t: any = createBashTool(ctx);
    await t.execute({ command: `touch "${p}"` });
    // File should not have been created since command was rejected
    await expect(fs.access(p)).rejects.toThrow();
  });

  test("returns empty stdout on rejected command", async () => {
    const dir = await tmpDir();
    const ctx = makeCtx(dir);
    ctx.approveCommand = async () => false;

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "echo should not see" });
    expect(res.stdout).toBe("");
  });

  test("returns aborted exit code when turn signal is aborted", async () => {
    const dir = await tmpDir();
    const controller = new AbortController();
    controller.abort();
    const t: any = createBashTool(makeCtx(dir, { abortSignal: controller.signal }));
    const res = await t.execute({ command: "echo hello" });
    expect(res.exitCode).toBe(130);
    expect(res.stderr.toLowerCase()).toContain("aborted");
  });
});

// ---------------------------------------------------------------------------
// glob tool
// ---------------------------------------------------------------------------

describe("glob tool", () => {
  test("finds files matching pattern", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "a.ts"), "", "utf-8");
    await fs.writeFile(path.join(dir, "b.ts"), "", "utf-8");
    await fs.writeFile(path.join(dir, "c.js"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.ts" });
    expect(res).toContain("a.ts");
    expect(res).toContain("b.ts");
    expect(res).not.toContain("c.js");
  });

  test("returns empty message for no matches", async () => {
    const dir = await tmpDir();
    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.xyz" });
    expect(res).toBe("No files found.");
  });

  test("uses workingDirectory as default cwd", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "test.txt"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.txt" });
    expect(res).toContain("test.txt");
  });

  test("handles recursive patterns", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, "sub", "deep"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "deep", "file.ts"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "**/*.ts" });
    expect(res).toContain("sub/deep/file.ts");
  });

  test("respects custom cwd argument", async () => {
    const dir = await tmpDir();
    const subDir = path.join(dir, "subdir");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, "inner.txt"), "", "utf-8");
    await fs.writeFile(path.join(dir, "outer.txt"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.txt", cwd: subDir });
    expect(res).toContain("inner.txt");
    expect(res).not.toContain("outer.txt");
  });

  test("treats brace patterns literally when brace expansion is disabled", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "a.ts"), "", "utf-8");
    await fs.writeFile(path.join(dir, "b.js"), "", "utf-8");
    await fs.writeFile(path.join(dir, "c.py"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.{ts,js}" });
    expect(res).toBe("No files found.");
  });

  test("does not expand brace patterns containing absolute paths", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "a.ts"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "{/etc/passwd,*.ts}" });
    expect(res).toBe("No files found.");
    expect(res).not.toContain("/etc/passwd");
  });

  test("rejects glob with cwd outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    await fs.writeFile(path.join(outsideDir, "x.ts"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: "*.ts", cwd: outsideDir })).rejects.toThrow(/blocked/i);
  });

  test("rejects matches that escape allowed scope via symlink path segments", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const linkPath = path.join(dir, "link");
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "", "utf-8");

    try {
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(outsideDir, linkPath, symlinkType);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw err;
    }

    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: "link/*.txt" })).rejects.toThrow(/blocked/i);
  });

  test("rejects glob with parent-relative pattern escaping cwd", async () => {
    const dir = await tmpDir();

    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: "../outside/*.ts" })).rejects.toThrow(/blocked/i);
  });

  test("rejects glob with absolute pattern", async () => {
    const dir = await tmpDir();
    const absolutePattern = path.join(dir, "*.ts");

    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: absolutePattern })).rejects.toThrow(/blocked/i);
  });

  test("limits results when maxResults is provided", async () => {
    const dir = await tmpDir();
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(dir, `f${i}.txt`), "", "utf-8");
    }

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.txt", maxResults: 2 });
    const lines = res.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(res).toContain("truncated to 2 matches");
  });
});

// ---------------------------------------------------------------------------
// grep tool
// ---------------------------------------------------------------------------

describe("grep tool", () => {
  const fakeEnsureRipgrep: any = async () => "rg";

  function globToRegExp(glob: string): RegExp {
    // Minimal glob support for tests (enough for patterns like "*.ts").
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const re = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
    return new RegExp(re);
  }

  const fakeExecFile: any = (_cmd: string, args: string[], _opts: any, cb: any) => {
    void (async () => {
      try {
        let caseInsensitive = false;
        let contextLines = 0;
        let fileGlob: string | undefined;

        const rest = [...args];
        while (rest.length > 0) {
          const a = rest[0];
          if (a === "--line-number") {
            rest.shift();
            continue;
          }
          if (a === "-i") {
            rest.shift();
            caseInsensitive = true;
            continue;
          }
          if (a === "-C") {
            rest.shift();
            const v = rest.shift();
            contextLines = v ? Number(v) : 0;
            continue;
          }
          if (a === "--glob") {
            rest.shift();
            fileGlob = rest.shift();
            continue;
          }
          if (a === "--") {
            rest.shift();
            break;
          }
          break;
        }

        const pattern = rest.shift();
        const searchPath = rest.shift();
        if (!pattern || !searchPath) throw new Error("fake rg: missing pattern or searchPath");

        const re = new RegExp(pattern, caseInsensitive ? "i" : "");
        const globRe = fileGlob ? globToRegExp(fileGlob) : null;

        const files: string[] = [];
        const walk = async (p: string) => {
          const st = await fs.stat(p);
          if (st.isFile()) {
            if (!globRe || globRe.test(path.basename(p))) files.push(p);
            return;
          }
          if (!st.isDirectory()) return;
          const entries = await fs.readdir(p, { withFileTypes: true });
          for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            await walk(path.join(p, e.name));
          }
        };

        await walk(searchPath);

        const outLines: string[] = [];
        for (const filePath of files) {
          const raw = await fs.readFile(filePath, "utf-8");
          const lines = raw.split("\n");

          const addLine = (idx: number) => {
            if (idx < 0 || idx >= lines.length) return;
            const lineNo = idx + 1;
            outLines.push(`${filePath}:${lineNo}:${lines[idx]}`);
          };

          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i] ?? "")) continue;
            for (let j = i - contextLines; j <= i + contextLines; j++) addLine(j);
          }
        }

        if (outLines.length === 0) {
          const err: any = new Error("no matches");
          err.code = 1;
          cb(err, "", "");
          return;
        }

        cb(null, outLines.join("\n") + "\n", "");
      } catch (err) {
        cb(err, "", "");
      }
    })();
  };

  test("returns matches for pattern", async () => {
    const dir = await tmpDir();
    await fs.writeFile(
      path.join(dir, "haystack.txt"),
      "needle in the haystack\nno match here\nneedle again\n",
      "utf-8"
    );

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "needle",
      path: dir,
      caseSensitive: true,
    });
    expect(res).toContain("needle");
    expect(res).toContain("haystack.txt");
  });

  test("rejects grep path outside allowed directories", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    await fs.writeFile(path.join(outsideDir, "file.txt"), "secret\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await expect(
      t.execute({
        pattern: "secret",
        path: outsideDir,
        caseSensitive: true,
      })
    ).rejects.toThrow(/blocked/i);
  });

  test("returns 'No matches' on no results", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "some content\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "zzz_impossible_pattern_zzz",
      path: dir,
      caseSensitive: true,
    });
    expect(res).toContain("No matches found.");
  });

  test("handles case-insensitive flag", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "Hello World\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "hello",
      path: dir,
      caseSensitive: false,
    });
    expect(res).toContain("Hello World");
  });

  test("case-sensitive search does not match wrong case", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "Hello World\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "hello",
      path: dir,
      caseSensitive: true,
    });
    expect(res).toContain("No matches found.");
  });

  test("uses workingDirectory as default search path", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "found.txt"), "target_pattern\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "target_pattern",
      caseSensitive: true,
    });
    expect(res).toContain("target_pattern");
  });

  test("respects fileGlob filter", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "match.ts"), "pattern_here\n", "utf-8");
    await fs.writeFile(path.join(dir, "skip.js"), "pattern_here\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "pattern_here",
      path: dir,
      fileGlob: "*.ts",
      caseSensitive: true,
    });
    expect(res).toContain("match.ts");
    expect(res).not.toContain("skip.js");
  });

  test("includes context lines when specified", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "ctx.txt"), "before\ntarget\nafter\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "target",
      path: dir,
      contextLines: 1,
      caseSensitive: true,
    });
    expect(res).toContain("before");
    expect(res).toContain("target");
    expect(res).toContain("after");
  });

  test("includes line numbers in output", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "numbered.txt"), "aaa\nbbb\nccc\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "bbb",
      path: dir,
      caseSensitive: true,
    });
    // rg with --line-number should include ":2:" in output
    expect(res).toContain("2:");
  });

  test("constructs correct rg flags for fileGlob, case-insensitive, and contextLines", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.ts"), "match\n", "utf-8");

    let capturedCmd = "";
    let capturedArgs: string[] = [];

    const argCaptureExecFile: any = (cmd: string, args: string[], _opts: any, cb: any) => {
      capturedCmd = cmd;
      capturedArgs = [...args];
      // Simulate rg producing output so the tool returns normally
      cb(null, `${path.join(dir, "file.ts")}:1:match\n`, "");
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await t.execute({
      pattern: "foo",
      path: dir,
      fileGlob: "*.ts",
      contextLines: 3,
      caseSensitive: false,
    });

    expect(capturedCmd).toBe("rg");
    // Verify all expected flags are present
    expect(capturedArgs).toContain("--line-number");
    expect(capturedArgs).toContain("-i");
    expect(capturedArgs).toContain("-C");
    expect(capturedArgs).toContain("3");
    expect(capturedArgs).toContain("--glob");
    expect(capturedArgs).toContain("*.ts");
    expect(capturedArgs).toContain("--");

    // Pattern and path should be the last two positional args
    const patternIdx = capturedArgs.indexOf("foo");
    expect(patternIdx).toBeGreaterThan(-1);

    const searchPathArg = capturedArgs[patternIdx + 1];
    expect(searchPathArg).toBe(path.resolve(dir));
  });

  test("omits -i flag when caseSensitive is true", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "file.txt"), "data\n", "utf-8");

    let capturedArgs: string[] = [];

    const argCaptureExecFile: any = (cmd: string, args: string[], _opts: any, cb: any) => {
      capturedArgs = [...args];
      cb(null, `${path.join(dir, "file.txt")}:1:data\n`, "");
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    await t.execute({
      pattern: "data",
      path: dir,
      caseSensitive: true,
    });

    expect(capturedArgs).toContain("--line-number");
    expect(capturedArgs).not.toContain("-i");
    expect(capturedArgs).not.toContain("--glob");
    expect(capturedArgs).not.toContain("-C");
    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("data");
    expect(capturedArgs).toContain(path.resolve(dir));
  });

  test("inserts -- before dash-prefixed patterns", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "flags.txt"), "--files-with-matches\n", "utf-8");

    let capturedArgs: string[] = [];
    const argCaptureExecFile: any = (_cmd: string, args: string[], _opts: any, cb: any) => {
      capturedArgs = [...args];
      cb(null, `${path.join(dir, "flags.txt")}:1:--files-with-matches\n`, "");
    };

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: argCaptureExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });

    const res: string = await t.execute({
      pattern: "--files-with-matches",
      path: dir,
      caseSensitive: true,
    });

    expect(res).toContain("--files-with-matches");
    expect(capturedArgs).toContain("--");
    const delimiterIdx = capturedArgs.indexOf("--");
    expect(capturedArgs[delimiterIdx + 1]).toBe("--files-with-matches");
  });

  test("searches in subdirectories", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "deep.txt"), "deep_match\n", "utf-8");

    const t: any = createGrepTool(makeCtx(dir), {
      execFileImpl: fakeExecFile,
      ensureRipgrepImpl: fakeEnsureRipgrep,
    });
    const res: string = await t.execute({
      pattern: "deep_match",
      path: dir,
      caseSensitive: true,
    });
    expect(res).toContain("deep_match");
    expect(res).toContain("deep.txt");
  });
});

// ---------------------------------------------------------------------------
// webSearch tool
// ---------------------------------------------------------------------------

describe("webSearch tool", () => {
  const makeCustomSearchCtx = (dir: string) =>
    makeCtx(dir, {
      config: makeConfig(dir, {
        provider: "codex-cli",
        model: "gpt-5.3-codex",
        preferredChildModel: "gpt-5.3-codex",
      }),
    });

  test("uses Exa-backed web search", async () => {
    const dir = await tmpDir();
    const t: any = createWebSearchTool(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
        }),
      })
    );
    expect(t.type).toBeUndefined();
    expect(typeof t.execute).toBe("function");
    expect(t.description).toContain("EXA_API_KEY");
    expect(t.description).toContain("type/category");
  });

  test("openai/codex-style search advertises Exa key requirements", async () => {
    const dir = await tmpDir();
    const t: any = createWebSearchTool(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        }),
      })
    );

    expect(t.description).toContain("EXA_API_KEY");
    expect(t.description).not.toContain("BRAVE_API_KEY");
  });

  test("web search requires EXA_API_KEY", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebSearchTool(
          makeCtx(dir, {
            config: makeConfig(dir, {
              provider: "google",
              model: "gemini-3.1-pro-preview",
              preferredChildModel: "gemini-3.1-pro-preview",
            }),
          })
        );
        const out: string = await t.execute({ query: "test", maxResults: 1 });
        expect(out).toContain("set EXA_API_KEY");
      });
    } finally {
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("returns disabled message without API keys", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
        const out: string = await t.execute({ query: "test", maxResults: 1 });
        expect(out).toContain("webSearch disabled");
      });
    } finally {
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("ignores BRAVE_API_KEY without Exa credentials", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    const oldBrave = process.env.BRAVE_API_KEY;
    delete process.env.EXA_API_KEY;
    process.env.BRAVE_API_KEY = "brave_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("should not call Brave");
    }) as any;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
        const out: string = await t.execute({ q: "HTTP 418 RFC 2324", maxResults: 1 });
        expect(out).toContain("webSearch disabled");
        expect(out).toContain("EXA_API_KEY");
        expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      else delete process.env.BRAVE_API_KEY;
    }
  });

  test("accepts alias query keys for Exa search", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.query).toBe("latest sdk changelog");
      expect(body.numResults).toBe(3);
      expect(body.type).toBe("auto");
      expect(body.contents?.highlights?.maxCharacters).toBe(2500);
      expect(body.category).toBeUndefined();
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Result title",
              url: "https://example.com",
              highlights: ["Primary highlight"],
              text: "Fallback snippet",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out = await t.execute({
        searchQuery: "latest sdk changelog",
        maxResults: 3,
      });
      expect(out).toMatchObject({
        provider: "exa",
        count: 1,
        request: {
          query: "latest sdk changelog",
          numResults: 3,
          type: "auto",
        },
      });
      expect((out as any).response.results).toEqual([
        {
          title: "Result title",
          url: "https://example.com",
          highlights: ["Primary highlight"],
          text: "Fallback snippet",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("prefers the original turnUserPrompt over the latest steer fallback query", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.query).toBe("find recent bun releases");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebSearchTool(
          makeCtx(dir, {
            turnUserPrompt: "find recent bun releases",
            getTurnUserPrompt: () => "make it concise",
          })
        );
        await t.execute({});
        expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("uses Exa even when BRAVE_API_KEY is configured", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    const oldBrave = process.env.BRAVE_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";
    process.env.BRAVE_API_KEY = "brave_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.query).toBe("latest nvidia news");
      expect(body.numResults).toBe(5);
      expect(body.type).toBe("deep");
      expect(body.category).toBe("company");
      expect(body.contents?.highlights?.maxCharacters).toBe(2500);

      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Nvidia result",
              url: "https://example.com/nvda",
              highlights: ["Deep company highlight"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out = await t.execute({
        query: "latest nvidia news",
        maxResults: 5,
        type: "deep",
        category: "company",
      });
      expect(out).toMatchObject({
        provider: "exa",
        count: 1,
        request: {
          query: "latest nvidia news",
          numResults: 5,
          type: "deep",
          category: "company",
        },
      });
      expect((out as any).response.results).toEqual([
        {
          title: "Nvidia result",
          url: "https://example.com/nvda",
          highlights: ["Deep company highlight"],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      else delete process.env.BRAVE_API_KEY;
    }
  });

  test("normalizes the news article category alias to Exa news", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.type).toBe("auto");
      expect(body.category).toBe("news");
      expect(body.contents?.highlights?.maxCharacters).toBe(2500);

      return new Response(
        JSON.stringify({
          results: [
            {
              title: "News result",
              url: "https://example.com/news",
              highlights: ["News highlight"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out = await t.execute({
        query: "latest nvidia news",
        category: "news article",
      });
      expect(out).toMatchObject({
        provider: "exa",
        count: 1,
        request: {
          query: "latest nvidia news",
          numResults: 10,
          type: "auto",
          category: "news",
        },
      });
      expect((out as any).response.results).toEqual([
        {
          title: "News result",
          url: "https://example.com/news",
          highlights: ["News highlight"],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// webFetch tool
// ---------------------------------------------------------------------------

describe("webFetch tool", () => {
  const toFetchUrl = (input: string | URL | Request) =>
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  beforeEach(() => {
    webFetchInternal.setHtmlToMarkdownForTests(async (html: string) =>
      html
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    webFetchInternal.setMaxDownloadBytes(50 * 1024 * 1024);
    webFetchInternal.setResponseTimeoutMs(5_000);
    webSafetyInternal.setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    webFetchInternal.resetHtmlToMarkdownForTests();
    webSafetyInternal.resetDnsLookup();
  });

  const createStreamingResponse = (bytes: Uint8Array, init: ResponseInit, chunkSize = 4) => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
        }
        controller.close();
      },
    }), init);
    Object.defineProperty(response, "arrayBuffer", {
      value: async () => {
        throw new Error("should not buffer direct downloads");
      },
    });
    return response;
  };

  const createBodylessDownloadResponse = (
    bytes: Uint8Array,
    init: ResponseInit,
    options: { includeContentLength?: boolean } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (options.includeContentLength !== false) {
      headers.set("Content-Length", String(bytes.length));
    }

    const response = new Response(null, {
      ...init,
      headers,
    });
    Object.defineProperty(response, "body", {
      value: null,
    });
    Object.defineProperty(response, "arrayBuffer", {
      value: async () => Uint8Array.from(bytes).buffer,
    });
    return response;
  };

  test("returns cleaned local HTML and appends Exa links when available", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const fetchUrl = toFetchUrl(input);
      if (fetchUrl.includes("api.exa.ai/contents")) {
        const body = JSON.parse(String(init?.body));
        expect(body.urls).toEqual(["https://example.com/"]);
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://example.com/",
                text: "# Hello from Exa\n\nFetched remotely.",
                extras: {
                  links: ["https://example.com/about", "https://example.com/contact"],
                  imageLinks: ["https://cdn.example.com/hero.png"],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response(
        "<!doctype html><html><head><style>.bad{display:none}</style><script>window.hacked = true</script></head><body><main><article><h1>Hello world</h1><p>Local HTML should win.</p></article></main></body></html>",
        {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com", maxLength: 50000 });
      expect(out).toContain("Hello world");
      expect(out).toContain("Local HTML should win.");
      expect(out).not.toContain("Hello from Exa");
      expect(out).not.toContain("window.hacked");
      expect(out).not.toContain(".bad");
      expect(out).toContain("Links:");
      expect(out).toContain("https://example.com/about");
      expect(out).toContain("Image Links:");
      expect(out).toContain("https://cdn.example.com/hero.png");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("returns cleaned local HTML without Exa credentials", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    let exaCalls = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (toFetchUrl(input).includes("api.exa.ai/contents")) {
        exaCalls += 1;
      }

      return new Response("<html><body><article><h1>Offline page</h1><p>Rendered locally.</p></article></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    try {
      await withAuthHome(dir, async () => {
        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({ url: "https://example.com/fallback", maxLength: 50000 });
        expect(out).toContain("Offline page");
        expect(out).toContain("Rendered locally.");
        expect(exaCalls).toBe(0);
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("falls back to local HTML when Exa enrichment fails", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const fetchUrl = toFetchUrl(input);
      if (fetchUrl.includes("api.exa.ai/contents")) {
        return new Response("upstream unavailable", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/plain" },
        });
      }

      return new Response("<html><body><article><h1>Fallback page</h1><p>Use local content.</p></article></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/page", maxLength: 50000 });
      expect(out).toContain("Fallback page");
      expect(out).toContain("Use local content.");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("preserves direct text responses instead of routing them through Exa", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";
    let exaCalls = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      if (toFetchUrl(input).includes("api.exa.ai/contents")) {
        exaCalls += 1;
        throw new Error("should not call Exa for direct text");
      }

      return new Response('{"ok":true,"source":"origin"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/data.json", maxLength: 50000 });
      expect(out).toBe('{"ok":true,"source":"origin"}');
      expect(exaCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("downloads markdown documents when served with text MIME and a supported document filename", async () => {
    const dir = await tmpDir();
    const cases = [
      {
        url: "https://example.com/docs/README.md",
        fileName: "README.md",
        contentType: "text/plain",
        contentDisposition: null,
        body: "# Release Notes\n\n- item\n",
      },
      {
        url: "https://example.com/download",
        fileName: "release-notes.markdown",
        contentType: "text/markdown",
        contentDisposition: 'attachment; filename="release-notes.markdown"',
        body: "# Changelog\n\n- shipped\n",
      },
    ] as const;

    const originalFetch = globalThis.fetch;
    try {
      for (const testCase of cases) {
        globalThis.fetch = mock(async () => {
          return new Response(testCase.body, {
            status: 200,
            headers: {
              "Content-Type": testCase.contentType,
              ...(testCase.contentDisposition ? { "Content-Disposition": testCase.contentDisposition } : {}),
            },
          });
        }) as any;

        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({ url: testCase.url, maxLength: 50000 });
        const downloadedPath = path.join(dir, "Downloads", testCase.fileName);

        expect(out).toBe(`File downloaded ${downloadedPath}`);
        expect(await fs.readFile(downloadedPath, "utf-8")).toBe(testCase.body);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads CSV documents from text/csv MIME even without a filename extension", async () => {
    const dir = await tmpDir();
    const csv = "month,amount\nJan,10\n";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(csv, {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/export", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "export.csv");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath, "utf-8")).toBe(csv);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps the supported URL document extension when content-disposition uses a non-document filename", async () => {
    const dir = await tmpDir();
    const markdown = "# Read me\n";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(markdown, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": 'attachment; filename="README.txt"',
        },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/docs/README.md", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "README.md");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath, "utf-8")).toBe(markdown);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads body-less direct downloads when content-length is declared", async () => {
    const dir = await tmpDir();
    const markdownBytes = Buffer.from("# Cached README\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return createBodylessDownloadResponse(markdownBytes, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": 'attachment; filename="README.md"',
        },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/download", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "README.md");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(markdownBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects body-less direct downloads without a content-length header", async () => {
    const dir = await tmpDir();
    const pdfBytes = Buffer.from("%PDF-1.7\nbodyless\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return createBodylessDownloadResponse(
        pdfBytes,
        {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        },
        { includeContentLength: false },
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/reports/bodyless.pdf", maxLength: 50000 })
      ).rejects.toThrow(/without a readable body or content-length header/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("truncates inline content to maxLength", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response("x".repeat(10_000), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/notes.txt", maxLength: 1000 });
      expect(out.length).toBeLessThanOrEqual(1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles fetch errors", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("Network error");
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/bad", maxLength: 50000 })
      ).rejects.toThrow("Network error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("blocks localhost/private URLs", async () => {
    const dir = await tmpDir();
    const t: any = createWebFetchTool(makeCtx(dir));
    await expect(
      t.execute({ url: "http://127.0.0.1/internal", maxLength: 50000 })
    ).rejects.toThrow(/private\/internal host/i);
  });

  test("rejects redirect to blocked private host", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/admin" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com", maxLength: 50000 })
      ).rejects.toThrow(/private\/internal host/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads PDFs into the workspace Downloads folder", async () => {
    const dir = await tmpDir();
    const pdfBytes = Buffer.from("%PDF-1.7\nfake\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return createStreamingResponse(pdfBytes, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/reports/q1-summary.pdf", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "q1-summary.pdf");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(pdfBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("cleans up partial downloads when a streamed response exceeds the size limit", async () => {
    const dir = await tmpDir();
    webFetchInternal.setMaxDownloadBytes(8);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("12345"));
          controller.enqueue(Buffer.from("67890"));
          controller.close();
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/reports/too-large.pdf", maxLength: 50000 })
      ).rejects.toThrow(/8 bytes limit/i);
      expect(await fs.readdir(path.join(dir, "Downloads"))).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      webFetchInternal.setMaxDownloadBytes(50 * 1024 * 1024);
    }
  });

  test("downloads office documents from document MIME types and content-disposition filenames", async () => {
    const dir = await tmpDir();
    const cases = [
      {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "quarterly report.docx",
      },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: "planning sheet.xlsx",
      },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        fileName: "board deck.pptx",
      },
    ] as const;

    const originalFetch = globalThis.fetch;

    try {
      for (const testCase of cases) {
        const bytes = Buffer.from(`bytes:${testCase.fileName}`);
        globalThis.fetch = mock(async () => {
          return new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": testCase.mimeType,
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(testCase.fileName)}`,
            },
          });
        }) as any;

        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({ url: "https://example.com/download", maxLength: 50000 });
        const downloadedPath = path.join(dir, "Downloads", testCase.fileName);

        expect(out).toBe(`File downloaded ${downloadedPath}`);
        expect(await fs.readFile(downloadedPath)).toEqual(bytes);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads recognized document extensions even when served as octet-stream", async () => {
    const dir = await tmpDir();
    const cases = [
      { url: "https://example.com/exports/budget.xlsx", fileName: "budget.xlsx" },
      { url: "https://example.com/exports/slides.pptx", fileName: "slides.pptx" },
    ] as const;

    const originalFetch = globalThis.fetch;

    try {
      for (const testCase of cases) {
        const bytes = Buffer.from(`bytes:${testCase.fileName}`);
        globalThis.fetch = mock(async () => {
          return new Response(bytes, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }) as any;

        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({ url: testCase.url, maxLength: 50000 });
        const downloadedPath = path.join(dir, "Downloads", testCase.fileName);

        expect(out).toBe(`File downloaded ${downloadedPath}`);
        expect(await fs.readFile(downloadedPath)).toEqual(bytes);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads markdown attachments when octet-stream filenames come from content-disposition", async () => {
    const dir = await tmpDir();
    const cases = ["README.md", "release-notes.markdown"] as const;

    const originalFetch = globalThis.fetch;

    try {
      for (const fileName of cases) {
        const bytes = Buffer.from(`bytes:${fileName}`);
        globalThis.fetch = mock(async () => {
          return new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${fileName}"`,
            },
          });
        }) as any;

        const t: any = createWebFetchTool(makeCtx(dir));
        const out: string = await t.execute({ url: "https://example.com/download", maxLength: 50000 });
        const downloadedPath = path.join(dir, "Downloads", fileName);

        expect(out).toBe(`File downloaded ${downloadedPath}`);
        expect(await fs.readFile(downloadedPath)).toEqual(bytes);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("normalizes downloaded document filenames to the classified MIME type", async () => {
    const dir = await tmpDir();
    const pdfBytes = Buffer.from("%PDF-1.7\nmismatch\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(pdfBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="report.txt"',
        },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com/download", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "report.pdf");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(pdfBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("avoids overwriting an existing download by suffixing the filename", async () => {
    const dir = await tmpDir();
    let requestCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      requestCount += 1;
      return new Response(Buffer.from(`pdf-${requestCount}`), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const first = await t.execute({ url: "https://example.com/report.pdf", maxLength: 50000 });
      const second = await t.execute({ url: "https://example.com/report.pdf", maxLength: 50000 });

      expect(first).toBe(`File downloaded ${path.join(dir, "Downloads", "report.pdf")}`);
      expect(second).toBe(`File downloaded ${path.join(dir, "Downloads", "report-2.pdf")}`);
      expect(await fs.readFile(path.join(dir, "Downloads", "report.pdf"), "utf-8")).toBe("pdf-1");
      expect(await fs.readFile(path.join(dir, "Downloads", "report-2.pdf"), "utf-8")).toBe("pdf-2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries download finalization when the first destination appears during finalize", async () => {
    const dir = await tmpDir();
    const downloadDir = path.join(dir, "Downloads");
    const tempPath = path.join(downloadDir, "report.pdf.part");
    await fs.mkdir(downloadDir, { recursive: true });
    await fs.writeFile(tempPath, "fresh payload", "utf-8");

    const originalCopyFile = fs.copyFile;
    let firstAttempt = true;
    (fs as typeof fs & { copyFile: typeof fs.copyFile }).copyFile = mock(
      async (source: string | Buffer | URL, destination: string | Buffer | URL, mode?: number) => {
        if (firstAttempt && String(destination) === path.join(downloadDir, "report.pdf")) {
          firstAttempt = false;
          await fs.writeFile(path.join(downloadDir, "report.pdf"), "existing payload", "utf-8");
          const error = new Error("exists") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }
        return await originalCopyFile(source, destination, mode);
      },
    );

    try {
      const finalPath = await webFetchInternal.finalizeDownloadedFile(tempPath, downloadDir, "report.pdf");
      expect(finalPath).toBe(path.join(downloadDir, "report-2.pdf"));
      expect(await fs.readFile(path.join(downloadDir, "report.pdf"), "utf-8")).toBe("existing payload");
      expect(await fs.readFile(finalPath, "utf-8")).toBe("fresh payload");
      await expect(fs.stat(tempPath)).rejects.toThrow();
    } finally {
      (fs as typeof fs & { copyFile: typeof fs.copyFile }).copyFile = originalCopyFile;
    }
  });

  test("rejects non-text content types", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response("binary", {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/file.bin", maxLength: 50000 })
      ).rejects.toThrow(/non-text content type/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads direct image URLs into the workspace Downloads folder", async () => {
    const dir = await tmpDir();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(Buffer.from(pngBase64, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out = await t.execute({ url: "https://example.com/chart.png", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "chart.png");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(Buffer.from(pngBase64, "base64"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads direct image URLs when served as octet-stream", async () => {
    const dir = await tmpDir();
    const jpegBase64 = Buffer.from("fake-jpeg-bytes").toString("base64");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(Buffer.from(jpegBase64, "base64"), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out = await t.execute({ url: "https://example.com/photo.jpg", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "photo.jpg");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(Buffer.from(jpegBase64, "base64"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloads octet-stream image attachments using content-disposition filenames", async () => {
    const dir = await tmpDir();
    const jpegBytes = Buffer.from("attachment-jpeg");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(jpegBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="photo.jpg"',
        },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out = await t.execute({ url: "https://example.com/download?id=1", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "photo.jpg");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(jpegBytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("adds a MIME-derived extension when downloading image URLs without one", async () => {
    const dir = await tmpDir();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(Buffer.from(pngBase64, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out = await t.execute({ url: "https://example.com/download/image", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "image.png");

      expect(out).toBe(`File downloaded ${downloadedPath}`);
      expect(await fs.readFile(downloadedPath)).toEqual(Buffer.from(pngBase64, "base64"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("downloaded images can be inspected via read", async () => {
    const dir = await tmpDir();
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(Buffer.from(pngBase64, "base64"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as any;

    try {
      const webFetchTool: any = createWebFetchTool(makeCtx(dir));
      const out = await webFetchTool.execute({ url: "https://example.com/preview.png", maxLength: 50000 });
      const downloadedPath = path.join(dir, "Downloads", "preview.png");
      expect(out).toBe(`File downloaded ${downloadedPath}`);

      const readTool: any = createReadTool(makeCtx(dir));
      const readOut = await readTool.execute({ filePath: downloadedPath, limit: 2000 });
      expect(readOut).toEqual({
        type: "content",
        content: [
          { type: "text", text: "Image file: preview.png" },
          { type: "image", data: pngBase64, mimeType: "image/png" },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses the canonical redirected URL for Exa enrichment", async () => {
    const dir = await tmpDir();
    const oldExa = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa_test_key";
    let requestCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const fetchUrl = toFetchUrl(input);
      if (fetchUrl.includes("api.exa.ai/contents")) {
        const body = JSON.parse(String(init?.body));
        expect(body.urls).toEqual(["https://example.com/final"]);
        return new Response(
          JSON.stringify({ results: [{ url: "https://example.com/final", text: "Redirected content" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      requestCount += 1;
      if (requestCount === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/final" },
        });
      }

      return new Response("<html><body><article><h1>Redirected page</h1><p>Final local HTML.</p></article></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/start", maxLength: 50000 })
      ).resolves.toContain("Redirected page");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("DNS-pinning: initial fetch is called with an IP-addressed URL", async () => {
    const dir = await tmpDir();

    // Set up DNS mock to return a known public IP
    const { __internal: webSafetyInternal } = await import("../src/utils/webSafety");
    webSafetyInternal.setDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);

    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const fetchUrl = toFetchUrl(input);
      fetchCalls.push(fetchUrl);
      return new Response("<html><body><article><p>Pinned locally</p></article></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await t.execute({ url: "https://example.com/page", maxLength: 50000 });

      // The fetch should have been called with an IP address instead of the hostname
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
      const calledUrl = fetchCalls[0];
      expect(calledUrl).toContain("93.184.216.34");
      expect(calledUrl).not.toContain("example.com");
    } finally {
      globalThis.fetch = originalFetch;
      webSafetyInternal.resetDnsLookup();
    }
  });

  test("throws on non-2xx HTTP responses", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/missing", maxLength: 50000 })
      ).rejects.toThrow(/webFetch failed: 404/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("times out when no initial response arrives", async () => {
    const dir = await tmpDir();

    webFetchInternal.setResponseTimeoutMs(25);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("fetch aborted")),
          { once: true },
        );
      });
    }) as typeof fetch;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      await expect(
        t.execute({ url: "https://example.com/hangs", maxLength: 50000 })
      ).rejects.toThrow(/timed out waiting for an initial response after 25ms/i);
    } finally {
      globalThis.fetch = originalFetch;
      webFetchInternal.setResponseTimeoutMs(5_000);
    }
  });

});

// ---------------------------------------------------------------------------
// ask tool
// ---------------------------------------------------------------------------

describe("ask tool", () => {
  test("exports a provider-compatible top-level object input schema", async () => {
    const dir = await tmpDir();
    const t: any = createAskTool(makeCtx(dir));
    const schema = z.toJSONSchema(t.inputSchema) as Record<string, unknown>;

    expect(schema.type).toBe("object");
  });

  test("calls askUser with question", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (q: string) => "user answer");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({ question: "What color?" });
    expect(askFn).toHaveBeenCalledWith("What color?", undefined);
    expect(res).toBe("user answer");
  });

  test("returns user's answer", async () => {
    const dir = await tmpDir();
    const ctx = makeCtx(dir);
    ctx.askUser = async () => "42";

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({ question: "How many?" });
    expect(res).toBe("42");
  });

  test("rejects empty single-question prompt", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (_q: string) => "unused");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    await expect(t.execute({ question: "" })).rejects.toThrow();
    expect(askFn).not.toHaveBeenCalled();
  });

  test("rejects whitespace-only structured question prompt", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (_q: string) => "unused");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    await expect(
      t.execute({
        questions: [{ question: "   " }],
      })
    ).rejects.toThrow();
    expect(askFn).not.toHaveBeenCalled();
  });

  test("passes options when provided", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (q: string, opts?: string[]) => "option B");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({
      question: "Pick one:",
      options: ["option A", "option B", "option C"],
    });
    expect(askFn).toHaveBeenCalledWith("Pick one:", ["option A", "option B", "option C"]);
    expect(res).toBe("option B");
  });

  test("handles empty string answer", async () => {
    const dir = await tmpDir();
    const ctx = makeCtx(dir);
    ctx.askUser = async () => "";

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({ question: "Anything?" });
    expect(res).toBe("");
  });

  test("handles long answer", async () => {
    const dir = await tmpDir();
    const longAnswer = "a".repeat(5000);
    const ctx = makeCtx(dir);
    ctx.askUser = async () => longAnswer;

    const t: any = createAskTool(ctx);
    const res: string = await t.execute({ question: "Tell me everything" });
    expect(res).toBe(longAnswer);
  });

  test("supports AskUserQuestion structured payloads", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (_q: string, _opts?: string[]) => "Organize & tidy");
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    const res: any = await t.execute({
      questions: [
        {
          question: "What kind of cleanup are you looking for?",
          header: "Cleanup scope",
          options: [
            { label: "Delete everything", description: "Remove all files" },
            { label: "Organize & tidy", description: "Keep files, improve layout" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(askFn).toHaveBeenCalledWith("What kind of cleanup are you looking for?", [
      "Delete everything",
      "Organize & tidy",
    ]);
    expect(res.answers).toEqual({
      "What kind of cleanup are you looking for?": "Organize & tidy",
    });
    expect(Array.isArray(res.questions)).toBeTrue();
  });

  test("asks each structured question in sequence", async () => {
    const dir = await tmpDir();
    const askFn = mock(async (q: string) => (q.includes("first") ? "A" : "B"));
    const ctx = makeCtx(dir);
    ctx.askUser = askFn;

    const t: any = createAskTool(ctx);
    const res: any = await t.execute({
      questions: [
        {
          question: "Pick first option?",
          header: "Q1",
          options: [
            { label: "A", description: "A" },
            { label: "B", description: "B" },
          ],
          multiSelect: false,
        },
        {
          question: "Pick second option?",
          header: "Q2",
          options: [
            { label: "A", description: "A" },
            { label: "B", description: "B" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(askFn).toHaveBeenCalledTimes(2);
    expect(res.answers).toEqual({
      "Pick first option?": "A",
      "Pick second option?": "B",
    });
  });
});

// ---------------------------------------------------------------------------
// todoWrite tool
// ---------------------------------------------------------------------------

describe("todoWrite tool", () => {
  test("updates todo state and returns summary", async () => {
    const dir = await tmpDir();
    const t: any = createTodoWriteTool(makeCtx(dir));
    const todos = [
      { content: "Do thing", status: "in_progress" as const, activeForm: "Doing thing" },
      { content: "Other task", status: "pending" as const, activeForm: "Other tasking" },
    ];

    const res: string = await t.execute({ todos });
    expect(res).toContain("Todo list updated");
    expect(res).toContain("[in_progress] Do thing");
    expect(res).toContain("[pending] Other task");
  });

  test("calls updateTodos callback when provided", async () => {
    const dir = await tmpDir();
    const updateFn = mock((_todos: any) => { });
    const ctx = makeCtx(dir);
    ctx.updateTodos = updateFn;

    const t: any = createTodoWriteTool(ctx);
    const todos = [
      { content: "Step 1", status: "completed" as const, activeForm: "Stepping" },
    ];
    await t.execute({ todos });
    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(updateFn).toHaveBeenCalledWith(todos);
  });

  test("handles empty todo list", async () => {
    const dir = await tmpDir();
    const t: any = createTodoWriteTool(makeCtx(dir));
    const res: string = await t.execute({ todos: [] });
    expect(res).toContain("Todo list updated");
  });

  test("handles all status types", async () => {
    const dir = await tmpDir();
    const t: any = createTodoWriteTool(makeCtx(dir));
    const todos = [
      { content: "A", status: "pending" as const, activeForm: "Doing A" },
      { content: "B", status: "in_progress" as const, activeForm: "Doing B" },
      { content: "C", status: "completed" as const, activeForm: "Doing C" },
    ];
    const res: string = await t.execute({ todos });
    expect(res).toContain("[pending] A");
    expect(res).toContain("[in_progress] B");
    expect(res).toContain("[completed] C");
  });

  test("overwrites previous todos completely", async () => {
    const dir = await tmpDir();
    const t: any = createTodoWriteTool(makeCtx(dir));

    // First call
    await t.execute({
      todos: [
        { content: "Old task", status: "pending" as const, activeForm: "Old tasking" },
      ],
    });

    // Second call with different todos
    const res: string = await t.execute({
      todos: [
        { content: "New task", status: "in_progress" as const, activeForm: "New tasking" },
      ],
    });
    expect(res).toContain("[in_progress] New task");
    expect(res).not.toContain("Old task");
  });
});

// ---------------------------------------------------------------------------
// notebookEdit tool
// ---------------------------------------------------------------------------

describe("notebookEdit tool", () => {
  function makeNotebook(cells: Array<{ cell_type: string; source: string[] | string }>) {
    return JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 2,
        metadata: {},
        cells: cells.map((c) => ({
          cell_type: c.cell_type,
          source: c.source,
          metadata: {},
          ...(c.cell_type === "code" ? { outputs: [], execution_count: null } : {}),
        })),
      },
      null,
      1
    );
  }

  test("replaces cell source", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([
        { cell_type: "code", source: ["print('old')\n"] },
        { cell_type: "markdown", source: ["# Title\n"] },
      ])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    const res: string = await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "print('new')",
      editMode: "replace",
    });
    expect(res).toContain("replace");

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells[0].source).toEqual(["print('new')"]);
  });

  test("accepts string-form notebook cell sources", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([
        { cell_type: "code", source: "print('old')" },
        { cell_type: "markdown", source: ["# Title\n"] },
      ])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "print('new')",
      editMode: "replace",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells[0].source).toEqual(["print('new')"]);
  });

  test("inserts new cell", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    const res: string = await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "# Inserted cell",
      cellType: "markdown",
      editMode: "insert",
    });
    expect(res).toContain("insert");

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[0].cell_type).toBe("markdown");
    expect(nb.cells[0].source).toEqual(["# Inserted cell"]);
  });

  test("deletes cell", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([
        { cell_type: "code", source: ["a = 1\n"] },
        { cell_type: "code", source: ["b = 2\n"] },
        { cell_type: "code", source: ["c = 3\n"] },
      ])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    const res: string = await t.execute({
      notebookPath: p,
      cellIndex: 1,
      newSource: "",
      editMode: "delete",
    });
    expect(res).toContain("delete");

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[1].source).toEqual(["c = 3\n"]);
  });

  test("throws on index out of range for replace", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: p,
        cellIndex: 5,
        newSource: "won't work",
        editMode: "replace",
      })
    ).rejects.toThrow(/out of range/);
  });

  test("rejects non-.ipynb file paths", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "notebook.json");
    await fs.writeFile(
      p,
      makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: p,
        cellIndex: 0,
        newSource: "x = 2",
        editMode: "replace",
      })
    ).rejects.toThrow(/expected a \.ipynb file/i);
  });

  test("rejects invalid notebook JSON", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(p, "{ not-valid-json", "utf-8");

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: p,
        cellIndex: 0,
        newSource: "x = 2",
        editMode: "replace",
      })
    ).rejects.toThrow(/Invalid notebook JSON/);
  });

  test("rejects path outside allowed dirs", async () => {
    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const p = path.join(outsideDir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: p,
        cellIndex: 0,
        newSource: "nope",
        editMode: "replace",
      })
    ).rejects.toThrow(/blocked/i);
  });

  test("rejects notebook edits through symlink segment", async () => {
    if (process.platform === "win32") return;

    const dir = await tmpDir();
    const outsideDir = await tmpDir();
    const outsideNotebook = path.join(outsideDir, "outside.ipynb");
    await fs.writeFile(
      outsideNotebook,
      makeNotebook([{ cell_type: "code", source: ["print('x')\n"] }])
    );

    const link = path.join(dir, "outside-link");
    await fs.symlink(outsideDir, link);

    const t: any = createNotebookEditTool(makeCtx(dir));
    await expect(
      t.execute({
        notebookPath: path.join(link, "outside.ipynb"),
        cellIndex: 0,
        newSource: "print('nope')",
        editMode: "replace",
      })
    ).rejects.toThrow(/blocked/i);
  });

  test("insert creates code cell by default", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 1,
      newSource: "y = 2",
      editMode: "insert",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[1].cell_type).toBe("code");
    expect(nb.cells[1].outputs).toEqual([]);
    expect(nb.cells[1].execution_count).toBeNull();
  });

  test("replaces cell type when cellType is provided in replace mode", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([{ cell_type: "code", source: ["x = 1\n"] }])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "# Now markdown",
      cellType: "markdown",
      editMode: "replace",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.cells[0].cell_type).toBe("markdown");
  });

  test("splits newSource into lines correctly", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    await fs.writeFile(
      p,
      makeNotebook([{ cell_type: "code", source: ["old\n"] }])
    );

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "line1\nline2\nline3",
      editMode: "replace",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    // Source lines should have \n except last
    expect(nb.cells[0].source).toEqual(["line1\n", "line2\n", "line3"]);
  });

  test("preserves notebook metadata on edit", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "nb.ipynb");
    const original = {
      nbformat: 4,
      nbformat_minor: 2,
      metadata: { kernelspec: { name: "python3" } },
      cells: [
        {
          cell_type: "code",
          source: ["x = 1\n"],
          metadata: {},
          outputs: [],
          execution_count: null,
        },
      ],
    };
    await fs.writeFile(p, JSON.stringify(original, null, 1));

    const t: any = createNotebookEditTool(makeCtx(dir));
    await t.execute({
      notebookPath: p,
      cellIndex: 0,
      newSource: "x = 2",
      editMode: "replace",
    });

    const nb = JSON.parse(await fs.readFile(p, "utf-8"));
    expect(nb.metadata.kernelspec.name).toBe("python3");
    expect(nb.nbformat).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// skill tool
// ---------------------------------------------------------------------------

describe("skill tool", () => {
  function skillDoc(name: string, description: string, body: string): string {
    return ["---", `name: \"${name}\"`, `description: \"${description}\"`, "---", "", body].join("\n");
  }

  test("loads skill from SKILL.md in directory", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills", "xlsx");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("xlsx", "Spreadsheet helper skill.", "# XLSX Skill\nInstructions here."),
      "utf-8"
    );

    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills")];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "xlsx" });
    expect(res).toContain("XLSX Skill");
    expect(res).toContain("Instructions here.");
  });

  test("does not load non-spec flat file layout", async () => {
    const dir = await tmpDir();
    const skillsDir = path.join(dir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "pdf.md"), "# PDF Skill Content", "utf-8");

    const config = makeConfig(dir);
    config.skillsDirs = [skillsDir];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "pdf" });
    expect(res).toContain("not found");
  });

  test("returns 'not found' for missing skill", async () => {
    const dir = await tmpDir();
    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills")];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "nonexistent" });
    expect(res).toContain("not found");
  });

  test("reloads modified skill content when file changes", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills-cache-test", "cached-skill-unique");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("cached-skill-unique", "Cached skill.", "Cached content"),
      "utf-8"
    );

    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills-cache-test")];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    // First call reads from disk
    const res1: string = await t.execute({ skillName: "cached-skill-unique" });
    expect(res1).toBe("Cached content");

    // Modify the file on disk
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("cached-skill-unique", "Cached skill.", "Modified content"),
      "utf-8"
    );

    // Second call should reflect updated on-disk content.
    const res2: string = await t.execute({ skillName: "cached-skill-unique" });
    expect(res2).toBe("Modified content");
  });

  test("searches multiple skillsDirs in order", async () => {
    const dir = await tmpDir();
    const dir1 = path.join(dir, "s1-order-test");
    const dir2 = path.join(dir, "s2-order-test");
    await fs.mkdir(path.join(dir1, "myskill-order"), { recursive: true });
    await fs.mkdir(path.join(dir2, "myskill-order"), { recursive: true });
    await fs.writeFile(
      path.join(dir1, "myskill-order", "SKILL.md"),
      skillDoc("myskill-order", "First version.", "First dir"),
      "utf-8"
    );
    await fs.writeFile(
      path.join(dir2, "myskill-order", "SKILL.md"),
      skillDoc("myskill-order", "Second version.", "Second dir"),
      "utf-8"
    );

    const config = makeConfig(dir);
    config.skillsDirs = [dir1, dir2];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "myskill-order" });
    expect(res).toBe("First dir");
  });

  test("appends deck-workspace hygiene guidance to slides skill loads", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills", "slides");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      skillDoc("slides", "Slides helper skill.", "# Slides Skill\nBuild decks here."),
      "utf-8"
    );

    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills")];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "slides" });
    expect(res).toContain("Build decks here.");
    expect(res).toContain("## Cowork Addendum");
    expect(res).toContain("do not create `package.json`, lockfiles, or `node_modules`");
    expect(res).toContain("shared Cowork cache");
  });

  test("loads built-in slides when project/global/user skill dirs are empty", async () => {
    const dir = await tmpDir();
    const projectSkills = path.join(dir, "project-skills");
    const globalSkills = path.join(dir, "global-skills");
    const userSkills = path.join(dir, "user-skills");
    const builtInSkills = path.join(dir, "built-in-skills");
    await fs.mkdir(projectSkills, { recursive: true });
    await fs.mkdir(globalSkills, { recursive: true });
    await fs.mkdir(userSkills, { recursive: true });
    await fs.mkdir(path.join(builtInSkills, "slides"), { recursive: true });
    await fs.writeFile(
      path.join(builtInSkills, "slides", "SKILL.md"),
      skillDoc("slides", "Built-in slides skill.", "# Slides Skill\nBuilt-in deck workflow."),
      "utf-8"
    );

    const config = makeConfig(dir, {
      skillsDirs: [projectSkills, globalSkills, userSkills, builtInSkills],
    });
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "slides" });
    expect(res).toContain("Built-in deck workflow.");
    expect(res).toContain("## Cowork Addendum");
  });

  test("returns not found when skillsDirs is empty", async () => {
    const dir = await tmpDir();
    const config = makeConfig(dir);
    config.skillsDirs = [];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "anything" });
    expect(res).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// memory tool
// ---------------------------------------------------------------------------

describe("memory tool", () => {
  test("imports AGENT.md into sqlite memory on read", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "AGENT.md"), "# Hot cache content", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toContain("Hot cache content");
  });

  test("reads imported AGENT.md using hot-cache aliases", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "AGENT.md"), "Hot via AGENT.md key", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    expect(await t.execute({ action: "read", key: "hot" })).toBe("Hot via AGENT.md key");
    expect(await t.execute({ action: "read", key: "AGENT.md" })).toBe("Hot via AGENT.md key");
  });

  test("returns no hot cache when store is empty", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toBe("No hot cache found.");
  });

  test("writes named memory key", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({
      action: "write",
      key: "people/sarah",
      content: "Sarah is a developer.",
    });
    expect(res).toContain("Memory written");

    const readBack: string = await t.execute({ action: "read", key: "people/sarah" });
    expect(readBack).toBe("Sarah is a developer.");
  });

  test("reads named memory key with .md extension", async () => {
    const dir = await tmpDir();
    const memDir = path.join(dir, ".agent", "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "notes.md"), "My notes", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "notes.md" });
    expect(res).toBe("My notes");
  });

  test("returns not found for missing memory key", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "missing" });
    expect(res).toContain("not found");
  });

  test("returns no hot cache found for missing AGENT.md alias", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "AGENT.md" });
    expect(res).toBe("No hot cache found.");
  });

  test("rejects write when content is missing", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await expect(t.execute({ action: "write", key: "test" })).rejects.toThrow(
      /content is required/
    );
  });

  test("searches sqlite-backed memory entries", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await t.execute({ action: "write", key: "stack", content: "The project uses TypeScript and Bun runtime." });

    const res: string = await t.execute({ action: "search", query: "TypeScript" });
    expect(res).toContain("TypeScript");
  });

  test("search returns no memory found when nothing matches", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({
      action: "search",
      query: "zzz_impossible_query_zzz",
    });
    expect(res).toContain("No memory found");
  });

  test("search throws when query is missing", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await expect(t.execute({ action: "search" })).rejects.toThrow(/query is required/);
  });

  test("delete removes saved memory", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await t.execute({ action: "write", key: "temp", content: "temporary" });
    const delRes: string = await t.execute({ action: "delete", key: "temp" });
    expect(delRes).toContain("deleted");
    const readRes: string = await t.execute({ action: "read", key: "temp" });
    expect(readRes).toContain("not found");
  });

  test("reads from user agent dir as fallback via legacy import", async () => {
    const dir = await tmpDir();
    const userAgentDir = path.join(dir, ".agent-user");
    await fs.mkdir(userAgentDir, { recursive: true });
    await fs.writeFile(path.join(userAgentDir, "AGENT.md"), "User-level hot cache", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toContain("User-level hot cache");
  });

  test("write without key updates the hot cache", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));

    await t.execute({ action: "write", content: "First hot cache entry" });
    await t.execute({ action: "write", content: "Second hot cache entry" });

    const res: string = await t.execute({ action: "read" });
    expect(res).not.toContain("First hot cache entry");
    expect(res).toContain("Second hot cache entry");
  });

  test("write with AGENT.md alias updates the hot cache", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));

    await t.execute({ action: "write", key: "AGENT.md", content: "Alias hot cache entry" });

    const res: string = await t.execute({ action: "read", key: "hot" });
    expect(res).toBe("Alias hot cache entry");
  });

  test("returns disabled message when enableMemory is false", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir, { config: makeConfig(dir, { enableMemory: false }) }));
    const res: string = await t.execute({ action: "read" });
    expect(res).toContain("disabled");
  });

  test("prompts for approval when memoryRequireApproval is true and approves", async () => {
    const dir = await tmpDir();
    let prompted = false;
    const t: any = createMemoryTool(
      makeCtx(dir, {
        config: makeConfig(dir, { memoryRequireApproval: true }),
        askUser: async () => {
          prompted = true;
          return "approve";
        },
      })
    );
    const res: string = await t.execute({ action: "write", key: "pref", content: "Dark mode" });
    expect(prompted).toBe(true);
    expect(res).toContain("Memory written");
  });

  test("denies write when memoryRequireApproval is true and user denies", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(
      makeCtx(dir, {
        config: makeConfig(dir, { memoryRequireApproval: true }),
        askUser: async () => "deny",
      })
    );
    const res: string = await t.execute({ action: "write", key: "pref", content: "Light mode" });
    expect(res).toContain("denied");
  });

  test("legacy import deduplicates files normalizing to the same id", async () => {
    const dir = await tmpDir();
    const memDir = path.join(dir, ".agent", "memory");
    await fs.mkdir(memDir, { recursive: true });
    // Both normalize to "foo-bar"
    await fs.writeFile(path.join(memDir, "foo bar.md"), "First content", "utf-8");
    await fs.writeFile(path.join(memDir, "foo-bar.md"), "Second content", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    // Should not throw SQLITE_CONSTRAINT_PRIMARYKEY
    const res: string = await t.execute({ action: "read", key: "foo-bar" });
    expect(["First content", "Second content"]).toContain(res);
  });
});

// ---------------------------------------------------------------------------
// createTools (index)
// ---------------------------------------------------------------------------

describe("createTools", () => {
  test("returns base tool names when child-agent control is unavailable", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    const expected = [
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "webSearch",
      "webFetch",
      "ask",
      "AskUserQuestion",
      "todoWrite",
      "notebookEdit",
      "skill",
      "memory",
      "usage",
    ];
    for (const name of expected) {
      expect(tools).toHaveProperty(name);
    }
  });

  test("returns exactly 15 tools without child-agent control", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(Object.keys(tools).length).toBe(15);
  });

  test("hides legacy webSearch for codex-cli by default", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "codex-cli",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        }),
      }),
    );

    expect(tools).not.toHaveProperty("webSearch");
    expect(tools).toHaveProperty("webFetch");
  });

  test("keeps legacy webSearch for codex-cli when exa is selected", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "codex-cli",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
          providerOptions: {
            "codex-cli": {
              webSearchBackend: "exa",
            },
          },
        }),
      }),
    );

    expect(tools).toHaveProperty("webSearch");
  });

  test("replaces local webSearch but keeps webFetch for google when native web tools are enabled", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
          providerOptions: {
            google: {
              nativeWebSearch: true,
            },
          },
        }),
      }),
    );

    expect(tools).not.toHaveProperty("webSearch");
    expect(tools).toHaveProperty("webFetch");
  });

  test("keeps local webSearch and webFetch for google when native web search is disabled", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
        }),
      }),
    );

    expect(tools).toHaveProperty("webSearch");
    expect(tools).toHaveProperty("webFetch");
  });

  test("omits memory tool when enableMemory is false", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir, { config: makeConfig(dir, { enableMemory: false }) }));
    expect(tools).not.toHaveProperty("memory");
    expect(Object.keys(tools).length).toBe(14);
  });

  test("listSessionToolNames includes root-session agent controls when requested", () => {
    const names = listSessionToolNames({
      provider: "google",
      providerOptions: {
        google: {
          nativeWebSearch: true,
        },
      },
      enableMemory: false,
    }, { includeAgentControl: true });

    expect(names).toEqual(expect.arrayContaining([
      "spawnAgent",
      "listAgents",
      "sendAgentInput",
      "waitForAgent",
      "resumeAgent",
      "closeAgent",
    ]));
    expect(names).not.toContain("memory");
    expect(names).not.toContain("webSearch");
  });

  test("omits child-agent lifecycle tools when child-agent control is unavailable", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(tools).not.toHaveProperty("spawnAgent");
    expect(tools).not.toHaveProperty("listAgents");
    expect(tools).not.toHaveProperty("sendAgentInput");
    expect(tools).not.toHaveProperty("waitForAgent");
    expect(tools).not.toHaveProperty("resumeAgent");
    expect(tools).not.toHaveProperty("closeAgent");
  });

  test("returns an executable webSearch tool for opencode-go", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "opencode-go",
          model: "glm-5",
          preferredChildModel: "glm-5",
        }),
      })
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("returns an executable webSearch tool for baseten", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "baseten",
          model: "moonshotai/Kimi-K2.5",
          preferredChildModel: "moonshotai/Kimi-K2.5",
        }),
      })
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("returns an executable webSearch tool for together", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "together",
          model: "moonshotai/Kimi-K2.5",
          preferredChildModel: "moonshotai/Kimi-K2.5",
        }),
      })
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("returns an executable webSearch tool for nvidia", async () => {
    const dir = await tmpDir();
    const tools = createTools(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "nvidia",
          model: "nvidia/nemotron-3-super-120b-a12b",
          preferredChildModel: "nvidia/nemotron-3-super-120b-a12b",
        }),
      })
    );

    expect((tools.webSearch as any).type).toBeUndefined();
    expect(typeof (tools.webSearch as any).execute).toBe("function");
    expect((tools.webSearch as any).description).toContain("EXA_API_KEY");
  });

  test("each tool is executable or provider-native", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    for (const [name, tool] of Object.entries(tools)) {
      if (name === "webSearch") {
        expect((tool as any).type === "provider" || typeof (tool as any).execute === "function").toBe(true);
        continue;
      }
      expect(typeof (tool as any).execute).toBe("function");
    }
  });

  test("does not include unknown tool names", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(tools).not.toHaveProperty("unknown");
    expect(tools).not.toHaveProperty("foo");
  });

  test("exposes persistent agent tools when control handlers exist", async () => {
    const dir = await tmpDir();
    const spawn = mock(async () => ({
      agentId: "child",
      parentSessionId: "root",
      role: "worker" as const,
      mode: "collaborative" as const,
      depth: 1,
      effectiveModel: "gpt-5.2",
      provider: "openai" as const,
      title: "child",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lifecycleState: "active" as const,
      executionState: "running" as const,
      busy: true,
    }));
    const list = mock(async () => [
      {
        agentId: "child",
        parentSessionId: "root",
        role: "worker" as const,
        mode: "collaborative" as const,
        depth: 1,
        effectiveModel: "gpt-5.2",
        provider: "openai" as const,
        title: "child",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        lifecycleState: "closed" as const,
        executionState: "idle" as const,
        busy: false,
      },
    ]);
    const sendInput = mock(async () => ({ queued: true }));
    const wait = mock(async () => ({
      timedOut: false,
      agents: [
        {
          agentId: "child",
          parentSessionId: "root",
          role: "worker" as const,
          mode: "collaborative" as const,
          depth: 1,
          effectiveModel: "gpt-5.2",
          provider: "openai" as const,
          title: "child",
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          lifecycleState: "active" as const,
          executionState: "completed" as const,
          busy: false,
          lastMessagePreview: "done",
        },
      ],
    }));
    const resume = mock(async () => ({
      agentId: "child",
      parentSessionId: "root",
      role: "worker" as const,
      mode: "collaborative" as const,
      depth: 1,
      effectiveModel: "gpt-5.2",
      provider: "openai" as const,
      title: "child",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lifecycleState: "active" as const,
      executionState: "idle" as const,
      busy: false,
    }));
    const close = mock(async () => ({
      agentId: "child",
      parentSessionId: "root",
      role: "worker" as const,
      mode: "collaborative" as const,
      depth: 1,
      effectiveModel: "gpt-5.2",
      provider: "openai" as const,
      title: "child",
      createdAt: "2026-03-08T00:00:00.000Z",
      updatedAt: "2026-03-08T00:00:00.000Z",
      lifecycleState: "closed" as const,
      executionState: "idle" as const,
      busy: false,
    }));

    const ctx = makeCtx(dir, {
      agentControl: {
        spawn,
        list,
        sendInput,
        wait,
        resume,
        close,
      },
    });
    const tools = createTools(ctx);

    expect(tools.spawnAgent).toBeDefined();
    const spawnTool: any = tools.spawnAgent;
    const listTool: any = tools.listAgents;
    const sendTool: any = tools.sendAgentInput;
    const waitTool: any = tools.waitForAgent;
    const resumeTool: any = tools.resumeAgent;
    const closeTool: any = tools.closeAgent;

    await expect(spawnTool.execute({ message: "Inspect" })).resolves.toMatchObject({ agentId: "child" });
    expect(spawn).toHaveBeenCalled();

    await expect(listTool.execute({})).resolves.toHaveLength(1);
    await expect(sendTool.execute({ agentId: "child", message: "next" })).resolves.toEqual({
      agentId: "child",
      queued: true,
    });
    await expect(waitTool.execute({ agentIds: ["child"], timeoutMs: 10 })).resolves.toEqual({
      timedOut: false,
      agents: [
        expect.objectContaining({
          agentId: "child",
          executionState: "completed",
          busy: false,
          lastMessagePreview: "done",
        }),
      ],
    });
    await expect(resumeTool.execute({ agentId: "child" })).resolves.toMatchObject({
      agentId: "child",
      lifecycleState: "active",
    });
    await expect(closeTool.execute({ agentId: "child" })).resolves.toMatchObject({
      agentId: "child",
      lifecycleState: "closed",
    });
  });
});
