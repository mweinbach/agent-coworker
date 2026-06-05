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
  currentTodos,
  describe,
  expect,
  fs,
  getAiCoworkerPaths,
  listSessionToolNames,
  makeConfig,
  makeCtx,
  mock,
  onTodoChange,
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

  test("falls back through POSIX shell candidates", async () => {
    await withEnv("SHELL", "/missing/user-shell", async () => {
      const seen: string[] = [];
      const result = await bashInternal.runShellCommandWithExec({
        command: "echo hi",
        cwd: "/tmp",
        platform: "linux",
        execRunner: async (file: string) => {
          seen.push(file);
          if (file === "/bin/sh") {
            return { stdout: "hi\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 1, errorCode: "ENOENT" };
        },
      });

      expect(seen).toEqual(["/missing/user-shell", "/bin/bash", "/bin/sh"]);
      expect(result.stdout.trim()).toBe("hi");
    });
  });

  test("pins managed soffice shim inside POSIX shell commands", async () => {
    const seen: Array<{ file: string; args: string[] }> = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "soffice --version",
      cwd: "/tmp",
      platform: "darwin",
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        COWORK_MANAGED_SOFFICE_SHIM_DIR: "/Users/test/.cache/cowork/libreoffice/bin",
        COWORK_SOFFICE: "/Users/test/.cache/cowork/libreoffice/bin/soffice",
      },
      execRunner: async (file: string, args: string[]) => {
        seen.push({ file, args });
        return { stdout: "LibreOffice 26.2.3.2\n", stderr: "", exitCode: 0 };
      },
    });

    const commandArg = seen[0]?.args.at(-1);
    expect(commandArg).toContain(`export PATH='/Users/test/.cache/cowork/libreoffice/bin':$PATH`);
    expect(commandArg).toContain(
      `export COWORK_SOFFICE='/Users/test/.cache/cowork/libreoffice/bin/soffice'`,
    );
    expect(commandArg?.endsWith("soffice --version")).toBe(true);
    expect(result.stdout.trim()).toBe("LibreOffice 26.2.3.2");
  });

  test("pins managed soffice shim inside Windows PowerShell commands", async () => {
    const seen: Array<{ file: string; args: string[] }> = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "soffice --version",
      cwd: "C:/tmp",
      platform: "win32",
      env: {
        Path: "C:\\Windows\\System32",
        COWORK_MANAGED_SOFFICE_SHIM_DIR: "C:\\Users\\test\\.cache\\cowork\\libreoffice\\bin",
        COWORK_SOFFICE: "C:\\Users\\test\\.cache\\cowork\\libreoffice\\bin\\soffice.cmd",
      },
      execRunner: async (file: string, args: string[]) => {
        seen.push({ file, args });
        return { stdout: "LibreOffice 26.2.3.2\n", stderr: "", exitCode: 0 };
      },
    });

    const commandArg = seen[0]?.args.at(-1);
    expect(commandArg).toContain(
      "$env:PATH = 'C:\\Users\\test\\.cache\\cowork\\libreoffice\\bin' + ';' + $env:PATH",
    );
    expect(commandArg).toContain(
      "$env:COWORK_SOFFICE = 'C:\\Users\\test\\.cache\\cowork\\libreoffice\\bin\\soffice.cmd'",
    );
    expect(commandArg?.endsWith("soffice --version")).toBe(true);
    expect(result.stdout.trim()).toBe("LibreOffice 26.2.3.2");
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

  test("passes tool environment into shell execution", async () => {
    const dir = await tmpDir();
    let observedEnv: Record<string, string | undefined> | undefined;
    bashInternal.setRunShellCommandForTests(async (opts) => {
      observedEnv = opts.env;
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    });
    const t: any = createBashTool(makeCtx(dir, { toolEnv: { COWORK_TEST_ENV: "present" } }));
    await t.execute({ command: "echo ok" });
    expect(observedEnv?.COWORK_TEST_ENV).toBe("present");
  });

  test("returns exit code on failure", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({ command: "exit 42" });
    expect(res.exitCode).not.toBe(0);
  });

  test("does not prompt for approval when a sandboxed command succeeds", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true);
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "test\n",
      stderr: "",
      exitCode: 0,
      sandbox: "linux-bwrap",
    }));

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "echo test" });
    expect(res.exitCode).toBe(0);
    // Under escalate-on-failure the sandbox is the boundary; no pre-run prompt.
    expect(approveFn).not.toHaveBeenCalled();
  });

  test("escalation rejected returns the sandbox failure unchanged", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => false);
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "",
      stderr: "touch: cannot touch 'x': Operation not permitted",
      exitCode: 1,
      sandbox: "linux-bwrap",
    }));

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "touch x" });
    expect(approveFn).toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Operation not permitted");
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

  test("approved escalation re-runs the command without the sandbox", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true);
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;
    const policies: Array<{ kind: string }> = [];
    let call = 0;
    bashInternal.setRunShellCommandForTests(async (opts: any) => {
      policies.push(opts.policy);
      call += 1;
      if (call === 1) {
        return {
          stdout: "",
          stderr: "bash: cannot create file: Read-only file system",
          exitCode: 1,
          sandbox: "linux-bwrap",
        };
      }
      return { stdout: "ran unsandboxed\n", stderr: "", exitCode: 0, sandbox: "none" };
    });

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "touch x" });
    expect(approveFn).toHaveBeenCalled();
    expect(call).toBe(2);
    // The retry drops to full access (no sandbox).
    expect(policies[1]?.kind).toBe("danger-full-access");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("ran unsandboxed");
  });

  test("does not escalate when a sandboxed failure is not a sandbox denial", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true);
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "",
      stderr: "some normal command error",
      exitCode: 2,
      sandbox: "linux-bwrap",
    }));

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "false" });
    expect(approveFn).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(2);
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

  test("applies default 5 minute timeout when not specified", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    bashInternal.setRunShellCommandForTests(async (opts) => {
      expect(opts.timeoutMs).toBe(300_000);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const res = await t.execute({ command: "sleep 1" });
    expect(res.stdout).toBe("ok");
  });

  test("uses custom timeout when timeoutSeconds is provided", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    bashInternal.setRunShellCommandForTests(async (opts) => {
      expect(opts.timeoutMs).toBe(120_000);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const res = await t.execute({ command: "sleep 1", timeoutSeconds: 120 });
    expect(res.stdout).toBe("ok");
  });

  test("caps timeout at maximum allowed value", async () => {
    const dir = await tmpDir();
    const t: any = createBashTool(makeCtx(dir));
    bashInternal.setRunShellCommandForTests(async (opts) => {
      expect(opts.timeoutMs).toBe(600_000);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const res = await t.execute({ command: "sleep 1", timeoutSeconds: 9999 });
    expect(res.stdout).toBe("ok");
  });

  test("returns timeout error when command exceeds timeout", async () => {
    const dir = await tmpDir();
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "",
      stderr: "Command timed out after 1s. The child process was terminated.",
      exitCode: 124,
      errorCode: "TIMEOUT",
    }));
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({ command: "sleep 10", timeoutSeconds: 1 });
    expect(res.exitCode).toBe(124);
    expect(res.stderr).toContain("timed out");
  });

  test("redacts secrets in tool log output", async () => {
    const dir = await tmpDir();
    const logs: string[] = [];
    const ctx = makeCtx(dir);
    ctx.log = (line: string) => logs.push(line);

    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "api-key=sk-abc1234567890abcdef",
      stderr: "token=supersecrettoken123",
      exitCode: 0,
    }));

    const t: any = createBashTool(ctx);
    await t.execute({ command: "echo secrets" });

    const toolLog = logs.find((l) => l.includes("tool< bash"));
    expect(toolLog).toBeDefined();
    expect(toolLog).not.toContain("sk-abc1234567890abcdef");
    expect(toolLog).not.toContain("supersecrettoken123");
    expect(toolLog).toContain("***REDACTED***");
  });
});

// ---------------------------------------------------------------------------
// glob tool
// ---------------------------------------------------------------------------
