import { spyOn } from "bun:test";
import { hostPlatform } from "../../src/platform/host";
import { canonicalizeSync } from "../../src/platform/paths";
import { WorkspaceFileChangeMonitor } from "../../src/server/runtime/WorkspaceFileChangeMonitor";
import type { WorkspaceFileChangeEvent } from "../../src/shared/fileVersion";
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

describe("write tool", () => {
  test("leaves existing content intact when staging a replacement fails", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "existing.txt");
    await fs.writeFile(filePath, "original");
    const originalWrite = fs.writeFile;
    const write = spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
      if (String(target) === filePath || String(target).endsWith(".tmp")) {
        await originalWrite(target, "partial", options);
        throw new Error("simulated disk failure");
      }
      return originalWrite(target, data, options);
    });

    try {
      await expect(
        createWriteTool(makeCtx(dir)).execute({ filePath, content: "replacement" }),
      ).rejects.toThrow("simulated disk failure");
    } finally {
      write.mockRestore();
    }

    expect(await fs.readFile(filePath, "utf8")).toBe("original");
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("does not create files for an already-cancelled turn", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "cancelled", "file.txt");
    const controller = new AbortController();
    controller.abort();

    await expect(
      createWriteTool(makeCtx(dir, { abortSignal: controller.signal })).execute({
        filePath,
        content: "must not be written",
      }),
    ).rejects.toThrow(/abort|cancel/i);
    await expect(fs.access(path.dirname(filePath))).rejects.toThrow();
  });

  test("serializes appends and edits through the same file lock", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "shared.txt");
    await fs.writeFile(filePath, "alpha old\nbeta old\n");
    const ctx = makeCtx(dir);
    await Promise.all([
      createEditTool(ctx).execute({
        filePath,
        oldString: "alpha old",
        newString: "alpha new",
      }),
      createWriteTool(ctx).execute({ filePath, content: "appended\n", mode: "append" }),
      createEditTool(ctx).execute({
        filePath,
        oldString: "beta old",
        newString: "beta new",
      }),
    ]);

    expect(await fs.readFile(filePath, "utf8")).toBe("alpha new\nbeta new\nappended\n");
  });

  test("refuses to commit when a concurrent writer changes the target after staging", async () => {
    const dir = await tmpDir();
    const filePath = path.join(dir, "existing.txt");
    await fs.writeFile(filePath, "original");
    const originalWrite = fs.writeFile;
    const write = spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
      await originalWrite(target, data, options);
      if (String(target).endsWith(".tmp")) {
        await originalWrite(filePath, "external");
      }
    });

    try {
      await expect(
        createWriteTool(makeCtx(dir)).execute({ filePath, content: "replacement" }),
      ).rejects.toThrow(/file changed/i);
    } finally {
      write.mockRestore();
    }

    expect(await fs.readFile(filePath, "utf8")).toBe("external");
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test.skipIf(hostPlatform() === "win32")(
    "writes through an allowed symlink without replacing the link",
    async () => {
      const dir = await tmpDir();
      const target = path.join(dir, "target.txt");
      const alias = path.join(dir, "alias.txt");
      await fs.writeFile(target, "original");
      await fs.symlink(target, alias);

      await createWriteTool(makeCtx(dir)).execute({ filePath: alias, content: "updated" });
      await createEditTool(makeCtx(dir)).execute({
        filePath: alias,
        oldString: "updated",
        newString: "edited",
      });

      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe("edited");
    },
  );

  test.skipIf(hostPlatform() === "win32")(
    "rejects a parent symlink swap during the mutation gate",
    async () => {
      const dir = await tmpDir();
      const outsideDir = await tmpDir();
      const parent = path.join(dir, "safe");
      await fs.mkdir(parent);
      const outsideFile = path.join(outsideDir, "file.txt");
      await fs.writeFile(outsideFile, "outside original");
      let swapped = false;
      const tool = createWriteTool(
        makeCtx(dir, {
          assertCanMutate: async () => {
            if (swapped) return;
            swapped = true;
            await fs.rename(parent, path.join(dir, "safe-original"));
            await fs.symlink(outsideDir, parent);
          },
        }),
      );

      await expect(
        tool.execute({ filePath: path.join(parent, "file.txt"), content: "escaped" }),
      ).rejects.toThrow(/blocked|changed/i);
      expect(await fs.readFile(outsideFile, "utf8")).toBe("outside original");
    },
  );

  test("emits a workspace change when an agent write updates a file", async () => {
    const dir = await tmpDir();
    const events: WorkspaceFileChangeEvent[] = [];
    const monitor = new WorkspaceFileChangeMonitor({
      cwd: dir,
      debounceMs: 5,
      onChange: (event) => {
        events.push(event);
      },
    });
    const tool = createWriteTool(makeCtx(dir)) as unknown as {
      execute(input: { filePath: string; content: string }): Promise<string>;
    };
    const filePath = path.join(dir, "agent-write.txt");

    try {
      await tool.execute({ filePath, content: "agent content" });
      const canonicalFilePath = canonicalizeSync(filePath);
      const startedAt = Date.now();
      while (
        !events.some((event) => event.kind === "changed" && event.path === canonicalFilePath) &&
        Date.now() - startedAt < 2_000
      ) {
        await Bun.sleep(10);
      }

      expect(events).toContainEqual({
        kind: "changed",
        path: canonicalFilePath,
        version: expect.objectContaining({ size: "agent content".length }),
      });
    } finally {
      monitor.stop();
    }
  });

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

  test("cleans parent directories if the mutation gate closes after mkdir", async () => {
    const dir = await tmpDir();
    let gateChecks = 0;
    const t: any = createWriteTool(
      makeCtx(dir, {
        assertCanMutate: () => {
          gateChecks += 1;
          if (gateChecks > 1) throw new Error("terminal task write gate closed");
        },
      }),
    );
    const nestedDir = path.join(dir, "terminal", "race");
    const p = path.join(nestedDir, "blocked.txt");

    await expect(t.execute({ filePath: p, content: "blocked" })).rejects.toThrow(
      /write gate closed/,
    );
    await expect(fs.access(p)).rejects.toThrow();
    await expect(fs.access(nestedDir)).rejects.toThrow();
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

  test("appends to existing file when mode is append", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "append.txt");
    await fs.writeFile(p, "first\n", "utf-8");

    const t: any = createWriteTool(makeCtx(dir));
    const res: string = await t.execute({ filePath: p, content: "second\n", mode: "append" });
    expect(res).toContain("Appended");
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("first\nsecond\n");
  });

  test("creates file when appending to a missing path", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "missing", "append.txt");

    const t: any = createWriteTool(makeCtx(dir));
    await t.execute({ filePath: p, content: "chunk\n", mode: "append" });
    const written = await fs.readFile(p, "utf-8");
    expect(written).toBe("chunk\n");
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
      t.execute({ filePath: path.join(outsideDir, "bad.txt"), content: "nope" }),
    ).rejects.toThrow(/blocked/i);
  });

  test("rejects writes when sandbox policy is explicitly read-only", async () => {
    const dir = await tmpDir();
    const t: any = createWriteTool(
      makeCtx(dir, { sandboxPolicy: { kind: "read-only", network: false } }),
    );
    await expect(t.execute({ filePath: "blocked.txt", content: "nope" })).rejects.toThrow(
      /sandbox mode is read-only/i,
    );
    await expect(fs.readFile(path.join(dir, "blocked.txt"), "utf-8")).rejects.toThrow();
  });

  test("rejects writes when sandbox policy is no-project-write", async () => {
    const dir = await tmpDir();
    const t: any = createWriteTool(
      makeCtx(dir, { sandboxPolicy: { kind: "no-project-write", network: false } }),
    );
    await expect(t.execute({ filePath: "blocked.txt", content: "nope" })).rejects.toThrow(
      /sandbox mode is no-project-write/i,
    );
    await expect(fs.readFile(path.join(dir, "blocked.txt"), "utf-8")).rejects.toThrow();
  });

  test("enforces child agent targetPaths for writes", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, "src", "foo"), { recursive: true });
    await fs.mkdir(path.join(dir, "src", "bar"), { recursive: true });

    const t: any = createWriteTool(makeCtx(dir, { agentTargetPaths: ["src/foo"] }));
    await expect(t.execute({ filePath: "src/foo/allowed.ts", content: "ok" })).resolves.toContain(
      "Wrote",
    );
    await expect(t.execute({ filePath: "src/bar/blocked.ts", content: "nope" })).rejects.toThrow(
      /targetPaths/,
    );
    await expect(fs.readFile(path.join(dir, "src", "foo", "allowed.ts"), "utf-8")).resolves.toBe(
      "ok",
    );
    await expect(
      fs.readFile(path.join(dir, "src", "bar", "blocked.ts"), "utf-8"),
    ).rejects.toThrow();
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
      t.execute({ filePath: path.join(link, "blocked.txt"), content: "nope" }),
    ).rejects.toThrow(/blocked/i);
  });

  test("refuses to plant a .git hook under the project root", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    const hook = path.join(dir, ".git", "hooks", "pre-commit");

    const t: any = createWriteTool(makeCtx(dir));
    await expect(t.execute({ filePath: hook, content: "#!/bin/sh\necho pwned\n" })).rejects.toThrow(
      /read-only/i,
    );
    await expect(fs.readFile(hook, "utf-8")).rejects.toThrow();
  });

  test("refuses to write project .cowork config metadata", async () => {
    const dir = await tmpDir();
    const configPath = path.join(dir, ".cowork", "config.json");

    const t: any = createWriteTool(makeCtx(dir));
    await expect(
      t.execute({ filePath: configPath, content: '{"provider":"evil"}' }),
    ).rejects.toThrow(/read-only/i);
    await expect(fs.readFile(configPath, "utf-8")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// edit tool
// ---------------------------------------------------------------------------
