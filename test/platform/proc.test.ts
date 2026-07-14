import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { UnsafeShimArgumentError } from "../../src/platform/exec";
import { hostPlatform } from "../../src/platform/host";
import {
  __internal,
  type ChildHandle,
  type CloseInfo,
  isAlive,
  killTree,
  onShutdownRequest,
  registerShutdownSignals,
  run,
  spawnStreaming,
  type TerminableHandle,
  terminateGracefully,
} from "../../src/platform/proc";
import { execFileCompat } from "../../src/utils/execFileCompat";

const IS_WIN = hostPlatform() === "win32";
const BUN = process.execPath;
const PROC_MODULE_URL = pathToFileURL(
  path.resolve(import.meta.dir, "../../src/platform/proc.ts"),
).href;

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

  test("pre-aborted signal terminates immediately with ABORT_ERR", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(BUN, ["-e", "await new Promise(() => {});"], {
      signal: controller.signal,
    });
    expect(result.exitCode).toBe(130);
    expect(result.errorCode).toBe("ABORT_ERR");
  }, 15000);

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

type FakeHandleEvents = {
  handle: TerminableHandle;
  events: string[];
  resolveExit: (close: CloseInfo) => void;
};

function makeFakeHandle(
  opts: { piped?: boolean; exitOn?: "kill" | "killTree" | "endStdin" | "never" } = {},
): FakeHandleEvents {
  const events: string[] = [];
  let resolveExit!: (close: CloseInfo) => void;
  const exited = new Promise<CloseInfo>((resolve) => {
    resolveExit = resolve;
  });
  const handle: TerminableHandle = {
    exited,
    kill(signal) {
      events.push(`kill:${String(signal)}`);
      if (opts.exitOn === "kill") resolveExit({ reason: "exited", code: 0 });
    },
    async killTree() {
      events.push("killTree");
      if (opts.exitOn === "killTree") resolveExit({ reason: "terminated", code: 1 });
    },
  };
  if (opts.piped) {
    handle.endStdin = () => {
      events.push("endStdin");
      if (opts.exitOn === "endStdin") resolveExit({ reason: "exited", code: 0 });
    };
  }
  return { handle, events, resolveExit };
}

describe("proc.terminateGracefully — unit (fake handles, every branch on every host)", () => {
  test("posix: SIGTERM, child exits within grace → reason 'exited', no killTree", async () => {
    const { handle, events } = makeFakeHandle({ exitOn: "kill" });
    const close = await terminateGracefully(handle, { platform: "linux", graceMs: 2000 });
    expect(close).toEqual({ reason: "exited", code: 0 });
    expect(events).toEqual(["kill:SIGTERM"]);
  });

  test("posix: child ignores SIGTERM → killTree after graceMs → reason 'terminated'", async () => {
    const { handle, events } = makeFakeHandle({ exitOn: "killTree" });
    const started = Date.now();
    const close = await terminateGracefully(handle, { platform: "darwin", graceMs: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(close).toEqual({ reason: "terminated", code: 1 });
    expect(events).toEqual(["kill:SIGTERM", "killTree"]);
  });

  test("win32: requestShutdown is called and takes precedence over the stdin sentinel", async () => {
    const { handle, events, resolveExit } = makeFakeHandle({ piped: true });
    const order: string[] = [];
    const close = await terminateGracefully(handle, {
      platform: "win32",
      graceMs: 2000,
      requestShutdown: async () => {
        order.push("requestShutdown");
        resolveExit({ reason: "exited", code: 0 });
      },
    });
    expect(order).toEqual(["requestShutdown"]);
    expect(close).toEqual({ reason: "exited", code: 0 });
    expect(events).toEqual([]); // no SIGTERM, no endStdin, no killTree
  });

  test("win32: requestShutdown failure still gets a grace window before killTree", async () => {
    const { handle, events } = makeFakeHandle({ exitOn: "killTree" });
    const started = Date.now();
    const close = await terminateGracefully(handle, {
      platform: "win32",
      graceMs: 60,
      requestShutdown: async () => {
        throw new Error("rpc transport already closed");
      },
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(close).toEqual({ reason: "terminated", code: 1 });
    expect(events).toEqual(["killTree"]);
  });

  test("win32: piped stdin → endStdin is the graceful channel", async () => {
    const { handle, events } = makeFakeHandle({ piped: true, exitOn: "endStdin" });
    const close = await terminateGracefully(handle, { platform: "win32", graceMs: 2000 });
    expect(close).toEqual({ reason: "exited", code: 0 });
    expect(events).toEqual(["endStdin"]);
  });

  test("win32: NO channel (stdin ignored, no requestShutdown) → immediate killTree, no grace wait", async () => {
    const { handle, events } = makeFakeHandle({ exitOn: "killTree" });
    const started = Date.now();
    const close = await terminateGracefully(handle, { platform: "win32", graceMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(close).toEqual({ reason: "terminated", code: 1 });
    expect(events).toEqual(["killTree"]);
  });
});

describe("proc.terminateGracefully — live children (win32 mechanisms, portable)", () => {
  test("piped stdin EOF: child exits GRACEFULLY (marker written) → reason 'exited', code 0", async () => {
    const marker = scratchFile("graceful-stdin-eof.txt");
    const child = `
      const fs = require("node:fs");
      (async () => {
        for await (const _ of Bun.stdin.stream()) {}
        fs.writeFileSync(${JSON.stringify(marker)}, "graceful");
        process.exit(0);
      })();
    `;
    const handle = spawnStreaming(BUN, ["-e", child], { stdin: "pipe", platform: "win32" });
    const close = await handle.terminateGracefully({ graceMs: 8000 });
    expect(close).toEqual({ reason: "exited", code: 0 });
    expect(fs.readFileSync(marker, "utf8")).toBe("graceful");
  }, 20000);

  test("requestShutdown: caller-wired channel makes the child exit → reason 'exited'", async () => {
    const sentinel = scratchFile("graceful-request-shutdown.txt");
    const child = `
      const fs = require("node:fs");
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(sentinel)})) { clearInterval(timer); process.exit(0); }
      }, 25);
    `;
    const handle = spawnStreaming(BUN, ["-e", child], { platform: "win32" });
    const close = await handle.terminateGracefully({
      graceMs: 8000,
      requestShutdown: async () => {
        fs.writeFileSync(sentinel, "1");
      },
    });
    expect(close).toEqual({ reason: "exited", code: 0 });
  }, 20000);

  test("unresponsive child escalates to the hard tree kill → reason 'terminated'", async () => {
    const handle = spawnStreaming(BUN, ["-e", "setInterval(() => {}, 1000);"], {
      platform: "win32",
    });
    const close = await handle.terminateGracefully({
      graceMs: 250,
      requestShutdown: async () => {}, // channel exists but the child ignores it
    });
    expect(close.reason).toBe("terminated");
  }, 20000);

  test.if(!IS_WIN)(
    "posix live: SIGTERM handler runs → reason 'exited'",
    async () => {
      const marker = scratchFile("graceful-sigterm.txt");
      const child = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
        fs.writeFileSync(${JSON.stringify(marker)}, "graceful");
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    `;
      const handle = spawnStreaming(BUN, ["-e", child]);
      // Give the child a beat to install its handler.
      await sleep(400);
      const close = await handle.terminateGracefully({ graceMs: 8000 });
      expect(close).toEqual({ reason: "exited", code: 0 });
      expect(fs.readFileSync(marker, "utf8")).toBe("graceful");
    },
    20000,
  );
});

describe("proc.registerShutdownSignals — signal wiring (in-process, every platform branch)", () => {
  test("posix: SIGINT/SIGTERM/SIGHUP registered; handler fires at most once", () => {
    const before = {
      int: process.listenerCount("SIGINT"),
      term: process.listenerCount("SIGTERM"),
      hup: process.listenerCount("SIGHUP"),
    };
    let calls = 0;
    const unregister = registerShutdownSignals(
      () => {
        calls += 1;
      },
      { platform: "linux" },
    );
    expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
    expect(process.listenerCount("SIGHUP")).toBe(before.hup + 1);

    process.emit("SIGTERM");
    expect(calls).toBe(1);
    process.emit("SIGHUP");
    process.emit("SIGINT");
    expect(calls).toBe(1); // at most once

    unregister();
    expect(process.listenerCount("SIGINT")).toBe(before.int);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
    expect(process.listenerCount("SIGHUP")).toBe(before.hup);
    process.emit("SIGTERM");
    expect(calls).toBe(1); // unregistered
  });

  test("win32: only SIGINT is registered; SIGTERM does not reach the handler", () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    let calls = 0;
    const unregister = registerShutdownSignals(
      () => {
        calls += 1;
      },
      { platform: "win32" },
    );
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    process.emit("SIGTERM");
    expect(calls).toBe(0);
    process.emit("SIGINT");
    expect(calls).toBe(1);
    unregister();
  });

  test("onShutdownRequest is the child-side alias with identical wiring", () => {
    let calls = 0;
    const unregister = onShutdownRequest(
      () => {
        calls += 1;
      },
      { platform: "win32" },
    );
    process.emit("SIGINT");
    expect(calls).toBe(1);
    unregister();
  });
});

describe("proc.registerShutdownSignals — stdin-EOF opt-in gating", () => {
  test("stdinEof: true fires the handler when the (injected) stdin stream ends", async () => {
    let calls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ignored input\n"));
        controller.close();
      },
    });
    const unregister = registerShutdownSignals(
      () => {
        calls += 1;
      },
      { platform: "win32", stdinEof: true, stdinStream: stream },
    );
    expect(await waitFor(() => calls === 1, 2000)).toBe(true);
    unregister();
  });

  test("without stdinEof the stdin stream is never consumed and the handler never fires", async () => {
    let calls = 0;
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
      pull() {
        pulled = true;
      },
    });
    const unregister = registerShutdownSignals(
      () => {
        calls += 1;
      },
      { platform: "win32", stdinStream: stream },
    );
    await sleep(150);
    expect(calls).toBe(0);
    expect(pulled).toBe(false);
    unregister();
  });

  test("unregister cancels the stdin watcher before EOF fires the handler", async () => {
    let calls = 0;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const unregister = registerShutdownSignals(
      () => {
        calls += 1;
      },
      { platform: "linux", stdinEof: true, stdinStream: stream },
    );
    unregister();
    try {
      controller.close();
    } catch {
      // Already cancelled by unregister.
    }
    await sleep(150);
    expect(calls).toBe(0);
  });
});

describe("proc.registerShutdownSignals — live children (NIT 8 headless gating)", () => {
  test("opted-in child exits gracefully when the parent closes its stdin", async () => {
    const marker = scratchFile("shutdown-optin.txt");
    const child = `
      import(${JSON.stringify(PROC_MODULE_URL)}).then(({ onShutdownRequest }) => {
        onShutdownRequest(() => {
          require("node:fs").writeFileSync(${JSON.stringify(marker)}, "eof");
          process.exit(0);
        }, { stdinEof: true });
      });
      setInterval(() => {}, 1000);
    `;
    const handle = spawnStreaming(BUN, ["-e", child], { stdin: "pipe" });
    // Let the child import the module and register before signaling EOF.
    await sleep(700);
    handle.endStdin?.();
    const close = await handle.exited;
    expect(close.code).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("eof");
  }, 20000);

  test("non-opted child with a closed stdin does NOT exit at boot (headless server case)", async () => {
    const marker = scratchFile("shutdown-not-opted.txt");
    const child = `
      import(${JSON.stringify(PROC_MODULE_URL)}).then(({ onShutdownRequest }) => {
        onShutdownRequest(() => {
          require("node:fs").writeFileSync(${JSON.stringify(marker)}, "eof");
          process.exit(0);
        });
      });
      setInterval(() => {}, 1000);
    `;
    // stdin: "ignore" ≈ `bun run serve < /dev/null` — stdin is at EOF from boot.
    const handle = spawnStreaming(BUN, ["-e", child]);
    await sleep(900);
    expect(isAlive(handle.pid)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    await handle.killTree();
    await handle.exited;
  }, 20000);
});

// Type-level check: a real handle satisfies the structural TerminableHandle.
const _typeCheck = (h: ChildHandle): TerminableHandle => h;
void _typeCheck;
