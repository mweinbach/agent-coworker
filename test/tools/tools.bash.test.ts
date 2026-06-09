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

  test("sandboxed run uses a minimal env when no toolEnv is set", async () => {
    const dir = await tmpDir();
    let observedEnv: Record<string, string | undefined> | undefined;
    process.env.COWORK_TEST_INHERIT = "yes";
    process.env.PATH = process.env.PATH || "/usr/bin";
    try {
      await bashInternal.runShellCommandWithExec({
        command: "echo hi",
        cwd: dir,
        platform: "linux",
        policy: { kind: "workspace-write", writableRoots: [dir], network: true },
        capabilities: { seatbelt: false, bwrapPath: "/usr/bin/bwrap", windowsHelperPath: null },
        // no `env` (toolEnv) — mirrors a raw delegate context.
        execRunner: async (
          _file: string,
          _args: string[],
          execOpts?: { env?: Record<string, string | undefined> },
        ) => {
          observedEnv = execOpts?.env;
          return { stdout: "hi\n", stderr: "", exitCode: 0 };
        },
      });
    } finally {
      delete process.env.COWORK_TEST_INHERIT;
    }
    // The sandboxed branch keeps compatibility basics but does not inherit
    // arbitrary server secrets/env vars.
    expect(observedEnv?.PATH).toBeDefined();
    expect(observedEnv?.COWORK_TEST_INHERIT).toBeUndefined();
    expect(observedEnv?.COWORK_SANDBOX).toBeDefined();
  });

  test("sandboxed run strips secrets from an explicit toolEnv", async () => {
    const dir = await tmpDir();
    let observedEnv: Record<string, string | undefined> | undefined;
    await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: dir,
      platform: "linux",
      policy: { kind: "workspace-write", writableRoots: [dir], network: true },
      capabilities: { seatbelt: false, bwrapPath: "/usr/bin/bwrap", windowsHelperPath: null },
      // A realistic toolEnv: server process env (secrets) plus allowlisted basics.
      env: {
        PATH: "/usr/bin",
        HOME: "/home/agent",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        GITHUB_TOKEN: "ghp_secret",
      },
      execRunner: async (
        _file: string,
        _args: string[],
        execOpts?: { env?: Record<string, string | undefined> },
      ) => {
        observedEnv = execOpts?.env;
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
    });
    // Allowlisted compatibility vars pass through; secrets must be stripped so a
    // sandboxed command cannot read and exfiltrate them.
    expect(observedEnv?.PATH).toBe("/usr/bin");
    expect(observedEnv?.HOME).toBe("/home/agent");
    expect(observedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(observedEnv?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(observedEnv?.GITHUB_TOKEN).toBeUndefined();
    expect(observedEnv?.COWORK_SANDBOX).toBeDefined();
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
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 42,
    }));
    const t: any = createBashTool(makeCtx(dir));
    const res = await t.execute({ command: "exit 42" });
    expect(res.exitCode).not.toBe(0);
  });

  test("fails closed when a restrictive sandbox backend is required but unavailable", async () => {
    const calls: string[] = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: "/tmp",
      platform: "linux",
      policy: { kind: "workspace-write", writableRoots: ["/tmp"], network: true },
      requireBackend: true,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: null },
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
    });

    expect(calls).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("SANDBOX_REQUIRED");
    expect(result.stderr).toContain("Refusing to run unsandboxed");
  });

  test("fails closed when requireBackend sees only a non-enforcing backend", async () => {
    const calls: string[] = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: "C:/work",
      platform: "win32",
      policy: { kind: "workspace-write", writableRoots: ["C:/work"], network: false },
      requireBackend: true,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: "C:/h/helper.exe" },
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
    });

    expect(calls).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("SANDBOX_REQUIRED");
    expect(result.stderr).toContain("requires filesystem/network enforcement");
    expect(result.sandboxWarning).toContain("filesystem and network scoping are not yet enforced");
  });

  test("refuses unscoped Windows workspace-write under the non-enforcing helper when approval is declined", async () => {
    // The Windows helper applies restricted-token + Job Object process
    // containment but does NOT enforce writable roots or the network policy, so
    // ordinary workspace-write must NOT run under it silently. With
    // requireBackend=false it requires explicit unsandboxed approval and is
    // refused (helper never executed) when the user declines.
    const calls: string[] = [];
    const approve = mock(async () => false);
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo pwned > C:/Windows/System32/evil.txt",
      cwd: "C:/work",
      platform: "win32",
      policy: { kind: "workspace-write", writableRoots: ["C:/work"], network: false },
      requireBackend: false,
      requireEnforcingBackend: false,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: "C:/h/helper.exe" },
      approveUnsandboxed: approve,
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(approve).toHaveBeenCalled();
    expect(calls).toEqual([]); // declined → never executed under the non-enforcing helper
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("SANDBOX_REQUIRED");
    expect(result.sandboxWarning).toContain("filesystem and network scoping are not yet enforced");
  });

  test("runs unscoped Windows workspace-write under the helper only after unsandboxed approval", async () => {
    const calls: string[] = [];
    const approve = mock(async () => true);
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: "C:/work",
      platform: "win32",
      policy: { kind: "workspace-write", writableRoots: ["C:/work"], network: true },
      requireBackend: false,
      requireEnforcingBackend: false,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: "C:/h/helper.exe" },
      approveUnsandboxed: approve,
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
    });

    expect(approve).toHaveBeenCalled();
    // Approved → still wrapped by the helper for process containment.
    expect(calls).toEqual(["C:/h/helper.exe"]);
    expect(result.exitCode).toBe(0);
    expect(result.sandbox).toBe("windows-restricted");
  });

  test("requires approval before the unsandboxed fallback (requireBackend=false)", async () => {
    const calls: string[] = [];
    const approve = mock(async () => false); // user declines
    const result = await bashInternal.runShellCommandWithExec({
      command: "rm -rf /",
      cwd: "/tmp",
      platform: "linux",
      policy: { kind: "workspace-write", writableRoots: ["/tmp"], network: true },
      requireBackend: false,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: null },
      approveUnsandboxed: approve,
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(approve).toHaveBeenCalled();
    expect(calls).toEqual([]); // declined → never executed
    expect(result.errorCode).toBe("SANDBOX_REQUIRED");
  });

  test("labels an unsandboxed fallback approval as a sandbox escape", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => false);
    const ctx = makeCtx(dir, {
      config: makeConfig(dir, {
        sandbox: { mode: "workspace-write", network: true, requireBackend: false },
      }),
    });
    ctx.approveCommand = approveFn;
    bashInternal.setRunShellCommandForTests(async (opts) => {
      await opts.approveUnsandboxed?.();
      return {
        stdout: "",
        stderr: "declined",
        exitCode: 1,
        errorCode: "SANDBOX_REQUIRED",
        sandbox: "none",
      };
    });

    const t: any = createBashTool(ctx);
    await t.execute({ command: "touch outside" });
    expect(approveFn).toHaveBeenCalledWith(
      "touch outside",
      expect.objectContaining({ reason: "sandbox_denied", detail: expect.any(String) }),
    );
  });

  test("runs the unsandboxed fallback once approved", async () => {
    const calls: string[] = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: "/tmp",
      platform: "linux",
      policy: { kind: "workspace-write", writableRoots: ["/tmp"], network: true },
      requireBackend: false,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: null },
      approveUnsandboxed: async () => true,
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
    });

    expect(calls.length).toBeGreaterThan(0); // executed after approval
    expect(result.exitCode).toBe(0);
    expect(result.sandbox).toBe("none");
  });

  test("refuses danger-full-access with disabled network when no backend can enforce it", async () => {
    const calls: string[] = [];
    const approve = mock(async () => false);
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: "/tmp",
      platform: "linux",
      policy: { kind: "danger-full-access", network: false },
      requireBackend: false,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: null },
      approveUnsandboxed: approve,
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
    });

    expect(approve).toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(result.errorCode).toBe("SANDBOX_REQUIRED");
    expect(result.stderr).toContain("declined");
  });

  test("runs danger-full-access with disabled network after unsandboxed fallback approval", async () => {
    const calls: string[] = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "echo hi",
      cwd: "/tmp",
      platform: "linux",
      policy: { kind: "danger-full-access", network: false },
      requireBackend: false,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: null },
      approveUnsandboxed: async () => true,
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "hi\n", stderr: "", exitCode: 0 };
      },
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(result.sandbox).toBe("none");
    expect(result.sandboxWarning).toContain("bubblewrap");
  });

  test("marks a scoped child as requiring an enforcing backend (hard floor)", async () => {
    const dir = await tmpDir();
    let observed: { requireBackend?: boolean; requireEnforcingBackend?: boolean } = {};
    bashInternal.setRunShellCommandForTests(async (opts) => {
      observed = {
        requireBackend: opts.requireBackend,
        requireEnforcingBackend: opts.requireEnforcingBackend,
      };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const ctx = makeCtx(dir, {
      config: makeConfig(dir, {
        sandbox: { mode: "workspace-write", network: true, requireBackend: false },
      }),
      agentTargetPaths: [path.join(dir, "src")],
    });
    const t: any = createBashTool(ctx);
    await t.execute({ command: "echo hi" });
    // A scoped child must be enforced by the backend (no process-only/unsandboxed).
    expect(observed.requireEnforcingBackend).toBe(true);
  });

  test("does not require an enforcing backend for an unscoped workspace-write session", async () => {
    const dir = await tmpDir();
    let observed: { requireBackend?: boolean; requireEnforcingBackend?: boolean } = {};
    bashInternal.setRunShellCommandForTests(async (opts) => {
      observed = {
        requireBackend: opts.requireBackend,
        requireEnforcingBackend: opts.requireEnforcingBackend,
      };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const ctx = makeCtx(dir, {
      config: makeConfig(dir, {
        sandbox: { mode: "workspace-write", network: true, requireBackend: false },
      }),
    });
    const t: any = createBashTool(ctx);
    await t.execute({ command: "echo hi" });
    expect(observed.requireEnforcingBackend).toBe(false);
    expect(observed.requireBackend).toBe(false);
  });

  test("hard-floor scoped child fails closed under a non-enforcing (Windows-like) backend", async () => {
    // A backend that runs the command but does not enforce scope (enforcesScope
    // falsy) must not satisfy a hard floor — the run is refused, not executed.
    const calls: string[] = [];
    const result = await bashInternal.runShellCommandWithExec({
      command: "rm -rf /",
      cwd: "/work",
      platform: "win32",
      policy: { kind: "workspace-write", writableRoots: ["/work/src"], network: true },
      requireEnforcingBackend: true,
      capabilities: { seatbelt: false, bwrapPath: null, windowsHelperPath: "C:/h/helper.exe" },
      execRunner: async (file: string) => {
        calls.push(file);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(calls).toEqual([]); // never executed
    expect(result.errorCode).toBe("SANDBOX_REQUIRED");
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

  test("requires approval before executing a dangerous command", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => false);
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;
    const calls: string[] = [];
    bashInternal.setRunShellCommandForTests(async (opts) => {
      calls.push(opts.command);
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "rm -rf ." });
    expect(approveFn).toHaveBeenCalledWith("rm -rf .");
    expect(calls).toEqual([]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not approved");
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

  test("approved filesystem escalation preserves a disabled network policy", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true);
    const ctx = makeCtx(dir, {
      config: makeConfig(dir, {
        sandbox: { mode: "workspace-write", network: false, requireBackend: false },
      }),
    });
    ctx.approveCommand = approveFn;
    const policies: Array<{ kind: string; network?: boolean }> = [];
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
      return { stdout: "ran with approved filesystem access\n", stderr: "", exitCode: 0 };
    });

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "touch x" });
    expect(approveFn).toHaveBeenCalled();
    expect(call).toBe(2);
    expect(policies[1]?.kind).toBe("danger-full-access");
    expect(policies[1]?.network).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("approved filesystem access");
  });

  test("approved network escalation only enables network within the workspace sandbox", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true);
    const ctx = makeCtx(dir, {
      config: makeConfig(dir, {
        sandbox: { mode: "workspace-write", network: false, requireBackend: false },
      }),
    });
    ctx.approveCommand = approveFn;
    const policies: Array<{ kind: string; network?: boolean }> = [];
    let call = 0;
    bashInternal.setRunShellCommandForTests(async (opts: any) => {
      policies.push(opts.policy);
      call += 1;
      if (call === 1) {
        return {
          stdout: "",
          stderr: "curl: (6) Could not resolve host: example.com",
          exitCode: 6,
          sandbox: "linux-bwrap",
        };
      }
      return { stdout: "network retry\n", stderr: "", exitCode: 0, sandbox: "linux-bwrap" };
    });

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "curl https://example.com" });
    expect(call).toBe(2);
    expect(policies[1]?.kind).toBe("workspace-write");
    expect(policies[1]?.network).toBe(true);
    expect(res.stdout).toContain("network retry");
  });

  test("escalation carries a sandbox category + detail for the inline approval UI", async () => {
    const dir = await tmpDir();
    const calls: Array<{ reason?: string; detail?: string; category?: string }> = [];
    const approveFn = mock(async (_command: string, opts?: Record<string, unknown>) => {
      calls.push((opts ?? {}) as (typeof calls)[number]);
      return false;
    });
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "",
      stderr: "touch: cannot touch 'x': Operation not permitted",
      exitCode: 1,
      sandbox: "linux-bwrap",
    }));

    const t: any = createBashTool(ctx);
    await t.execute({ command: "touch x" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.reason).toBe("sandbox_denied");
    // EPERM is a filesystem denial; detail is safe-to-display copy.
    expect(calls[0]?.category).toBe("filesystem");
    expect(typeof calls[0]?.detail).toBe("string");
    expect((calls[0]?.detail ?? "").length).toBeGreaterThan(0);
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

  test("never escalates a read-only policy to full access", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true);
    const ctx = makeCtx(dir);
    ctx.approveCommand = approveFn;
    ctx.sandboxPolicy = { kind: "read-only", network: false };
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "",
      stderr: "touch: cannot create 'x': Read-only file system",
      exitCode: 1,
      sandbox: "linux-bwrap",
    }));

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "touch x" });
    // Read-only roles must not be lifted to danger-full-access on denial.
    expect(approveFn).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
  });

  test("does not escalate a scoped child's targetPath denial (even in yolo)", async () => {
    const dir = await tmpDir();
    const approveFn = mock(async () => true); // simulates yolo auto-approve
    const ctx = makeCtx(dir, { agentTargetPaths: [path.join(dir, "src")] });
    ctx.approveCommand = approveFn;
    bashInternal.setRunShellCommandForTests(async () => ({
      stdout: "",
      stderr: "touch: cannot touch '../outside': Read-only file system",
      exitCode: 1,
      sandbox: "linux-bwrap",
    }));

    const t: any = createBashTool(ctx);
    const res = await t.execute({ command: "touch ../outside" });
    // Escalating a scoped child to full access would bypass its targetPaths.
    expect(approveFn).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
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
