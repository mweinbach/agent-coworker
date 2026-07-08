import { hostPlatform } from "../../src/platform/host";
import { normalizeGlobPattern, splitAbsoluteGlob } from "../../src/platform/paths";
import {
  afterEach,
  bashInternal,
  beforeEach,
  createAskTool,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createMemoryTool,
  createReadTool,
  createSkillTool,
  createTodoWriteTool,
  createTools,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  makeConfig,
  makeCtx,
  mock,
  os,
  path,
  test,
  tmpDir,
  webFetchInternal,
  webSafetyInternal,
  withAuthHome,
  withEnv,
  writeConnectionStore,
  z,
} from "./tools.harness";

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

  test("enforces child agent targetPaths for glob cwd and matches", async () => {
    const dir = await tmpDir();
    const allowedDir = path.join(dir, "src", "foo");
    const blockedDir = path.join(dir, "src", "bar");
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.mkdir(blockedDir, { recursive: true });
    await fs.writeFile(path.join(allowedDir, "allowed.ts"), "", "utf-8");
    await fs.writeFile(path.join(blockedDir, "blocked.ts"), "", "utf-8");

    const t: any = createGlobTool(makeCtx(dir, { agentTargetPaths: ["src/foo"] }));
    await expect(t.execute({ pattern: "*.ts", cwd: allowedDir })).resolves.toContain("allowed.ts");
    await expect(t.execute({ pattern: "*.ts", cwd: blockedDir })).rejects.toThrow(/targetPaths/);
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

  test("supports glob with absolute pattern by converting it", async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "match.ts"), "", "utf-8");
    const absolutePattern = path.join(dir, "*.ts");

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: absolutePattern });
    expect(res).toContain("match.ts");
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

  test("returns newest matches when maxResults truncates output", async () => {
    const dir = await tmpDir();
    const oldest = path.join(dir, "oldest.txt");
    const middle = path.join(dir, "middle.txt");
    const newest = path.join(dir, "newest.txt");
    await fs.writeFile(oldest, "", "utf-8");
    await fs.writeFile(middle, "", "utf-8");
    await fs.writeFile(newest, "", "utf-8");
    await fs.utimes(oldest, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await fs.utimes(middle, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    await fs.utimes(newest, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));

    const t: any = createGlobTool(makeCtx(dir));
    const res: string = await t.execute({ pattern: "*.txt", maxResults: 2 });

    expect(res).toContain("newest.txt");
    expect(res).toContain("middle.txt");
    expect(res).not.toContain("oldest.txt");
    expect(res).toContain("truncated to 2 matches");
  });

  test("rejects negated absolute patterns", async () => {
    const dir = await tmpDir();
    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: `!${path.join(dir, "*.ts")}` })).rejects.toThrow(/blocked/i);
  });

  test("rejects negated parent-relative patterns", async () => {
    const dir = await tmpDir();
    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: "!../outside/*.ts" })).rejects.toThrow(/blocked/i);
  });

  test("negated relative patterns pass the safety guard", async () => {
    const dir = await tmpDir();
    const t: any = createGlobTool(makeCtx(dir));
    await expect(t.execute({ pattern: "!*.xyz" })).resolves.toBe("No files found.");
  });

  test.if(hostPlatform() === "win32")(
    "resolves win32 backslash absolute patterns into root and rest",
    async () => {
      const dir = await tmpDir();
      await fs.mkdir(path.join(dir, "src", "deep"), { recursive: true });
      await fs.writeFile(path.join(dir, "src", "deep", "match.ts"), "", "utf-8");

      const t: any = createGlobTool(makeCtx(dir));
      const res: string = await t.execute({ pattern: `${dir}\\src\\**\\*.ts` });
      expect(res).toContain("deep/match.ts");
    },
  );

  test.if(hostPlatform() === "win32")(
    "treats backslashes in relative patterns as separators on win32",
    async () => {
      const dir = await tmpDir();
      await fs.mkdir(path.join(dir, "sub"), { recursive: true });
      await fs.writeFile(path.join(dir, "sub", "inner.ts"), "", "utf-8");

      const t: any = createGlobTool(makeCtx(dir));
      const res: string = await t.execute({ pattern: "sub\\*.ts" });
      expect(res).toContain("sub/inner.ts");
    },
  );
});

describe("glob pattern normalization (platform-parameterized)", () => {
  const allPlatforms: NodeJS.Platform[] = ["linux", "darwin", "win32"];

  test("preserves POSIX fast-glob escapes on posix platforms", () => {
    expect(normalizeGlobPattern("\\*.ts", "linux")).toBe("\\*.ts");
    expect(normalizeGlobPattern("src/\\*literal\\?/*.ts", "darwin")).toBe("src/\\*literal\\?/*.ts");
  });

  test("rewrites backslash separators on win32", () => {
    expect(normalizeGlobPattern("src\\**\\*.ts", "win32")).toBe("src/**/*.ts");
  });

  test("rewrites win32-shaped patterns on every platform", () => {
    for (const platform of allPlatforms) {
      expect(normalizeGlobPattern("C:\\src\\**\\*.ts", platform)).toBe("C:/src/**/*.ts");
    }
  });

  test("splits drive-qualified absolute globs into root and rest on every platform", () => {
    for (const platform of allPlatforms) {
      expect(splitAbsoluteGlob("C:\\src\\**\\*.ts", platform)).toEqual({
        root: "C:/src",
        rest: "**/*.ts",
      });
    }
  });

  test("drive-root split never yields a drive-relative root", () => {
    // The old inline splitter fell back to "/" (or drive-relative "C:") here.
    expect(splitAbsoluteGlob("C:\\*.ts", "win32")).toEqual({ root: "C:/", rest: "*.ts" });
  });

  test("splits posix absolute globs, including the filesystem root", () => {
    expect(splitAbsoluteGlob("/var/log/*.log", "linux")).toEqual({
      root: "/var/log",
      rest: "*.log",
    });
    expect(splitAbsoluteGlob("/*.log", "linux")).toEqual({ root: "/", rest: "*.log" });
  });

  test("returns null for relative and negated patterns", () => {
    for (const platform of allPlatforms) {
      expect(splitAbsoluteGlob("src/**/*.ts", platform)).toBeNull();
      expect(splitAbsoluteGlob("!C:/src/*.ts", platform)).toBeNull();
      expect(splitAbsoluteGlob("!/abs/*.ts", platform)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// grep tool
// ---------------------------------------------------------------------------
