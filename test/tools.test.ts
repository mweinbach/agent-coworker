import { describe, expect, test, mock, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../src/types";
import type { ToolContext } from "../src/tools/context";

import { createReadTool } from "../src/tools/read";
import { createWriteTool } from "../src/tools/write";
import { createEditTool } from "../src/tools/edit";
import { createBashTool } from "../src/tools/bash";
import { createGlobTool } from "../src/tools/glob";
import { createGrepTool } from "../src/tools/grep";
import { createWebSearchTool } from "../src/tools/webSearch";
import { createWebFetchTool } from "../src/tools/webFetch";
import { createAskTool } from "../src/tools/ask";
import { createTodoWriteTool, currentTodos, onTodoChange } from "../src/tools/todoWrite";
import { createNotebookEditTool } from "../src/tools/notebookEdit";
import { createSkillTool } from "../src/tools/skill";
import { createMemoryTool } from "../src/tools/memory";
import { createTools } from "../src/tools/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(dir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    subAgentModel: "gemini-3-flash-preview",
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
  test("executes simple command and returns stdout", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({ command: "echo hello", timeout: 5000 });
    expect(res.stdout.trim()).toBe("hello");
    expect(res.exitCode).toBe(0);
  });

  test("returns exit code on failure", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({ command: "exit 42", timeout: 5000 });
    expect(res.exitCode).not.toBe(0);
  });

  test("calls approveCommand before execution", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true);
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;

    const t: any = createBashTool(ctx);
    await t.execute({ command: "echo test", timeout: 5000 });
    expect(approveFn).toHaveBeenCalledWith("echo test");
  });

  test("returns rejection when command not approved", async () => {
    const dir = await tmpDir();
    const ctx = makeCtx(dir);
    ctx.approveCommand = async () => false;

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "echo secret", timeout: 5000 });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("rejected");
  });

  test("handles stderr output", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({
      command: `bun -e "console.error('error')"`,
      timeout: 5000,
    });
    expect(res.stderr.trim()).toBe("error");
  });

  test("uses workingDirectory as cwd", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({ command: `bun -e "console.log(process.cwd())"`, timeout: 5000 });
    // Resolve symlinks for macOS /private/var/... vs /var/...
    const normalizedStdout = await fs.realpath(res.stdout.trim());
    const normalizedDir = await fs.realpath(dir);
    expect(normalizedStdout).toBe(normalizedDir);
  });

  test("truncates large stdout", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({
      command: `bun -e "process.stdout.write('x'.repeat(50000))"`,
      timeout: 15000,
    });
    expect(res.stdout.length).toBeLessThanOrEqual(30000);
  });

  test("returns stdout and stderr together", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({
      command: `bun -e "console.log('out'); console.error('err')"`,
      timeout: 5000,
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
    await t.execute({ command: `touch "${p}"`, timeout: 5000 });
    // File should not have been created since command was rejected
    await expect(fs.access(p)).rejects.toThrow();
  });

  test("returns empty stdout on rejected command", async () => {
    const dir = await tmpDir();
    const ctx = makeCtx(dir);
    ctx.approveCommand = async () => false;

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "echo should not see", timeout: 5000 });
    expect(res.stdout).toBe("");
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

  test("finds multiple file types with brace expansion", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "a.ts"), "", "utf-8");
    await fs.writeFile(path.join(dir, "b.js"), "", "utf-8");
    await fs.writeFile(path.join(dir, "c.py"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.{ts,js}" });
    expect(res).toContain("a.ts");
    expect(res).toContain("b.js");
    expect(res).not.toContain("c.py");
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
        subAgentModel: "gpt-5.3-codex",
      }),
    });

  test("uses OpenAI provider-native web search for openai provider", async () => {
    const dir = await tmpDir();
    const t: any = createWebSearchTool(
      makeCtx(dir, {
        config: makeConfig(dir, { provider: "openai", model: "gpt-5.2", subAgentModel: "gpt-5.2" }),
      })
    );
    expect(t.type).toBe("provider");
    expect(t.id).toBe("openai.web_search");
  });

  test("uses Google provider-native web search for google provider", async () => {
    const dir = await tmpDir();
    const t: any = createWebSearchTool(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "google",
          model: "gemini-3-flash-preview",
          subAgentModel: "gemini-3-flash-preview",
        }),
      })
    );
    expect(t.type).toBe("provider");
    expect(t.id).toBe("google.google_search");
  });

  test("uses Anthropic provider-native web search for anthropic provider", async () => {
    const dir = await tmpDir();
    const t: any = createWebSearchTool(
      makeCtx(dir, {
        config: makeConfig(dir, {
          provider: "anthropic",
          model: "claude-opus-4-6",
          subAgentModel: "claude-opus-4-6",
        }),
      })
    );
    expect(t.type).toBe("provider");
    expect(t.id).toBe("anthropic.web_search_20250305");
  });

  test("returns disabled message without API keys", async () => {
    const dir = await tmpDir();

    const oldBrave = process.env.BRAVE_API_KEY;
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.EXA_API_KEY;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out: string = await t.execute({ query: "test", maxResults: 1 });
      expect(out).toContain("webSearch disabled");
    } finally {
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
    }
  });

  test("uses BRAVE_API_KEY when available", async () => {
    const dir = await tmpDir();

    const oldBrave = process.env.BRAVE_API_KEY;
    const oldExa = process.env.EXA_API_KEY;
    process.env.BRAVE_API_KEY = "test-brave-key";
    delete process.env.EXA_API_KEY;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any) => {
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Test Result",
                url: "https://example.com",
                description: "A test description",
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out: string = await t.execute({ query: "test query", maxResults: 5 });
      expect(out).toContain("Test Result");
      expect(out).toContain("https://example.com");
      expect(out).toContain("A test description");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      else delete process.env.BRAVE_API_KEY;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
    }
  });

  test("uses EXA_API_KEY as fallback", async () => {
    const dir = await tmpDir();

    const oldBrave = process.env.BRAVE_API_KEY;
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.BRAVE_API_KEY;
    process.env.EXA_API_KEY = "test-exa-key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: any) => {
      expect(String(url)).toContain("api.exa.ai/search");
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Exa Result",
              url: "https://exa.com",
              text: { text: "Exa content" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out: string = await t.execute({ query: "test query", maxResults: 5 });
      expect(out).toContain("Exa Result");
      expect(out).toContain("https://exa.com");
      expect(out).toContain("Exa content");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("handles Brave API error response", async () => {
    const dir = await tmpDir();

    const oldBrave = process.env.BRAVE_API_KEY;
    const oldExa = process.env.EXA_API_KEY;
    process.env.BRAVE_API_KEY = "test-brave-key";
    delete process.env.EXA_API_KEY;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out: string = await t.execute({ query: "test", maxResults: 1 });
      expect(out).toContain("Brave search failed");
      expect(out).toContain("401");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      else delete process.env.BRAVE_API_KEY;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
    }
  });

  test("handles Exa API error response", async () => {
    const dir = await tmpDir();

    const oldBrave = process.env.BRAVE_API_KEY;
    const oldExa = process.env.EXA_API_KEY;
    delete process.env.BRAVE_API_KEY;
    process.env.EXA_API_KEY = "test-exa-key";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ message: "Internal Server Error" }), {
        status: 500,
        statusText: "Internal Server Error",
      });
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out: string = await t.execute({ query: "test", maxResults: 1 });
      expect(out).toContain("Exa search failed");
      expect(out).toContain("Internal Server Error");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });

  test("handles empty results from Brave", async () => {
    const dir = await tmpDir();

    const oldBrave = process.env.BRAVE_API_KEY;
    const oldExa = process.env.EXA_API_KEY;
    process.env.BRAVE_API_KEY = "test-brave-key";
    delete process.env.EXA_API_KEY;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out: string = await t.execute({ query: "nothing", maxResults: 5 });
      expect(out).toBe("No results");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      else delete process.env.BRAVE_API_KEY;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
    }
  });

  test("Brave is preferred over Exa when both keys exist", async () => {
    const dir = await tmpDir();

    const oldBrave = process.env.BRAVE_API_KEY;
    const oldExa = process.env.EXA_API_KEY;
    process.env.BRAVE_API_KEY = "test-brave-key";
    process.env.EXA_API_KEY = "test-exa-key";

    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({
          web: {
            results: [{ title: "Brave Hit", url: "https://brave.com", description: "desc" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    try {
      const t: any = createWebSearchTool(makeCustomSearchCtx(dir));
      const out: string = await t.execute({ query: "test", maxResults: 1 });
      expect(calledUrl).toContain("brave");
      expect(out).toContain("Brave Hit");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBrave) process.env.BRAVE_API_KEY = oldBrave;
      else delete process.env.BRAVE_API_KEY;
      if (oldExa) process.env.EXA_API_KEY = oldExa;
      else delete process.env.EXA_API_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// webFetch tool
// ---------------------------------------------------------------------------

describe("webFetch tool", () => {
  test("fetches URL and returns content", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response("<html><body><p>Hello from the web</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com", maxLength: 50000 });
      expect(out).toContain("Hello from the web");
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

  test("truncates content to maxLength", async () => {
    const dir = await tmpDir();
    const longContent = "<html><body><p>" + "x".repeat(10000) + "</p></body></html>";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(longContent, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com", maxLength: 1000 });
      expect(out.length).toBeLessThanOrEqual(1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("converts HTML to markdown with links", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(
        "<html><body><h1>Title</h1><p>Paragraph text</p><a href='https://link.com'>Click Here</a></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com", maxLength: 50000 });
      expect(out).toContain("Click Here");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles HTML without readable article content", async () => {
    const dir = await tmpDir();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      // Minimal HTML that Readability may not parse as article
      return new Response("<html><body><div>Simple content</div></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as any;

    try {
      const t: any = createWebFetchTool(makeCtx(dir));
      const out: string = await t.execute({ url: "https://example.com", maxLength: 50000 });
      // Even without Readability parse, the fallback turndown should work
      expect(out).toContain("Simple content");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// ask tool
// ---------------------------------------------------------------------------

describe("ask tool", () => {
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
    const updateFn = mock((_todos: any) => {});
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
  function makeNotebook(cells: Array<{ cell_type: string; source: string[] }>) {
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
  test("loads skill from SKILL.md in directory", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills", "xlsx");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# XLSX Skill\nInstructions here.",
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

  test("loads skill from flat file layout", async () => {
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
    expect(res).toContain("PDF Skill Content");
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

  test("caches loaded skills", async () => {
    const dir = await tmpDir();
    const skillDir = path.join(dir, "skills_cache_test", "cached_skill_unique");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "Cached content", "utf-8");

    const config = makeConfig(dir);
    config.skillsDirs = [path.join(dir, "skills_cache_test")];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    // First call reads from disk
    const res1: string = await t.execute({ skillName: "cached_skill_unique" });
    expect(res1).toBe("Cached content");

    // Modify the file on disk
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "Modified content", "utf-8");

    // Second call should return cached version
    const res2: string = await t.execute({ skillName: "cached_skill_unique" });
    expect(res2).toBe("Cached content");
  });

  test("searches multiple skillsDirs in order", async () => {
    const dir = await tmpDir();
    const dir1 = path.join(dir, "s1_order_test");
    const dir2 = path.join(dir, "s2_order_test");
    await fs.mkdir(path.join(dir1, "myskill_order"), { recursive: true });
    await fs.mkdir(path.join(dir2, "myskill_order"), { recursive: true });
    await fs.writeFile(path.join(dir1, "myskill_order", "SKILL.md"), "First dir", "utf-8");
    await fs.writeFile(path.join(dir2, "myskill_order", "SKILL.md"), "Second dir", "utf-8");

    const config = makeConfig(dir);
    config.skillsDirs = [dir1, dir2];
    const ctx = makeCtx(dir);
    ctx.config = config;

    const t: any = createSkillTool(ctx);
    const res: string = await t.execute({ skillName: "myskill_order" });
    expect(res).toBe("First dir");
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
  test("reads hot cache (AGENT.md)", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "AGENT.md"), "# Hot cache content", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toContain("Hot cache content");
  });

  test("reads hot cache with explicit key 'hot'", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "AGENT.md"), "Hot via key", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "hot" });
    expect(res).toBe("Hot via key");
  });

  test("reads hot cache with key 'AGENT.md'", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "AGENT.md"), "Hot via AGENT.md key", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "AGENT.md" });
    expect(res).toBe("Hot via AGENT.md key");
  });

  test("returns 'No hot cache found' when AGENT.md does not exist", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toBe("No hot cache found.");
  });

  test("writes to hot cache", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({
      action: "write",
      content: "New hot cache data",
    });
    expect(res).toContain("Hot cache updated");

    const content = await fs.readFile(path.join(dir, ".agent", "AGENT.md"), "utf-8");
    expect(content).toBe("New hot cache data");
  });

  test("writes to hot cache with key 'hot'", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await t.execute({ action: "write", key: "hot", content: "Hot data" });
    const content = await fs.readFile(path.join(dir, ".agent", "AGENT.md"), "utf-8");
    expect(content).toBe("Hot data");
  });

  test("reads named memory key", async () => {
    const dir = await tmpDir();
    const memDir = path.join(dir, ".agent", "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "glossary.md"), "# Glossary\nTerm: Definition", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "glossary" });
    expect(res).toContain("Glossary");
    expect(res).toContain("Term: Definition");
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

  test("returns 'not found' for missing memory key", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read", key: "missing" });
    expect(res).toContain("not found");
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

    const content = await fs.readFile(
      path.join(dir, ".agent", "memory", "people", "sarah.md"),
      "utf-8"
    );
    expect(content).toBe("Sarah is a developer.");
  });

  test("writes named memory key with .md extension", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await t.execute({
      action: "write",
      key: "config.md",
      content: "Config data",
    });

    const content = await fs.readFile(
      path.join(dir, ".agent", "memory", "config.md"),
      "utf-8"
    );
    expect(content).toBe("Config data");
  });

  test("write throws when content is missing", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await expect(t.execute({ action: "write", key: "test" })).rejects.toThrow(
      /content is required/
    );
  });

  test("searches memory content in hot cache", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".agent");
    const memDir = path.join(agentDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "AGENT.md"),
      "The project uses TypeScript\nand Bun runtime.",
      "utf-8"
    );

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "search", query: "TypeScript" });
    expect(res).toContain("TypeScript");
  });

  test("search returns 'no memory found' when nothing matches", async () => {
    const dir = await tmpDir();
    const agentDir = path.join(dir, ".agent");
    const memDir = path.join(agentDir, "memory");
    const userMemDir = path.join(dir, ".agent-user", "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.mkdir(userMemDir, { recursive: true });

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

  test("unknown action returns message", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "unknown" as any });
    expect(res).toBe("Unknown action.");
  });

  test("write creates .agent directory if missing", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await t.execute({ action: "write", content: "bootstrap" });
    const exists = await fs
      .access(path.join(dir, ".agent"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("write creates nested memory directories", async () => {
    const dir = await tmpDir();
    const t: any = createMemoryTool(makeCtx(dir));
    await t.execute({
      action: "write",
      key: "deep/nested/path",
      content: "deep value",
    });
    const content = await fs.readFile(
      path.join(dir, ".agent", "memory", "deep", "nested", "path.md"),
      "utf-8"
    );
    expect(content).toBe("deep value");
  });

  test("reads from user agent dir as fallback", async () => {
    const dir = await tmpDir();
    const userAgentDir = path.join(dir, ".agent-user");
    await fs.mkdir(userAgentDir, { recursive: true });
    await fs.writeFile(path.join(userAgentDir, "AGENT.md"), "User-level hot cache", "utf-8");

    const t: any = createMemoryTool(makeCtx(dir));
    const res: string = await t.execute({ action: "read" });
    expect(res).toBe("User-level hot cache");
  });
});

// ---------------------------------------------------------------------------
// createTools (index)
// ---------------------------------------------------------------------------

describe("createTools", () => {
  test("returns object with all tool names", async () => {
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
      "todoWrite",
      "spawnAgent",
      "notebookEdit",
      "skill",
      "memory",
    ];
    for (const name of expected) {
      expect(tools).toHaveProperty(name);
    }
  });

  test("returns exactly 14 tools", async () => {
    const dir = await tmpDir();
    const tools = createTools(makeCtx(dir));
    expect(Object.keys(tools).length).toBe(14);
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
});
