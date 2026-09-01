import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { UnsafeShimArgumentError } from "../../src/platform/exec";
import { hostPlatform } from "../../src/platform/host";
import { __internal, isAlive, killTree, run, spawnStreaming } from "../../src/platform/proc";
import { execFileCompat } from "../../src/utils/execFileCompat";

const IS_WIN = hostPlatform() === "win32";
const BUN = process.execPath;

let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "platform-proc-test-"));
});

afterAll(() => {
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Heartbeat writers may have straggled; best effort.
  }
});

function scratchFile(name: string): string {
  return path.join(scratch, name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Child script: spawns a grandchild that appends a heartbeat byte to
 * `heartbeatPath` every 40ms, then blocks forever. Used to prove tree kills
 * reach the grandchild (row-14 proof).
 */
function heartbeatTreeScript(heartbeatPath: string): string {
  const grandchild = `
    const fs = require("node:fs");
    setInterval(() => { try { fs.appendFileSync(${JSON.stringify(heartbeatPath)}, "x"); } catch {} }, 40);
  `;
  return `
    Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchild)}], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    setInterval(() => {}, 1000);
  `;
}

function termIgnoringHeartbeatTreeScript(heartbeatPath: string): string {
  const grandchild = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    setInterval(() => { try { fs.appendFileSync(${JSON.stringify(heartbeatPath)}, "x"); } catch {} }, 40);
  `;
  return `
    Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchild)}], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    setInterval(() => {}, 1000);
  `;
}

/**
 * Asserts the heartbeat file stops growing (the whole tree is dead).
 *
 * Polls for a quiet window instead of sleeping a fixed settle so instant
 * kills (win32 taskkill /T /F) return after one window while slow kills
 * (the posix 3s SIGTERM→SIGKILL escalation) keep observing growth until
 * the kill lands, under a generous deadline.
 */
async function expectHeartbeatStopped(heartbeatPath: string, deadlineMs = 10_000): Promise<void> {
  // The grandchild appends every 40ms; a windowful of missed writes means
  // the writer is dead.
  const quietWindowMs = 300;
  const deadline = Date.now() + deadlineMs;
  let size1: number;
  let size2: number;
  do {
    size1 = fileSize(heartbeatPath);
    await sleep(quietWindowMs);
    size2 = fileSize(heartbeatPath);
    if (size2 === size1) break;
  } while (Date.now() < deadline);
  expect(size2).toBe(size1);
}

describe("proc.run — execFileCompat contract parity", () => {
  test("captures stdout/stderr and exit code identically to execFileCompat", async () => {
    const args = ["-e", 'console.log("out"); console.error("err"); process.exit(3);'];
    const [ours, compat] = await Promise.all([run(BUN, args), execFileCompat(BUN, args)]);
    expect(ours.stdout).toContain("out");
    expect(ours.stderr).toContain("err");
    expect(ours.exitCode).toBe(3);
    expect(ours.errorCode).toBeUndefined();
    expect(ours).toEqual(compat);
  });

  test("missing executable → exitCode 1, errorCode ENOENT (same as execFileCompat)", async () => {
    const [ours, compat] = await Promise.all([
      run("platform-proc-no-such-binary-xyz", []),
      execFileCompat("platform-proc-no-such-binary-xyz", []),
    ]);
    expect(ours).toEqual({ stdout: "", stderr: "", exitCode: 1, errorCode: "ENOENT" });
    expect(ours).toEqual(compat);
  });

  test("timeout → exitCode 124, errorCode TIMEOUT, pre-kill output preserved", async () => {
    const result = await run(BUN, ["-e", 'console.log("started"); await new Promise(() => {});'], {
      timeoutMs: 500,
    });
    expect(result.exitCode).toBe(124);
    expect(result.errorCode).toBe("TIMEOUT");
    expect(result.stdout).toContain("started");
  }, 15000);

  test("abort → exitCode 130, errorCode ABORT_ERR", async () => {
    const controller = new AbortController();
    const promise = run(BUN, ["-e", "await new Promise(() => {});"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    expect(result.exitCode).toBe(130);
    expect(result.errorCode).toBe("ABORT_ERR");
  }, 15000);

  test("pre-aborted signal returns ABORT_ERR without spawning a process", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("A pre-aborted command must not spawn");
    });
    try {
      const result = await run(BUN, ["-e", "await new Promise(() => {});"], {
        signal: controller.signal,
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(result).toEqual({ stdout: "", stderr: "", exitCode: 130, errorCode: "ABORT_ERR" });
    } finally {
      spawn.mockRestore();
    }
  });

  test("maxBuffer overflow → errorCode ERR_CHILD_PROCESS_STDIO_MAXBUFFER, exit 1", async () => {
    const result = await run(BUN, ["-e", 'process.stdout.write("x".repeat(4096));'], {
      maxBuffer: 64,
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(result.stdout).toBe("x".repeat(64));
  }, 15000);

  test("maxBuffer truncation is code-point safe (no U+FFFD from a split code point)", async () => {
    // Six 2-byte "é" = 12 bytes; a 7-byte cap slices the 4th "é" in half.
    // The old execFileCompat decoded that half byte to U+FFFD; run() must
    // drop the split code point whole.
    const result = await run(BUN, ["-e", 'process.stdout.write("\\u00e9".repeat(6));'], {
      maxBuffer: 7,
    });
    expect(result.errorCode).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(result.stdout).toBe("é".repeat(3));
    expect(result.stdout).not.toContain("�");
  }, 15000);

  test("encoding option decodes child output via text.decodeChildOutput", async () => {
    const result = await run(
      BUN,
      ["-e", 'process.stdout.write(Buffer.from("h\\u00e9llo w\\u00f6rld", "utf16le"));'],
      { encoding: "utf-16le" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("héllo wörld");
  });

  test("env replaces the child environment; cwd is honored", async () => {
    const result = await run(
      BUN,
      [
        "-e",
        'console.log(process.env.PLATFORM_PROC_MARKER ?? "missing"); console.log(process.cwd());',
      ],
      { cwd: scratch, env: { ...process.env, PLATFORM_PROC_MARKER: "yes" } },
    );
    expect(result.exitCode).toBe(0);
    const [marker, cwd] = result.stdout.split(/\r?\n/);
    expect(marker).toBe("yes");
    // The child may report a canonical spelling for an aliased host path
    // (macOS commonly exposes /var through /private/var). Compare filesystem
    // identity, while still allowing win32 drive-letter case differences.
    expect(fs.realpathSync.native(cwd ?? "").toLowerCase()).toBe(
      fs.realpathSync.native(scratch).toLowerCase(),
    );
  });
});

describe("proc.run — tree kill (row-14 proof)", () => {
  test("timeout kills the WHOLE tree: grandchild heartbeat stops", async () => {
    const heartbeat = scratchFile("run-timeout-heartbeat.txt");
    const result = await run(BUN, ["-e", heartbeatTreeScript(heartbeat)], {
      timeoutMs: 900,
    });
    expect(result.errorCode).toBe("TIMEOUT");
    expect(result.exitCode).toBe(124);
    // The grandchild must have actually run before the kill.
    expect(await waitFor(() => fileSize(heartbeat) > 0, 2000)).toBe(true);
    await expectHeartbeatStopped(heartbeat);
  }, 20000);

  test("hard-kill escalation survives root exit and reaps a TERM-ignoring grandchild", async () => {
    const heartbeat = scratchFile("run-timeout-term-ignoring-heartbeat.txt");
    const result = await run(BUN, ["-e", termIgnoringHeartbeatTreeScript(heartbeat)], {
      timeoutMs: 900,
    });
    expect(result.errorCode).toBe("TIMEOUT");
    expect(await waitFor(() => fileSize(heartbeat) > 0, 2000)).toBe(true);
    // The posix branch only reaps the TERM-ignoring grandchild after the 3s
    // SIGKILL escalation; the poll waits it out without a fixed dead sleep.
    await expectHeartbeatStopped(heartbeat);
  }, 20000);
});

describe.if(IS_WIN)("proc.run — resolve routing through exec.resolveSpawn (win32 live)", () => {
  let shimDir: string;
  let env: Record<string, string | undefined>;

  beforeAll(() => {
    shimDir = scratchFile("shims");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "hello-shim.cmd"), "@echo hello-from-shim\r\n");
    env = { ...process.env, PATH: `${shimDir};${process.env.PATH ?? ""}` };
  });

  test("resolve: true runs a .cmd batch shim found on PATH", async () => {
    const result = await run("hello-shim", [], { resolve: true, env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-from-shim");
  }, 15000);

  test("unsafe batch-shim argument → errorCode UNSAFE_SHIM_ARGUMENT, no spawn", async () => {
    const result = await run("hello-shim", ['a"b'], { resolve: true, env });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("UNSAFE_SHIM_ARGUMENT");
    expect(result.stderr).toContain("Unsafe batch-shim argument");
  });

  test("spawnStreaming with resolve: true throws UnsafeShimArgumentError", () => {
    expect(() => spawnStreaming("hello-shim", ['a"b'], { resolve: true, env })).toThrow(
      UnsafeShimArgumentError,
    );
  });
});

describe("proc.spawnStreaming", () => {
  test("streams stdout and resolves exited with reason 'exited'", async () => {
    const handle = spawnStreaming(BUN, ["-e", 'console.log("hello stream");']);
    expect(typeof handle.pid).toBe("number");
    const [text, close] = await Promise.all([new Response(handle.stdout).text(), handle.exited]);
    expect(text).toContain("hello stream");
    expect(close).toEqual({ reason: "exited", code: 0 });
    expect(handle.exitCode).toBe(0);
  });

  test("stderr is piped separately", async () => {
    const handle = spawnStreaming(BUN, ["-e", 'console.error("to stderr");']);
    const [out, err] = await Promise.all([
      new Response(handle.stdout).text(),
      new Response(handle.stderr).text(),
    ]);
    expect(out).toBe("");
    expect(err).toContain("to stderr");
    await handle.exited;
  });

  test("stdin: 'pipe' exposes writeStdin/endStdin; 'ignore' does not", async () => {
    const echo = `
      const chunks = [];
      for await (const c of Bun.stdin.stream()) chunks.push(Buffer.from(c));
      process.stdout.write(Buffer.concat(chunks));
    `;
    const handle = spawnStreaming(BUN, ["-e", echo], { stdin: "pipe" });
    expect(handle.writeStdin).toBeDefined();
    expect(handle.endStdin).toBeDefined();
    handle.writeStdin?.("ping");
    handle.endStdin?.();
    const [text, close] = await Promise.all([new Response(handle.stdout).text(), handle.exited]);
    expect(text).toBe("ping");
    expect(close.reason).toBe("exited");

    const ignored = spawnStreaming(BUN, ["-e", "1;"]);
    expect(ignored.writeStdin).toBeUndefined();
    expect(ignored.endStdin).toBeUndefined();
    await ignored.exited;
  }, 15000);

  test("spawn failure throws (ENOENT contract of the old subprocess.ts)", () => {
    expect(() => spawnStreaming("platform-proc-no-such-binary-xyz", [])).toThrow();
  });

  test("killTree stops the grandchild heartbeat and reports reason 'terminated'", async () => {
    const heartbeat = scratchFile("streaming-killtree-heartbeat.txt");
    const handle = spawnStreaming(BUN, ["-e", heartbeatTreeScript(heartbeat)]);
    // Wait until the grandchild demonstrably runs.
    expect(await waitFor(() => fileSize(heartbeat) > 2, 10000)).toBe(true);
    await handle.killTree();
    const close = await handle.exited;
    expect(close.reason).toBe("terminated");
    await expectHeartbeatStopped(heartbeat);
  }, 20000);

  test("standalone killTree(handle) delegates to handle.killTree()", async () => {
    const handle = spawnStreaming(BUN, ["-e", "setInterval(() => {}, 1000);"]);
    await killTree(handle);
    const close = await handle.exited;
    expect(close.reason).toBe("terminated");
  }, 15000);
});

describe("proc.killTree — posix branch (unit, injected kill)", () => {
  test("kills the process group via kill(-pid, SIGKILL) by default", async () => {
    const calls: Array<[number, string]> = [];
    await killTree(1234, {
      platform: "linux",
      kill: (pid, signal) => {
        calls.push([pid, signal]);
      },
    });
    expect(calls).toEqual([[-1234, "SIGKILL"]]);
  });

  test("honors a custom signal", async () => {
    const calls: Array<[number, string]> = [];
    await killTree(1234, {
      platform: "darwin",
      signal: "SIGTERM",
      kill: (pid, signal) => {
        calls.push([pid, signal]);
      },
    });
    expect(calls).toEqual([[-1234, "SIGTERM"]]);
  });

  test("falls back to a direct kill when the group kill throws", async () => {
    const calls: Array<[number, string]> = [];
    await killTree(1234, {
      platform: "linux",
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      },
    });
    expect(calls).toEqual([
      [-1234, "SIGKILL"],
      [1234, "SIGKILL"],
    ]);
  });

  test("swallows errors when both group and direct kill fail", async () => {
    await expect(
      killTree(1234, {
        platform: "linux",
        kill: () => {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("delayed hard escalation never falls back to a stale root pid", () => {
    const calls: Array<[number, string]> = [];
    __internal.killDetachedPosixGroup(1234, "SIGKILL", (pid, signal) => {
      calls.push([pid, signal]);
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(calls).toEqual([[-1234, "SIGKILL"]]);
  });
});

describe("proc.killTree — win32 Node compatibility", () => {
  test("uses bounded taskkill without a Bun global", async () => {
    const bundle = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "../../src/platform/processTree.ts")],
      target: "node",
      format: "cjs",
    });
    const output = bundle.outputs[0];
    if (!bundle.success || !output) throw new Error("Could not bundle the Node process helper");
    const nodeModule = { exports: {} as typeof import("../../src/platform/processTree") };
    const context = vm.createContext({
      module: nodeModule,
      exports: nodeModule.exports,
      require: createRequire(import.meta.url),
      process,
    });
    expect(vm.runInContext("typeof Bun", context)).toBe("undefined");
    vm.runInContext(await output.text(), context);
    const directKill = spyOn(process, "kill").mockReturnValue(true);
    const calls: unknown[] = [];
    try {
      await nodeModule.exports.killTree(1234, {
        platform: "win32",
        execFile: (file, args, options, callback) => {
          calls.push([file, args, options]);
          callback(null);
        },
      });
      expect(calls).toEqual([
        [
          "taskkill",
          ["/PID", "1234", "/T", "/F"],
          { windowsHide: true, timeout: 5000, killSignal: "SIGKILL" },
        ],
      ]);
      expect(directKill).not.toHaveBeenCalled();
    } finally {
      directKill.mockRestore();
    }
  });

  test.each([
    Object.assign(new Error("taskkill unavailable"), { code: "ENOENT" }),
    Object.assign(new Error("taskkill failed"), { code: 1 }),
    Object.assign(new Error("taskkill timed out"), { killed: true, signal: "SIGKILL" }),
  ])("falls back to a direct kill when %s", async (error) => {
    const bunSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Bun spawning is unavailable in Node");
    });
    const directKill = spyOn(process, "kill").mockReturnValue(true);
    try {
      await killTree(1234, {
        platform: "win32",
        execFile: (_file, _args, _options, callback) => callback(error),
      });
      expect(directKill).toHaveBeenCalledWith(1234, "SIGKILL");
    } finally {
      directKill.mockRestore();
      bunSpawn.mockRestore();
    }
  });

  test("swallows spawn and fallback failures for an already-gone process", async () => {
    const bunSpawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Bun spawning is unavailable in Node");
    });
    const directKill = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    try {
      await expect(
        killTree(1234, {
          platform: "win32",
          execFile: () => {
            throw new Error("spawn failed");
          },
        }),
      ).resolves.toBeUndefined();
      expect(directKill).toHaveBeenCalledWith(1234, "SIGKILL");
    } finally {
      directKill.mockRestore();
      bunSpawn.mockRestore();
    }
  });
});

describe("proc.isAlive", () => {
  test("policy matrix: ESRCH → dead; EPERM → alive; any other error → alive", () => {
    const throwing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(isAlive(42, { kill: throwing("ESRCH") })).toBe(false);
    expect(isAlive(42, { kill: throwing("EPERM") })).toBe(true);
    expect(isAlive(42, { kill: throwing("EINVAL") })).toBe(true);
    expect(isAlive(42, { kill: throwing("EWEIRD") })).toBe(true);
    expect(isAlive(42, { kill: () => undefined })).toBe(true);
    // Errors without a string code are also conservative-alive.
    expect(
      isAlive(42, {
        kill: () => {
          throw new Error("no code");
        },
      }),
    ).toBe(true);
  });

  test("live: own process and a running child are alive; an exited child eventually is not", async () => {
    expect(isAlive(process.pid)).toBe(true);
    const handle = spawnStreaming(BUN, ["-e", "setInterval(() => {}, 1000);"]);
    expect(isAlive(handle.pid)).toBe(true);
    await handle.killTree();
    await handle.exited;
    // Handle release/PID table update can lag the exit notification briefly.
    expect(await waitFor(() => !isAlive(handle.pid), 5000, 50)).toBe(true);
  }, 15000);
});
