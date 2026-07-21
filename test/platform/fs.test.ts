import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireLockDir,
  FileLockedError,
  type FsLike,
  hardenPrivateDir,
  hardenPrivateDirSync,
  hardenPrivateFile,
  hardenPrivateFileSync,
  type LockDirOwner,
  moveWithFallback,
  removeWithRetry,
  replaceExecutableAtomic,
  replaceFileAtomic,
  SymlinkPrivilegeError,
  symlink,
  writeFileAtomic,
} from "../../src/platform/fs";
import { hostPlatform } from "../../src/platform/host";

const isWindowsHost = hostPlatform() === "win32";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-fs-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const instantSleep = async (_ms: number): Promise<void> => {};

const baseFs: FsLike = {
  chmod: fsp.chmod,
  copyFile: fsp.copyFile,
  cp: fsp.cp,
  mkdir: fsp.mkdir,
  open: fsp.open,
  readdir: fsp.readdir,
  readFile: fsp.readFile,
  rename: fsp.rename,
  rm: fsp.rm,
  stat: fsp.stat,
  symlink: fsp.symlink,
  unlink: fsp.unlink,
  writeFile: fsp.writeFile,
};

function fsWith(overrides: Partial<FsLike>): FsLike {
  return { ...baseFs, ...overrides };
}

function codeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

/** rename fake that throws `code` for the first `failures` calls, then delegates. */
function flakyRename(
  code: string,
  failures: number,
): { impl: FsLike["rename"]; calls: () => number } {
  let calls = 0;
  const impl: FsLike["rename"] = async (from, to) => {
    calls += 1;
    if (calls <= failures) throw codeError(code);
    await fsp.rename(from, to);
  };
  return { impl, calls: () => calls };
}

describe("writeFileAtomic", () => {
  test("writes string content and creates missing parent directories", async () => {
    const target = path.join(tmpDir, "deep", "nested", "file.txt");
    await writeFileAtomic(target, "hello atomic");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello atomic");
  });

  test("round-trips Uint8Array payloads byte-for-byte", async () => {
    const target = path.join(tmpDir, "bytes.bin");
    const payload = new Uint8Array([0, 1, 2, 255, 128, 7]);
    await writeFileAtomic(target, payload);
    expect(new Uint8Array(fs.readFileSync(target))).toEqual(payload);
  });

  test("overwrites an existing file", async () => {
    const target = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(target, "old");
    await writeFileAtomic(target, "new");
    expect(fs.readFileSync(target, "utf-8")).toBe("new");
  });

  test("concurrent readers only ever observe a complete old or new payload", async () => {
    const target = path.join(tmpDir, "concurrent.txt");
    const payloadA = "A".repeat(8192);
    const payloadB = "B".repeat(8192);
    await writeFileAtomic(target, payloadA);
    let torn: string | undefined;
    let stopped = false;
    const reader = (async () => {
      while (!stopped) {
        try {
          const content = fs.readFileSync(target, "utf-8");
          if (content !== payloadA && content !== payloadB) {
            torn = content.slice(0, 64);
            return;
          }
        } catch {
          // Transient open failures during rename-over are the writer's retry
          // domain; atomicity only promises no PARTIAL content is observable.
        }
        await Bun.sleep(0);
      }
    })();
    for (let i = 0; i < 40; i += 1) {
      await writeFileAtomic(target, i % 2 === 0 ? payloadB : payloadA);
    }
    stopped = true;
    await reader;
    expect(torn).toBeUndefined();
  });

  test("win32: retries rename on EPERM/EACCES/EBUSY with backoff and succeeds", async () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const target = path.join(tmpDir, `retry-${code}.txt`);
      const rename = flakyRename(code, 2);
      const sleeps: number[] = [];
      await writeFileAtomic(
        target,
        "payload",
        {},
        {
          fsImpl: fsWith({ rename: rename.impl }),
          platform: "win32",
          sleepImpl: async (ms) => {
            sleeps.push(ms);
          },
        },
      );
      expect(fs.readFileSync(target, "utf-8")).toBe("payload");
      expect(rename.calls()).toBe(3);
      expect(sleeps).toEqual([20, 40]); // exponential backoff from 20ms
    }
  });

  test("posix: does NOT retry rename lock codes — first EPERM propagates", async () => {
    const target = path.join(tmpDir, "posix-no-retry.txt");
    const rename = flakyRename("EPERM", 99);
    await expect(
      writeFileAtomic(
        target,
        "x",
        {},
        {
          fsImpl: fsWith({ rename: rename.impl }),
          platform: "linux",
          sleepImpl: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(rename.calls()).toBe(1);
  });

  test("win32: retry budget is bounded; failure cleans up the temp file and keeps dest intact", async () => {
    const target = path.join(tmpDir, "exhausted.txt");
    fs.writeFileSync(target, "original");
    const rename = flakyRename("EBUSY", 99);
    await expect(
      writeFileAtomic(
        target,
        "replacement",
        {},
        {
          fsImpl: fsWith({ rename: rename.impl }),
          platform: "win32",
          sleepImpl: instantSleep,
          maxAttempts: 3,
        },
      ),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(rename.calls()).toBe(3);
    expect(fs.readFileSync(target, "utf-8")).toBe("original");
    const leftovers = fs.readdirSync(tmpDir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("fsync: true syncs the temp file before publishing", async () => {
    const target = path.join(tmpDir, "fsynced.txt");
    await writeFileAtomic(target, "durable", { fsync: true });
    expect(fs.readFileSync(target, "utf-8")).toBe("durable");
  });

  test.skipIf(isWindowsHost)("mode is applied to the published file on posix hosts", async () => {
    const target = path.join(tmpDir, "moded.txt");
    await writeFileAtomic(target, "secret", { mode: 0o600 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("replaceFileAtomic", () => {
  test("renames source over dest on the same volume; source is gone", async () => {
    const source = path.join(tmpDir, "source.txt");
    const dest = path.join(tmpDir, "dest.txt");
    fs.writeFileSync(source, "new content");
    fs.writeFileSync(dest, "old content");
    await replaceFileAtomic(source, dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("new content");
    expect(fs.existsSync(source)).toBe(false);
  });

  test("EXDEV falls back to copy+fsync+rename and removes the source", async () => {
    const source = path.join(tmpDir, "xdev-source.txt");
    const dest = path.join(tmpDir, "elsewhere", "xdev-dest.txt");
    fs.writeFileSync(source, "crossed a device");
    let directRenames = 0;
    const rename: FsLike["rename"] = async (from, to) => {
      if (from === source && to === dest) {
        directRenames += 1;
        throw codeError("EXDEV");
      }
      await fsp.rename(from, to); // temp → dest publish rename stays real
    };
    await replaceFileAtomic(source, dest, { fsImpl: fsWith({ rename }) });
    expect(directRenames).toBe(1);
    expect(fs.readFileSync(dest, "utf-8")).toBe("crossed a device");
    expect(fs.existsSync(source)).toBe(false);
    const leftovers = fs.readdirSync(path.dirname(dest)).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("never deletes dest first — no unlink/rm ever targets dest", async () => {
    const source = path.join(tmpDir, "nd-source.txt");
    const dest = path.join(tmpDir, "nd-dest.txt");
    fs.writeFileSync(source, "next");
    fs.writeFileSync(dest, "current");
    const removedPaths: string[] = [];
    const unlink: FsLike["unlink"] = async (p) => {
      removedPaths.push(String(p));
      await fsp.unlink(p);
    };
    const rm: FsLike["rm"] = async (p, o) => {
      removedPaths.push(String(p));
      await fsp.rm(p, o);
    };
    const rename: FsLike["rename"] = async (from, to) => {
      if (from === source && to === dest) throw codeError("EXDEV");
      await fsp.rename(from, to);
    };
    await replaceFileAtomic(source, dest, { fsImpl: fsWith({ rename, unlink, rm }) });
    expect(fs.readFileSync(dest, "utf-8")).toBe("next");
    expect(removedPaths).not.toContain(dest);
  });

  test("win32: retries lock codes on the rename-over", async () => {
    const source = path.join(tmpDir, "lock-source.txt");
    const dest = path.join(tmpDir, "lock-dest.txt");
    fs.writeFileSync(source, "eventually");
    fs.writeFileSync(dest, "held");
    const rename = flakyRename("EBUSY", 2);
    await replaceFileAtomic(source, dest, {
      fsImpl: fsWith({ rename: rename.impl }),
      platform: "win32",
      sleepImpl: instantSleep,
    });
    expect(rename.calls()).toBe(3);
    expect(fs.readFileSync(dest, "utf-8")).toBe("eventually");
  });

  test("non-EXDEV rename errors propagate untouched", async () => {
    const source = path.join(tmpDir, "missing-source.txt");
    const dest = path.join(tmpDir, "whatever.txt");
    await expect(replaceFileAtomic(source, dest)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("replaceExecutableAtomic", () => {
  test("posix: plain rename, no aside dance, returns finalPath", async () => {
    const source = path.join(tmpDir, "new-exe");
    const dest = path.join(tmpDir, "exe");
    fs.writeFileSync(source, "v2");
    fs.writeFileSync(dest, "v1");
    const renames: Array<[string, string]> = [];
    const rename: FsLike["rename"] = async (from, to) => {
      renames.push([String(from), String(to)]);
      await fsp.rename(from, to);
    };
    let readdirCalls = 0;
    const readdir = (async (...args: Parameters<FsLike["readdir"]>) => {
      readdirCalls += 1;
      return fsp.readdir(...(args as [string]));
    }) as FsLike["readdir"];
    const result = await replaceExecutableAtomic(source, dest, {
      fsImpl: fsWith({ rename, readdir }),
      platform: "linux",
    });
    expect(result.finalPath).toBe(dest);
    expect(renames).toEqual([[source, dest]]);
    expect(readdirCalls).toBe(0);
    expect(fs.readFileSync(dest, "utf-8")).toBe("v2");
  });

  test("win32: replaces an existing dest and cleans up its own aside file", async () => {
    const source = path.join(tmpDir, "next.exe");
    const dest = path.join(tmpDir, "tool.exe");
    fs.writeFileSync(source, "v2");
    fs.writeFileSync(dest, "v1");
    const result = await replaceExecutableAtomic(source, dest, { platform: "win32" });
    expect(result.finalPath).toBe(dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("v2");
    expect(fs.existsSync(source)).toBe(false);
    const asides = fs.readdirSync(tmpDir).filter((n) => n.startsWith("tool.exe.old-"));
    expect(asides).toEqual([]); // dest was not running, so the aside unlink succeeded
  });

  test("win32: works when dest does not exist yet", async () => {
    const source = path.join(tmpDir, "fresh.exe");
    const dest = path.join(tmpDir, "brand-new.exe");
    fs.writeFileSync(source, "v1");
    const result = await replaceExecutableAtomic(source, dest, { platform: "win32" });
    expect(result.finalPath).toBe(dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("v1");
  });

  test("win32: sweeps stale .old-* aside files from previous swaps", async () => {
    const source = path.join(tmpDir, "sweep-next.exe");
    const dest = path.join(tmpDir, "sweep.exe");
    fs.writeFileSync(source, "v3");
    fs.writeFileSync(dest, "v2");
    fs.writeFileSync(`${dest}.old-12345`, "v1-stale");
    fs.writeFileSync(`${dest}.old-99999`, "v0-stale");
    fs.writeFileSync(path.join(tmpDir, "unrelated.exe.old-1"), "keep me");
    await replaceExecutableAtomic(source, dest, { platform: "win32" });
    const entries = fs.readdirSync(tmpDir);
    expect(entries.filter((n) => n.startsWith("sweep.exe.old-"))).toEqual([]);
    expect(entries).toContain("unrelated.exe.old-1");
    expect(fs.readFileSync(dest, "utf-8")).toBe("v3");
  });

  test("win32: a still-locked aside (running exe) is tolerated and left behind", async () => {
    const source = path.join(tmpDir, "locked-next.exe");
    const dest = path.join(tmpDir, "locked.exe");
    fs.writeFileSync(source, "v2");
    fs.writeFileSync(dest, "v1");
    const asidePath = `${dest}.old-${process.pid}`;
    const unlink: FsLike["unlink"] = async (p) => {
      if (String(p) === asidePath) throw codeError("EBUSY"); // image still mapped
      await fsp.unlink(p);
    };
    const result = await replaceExecutableAtomic(source, dest, {
      fsImpl: fsWith({ unlink }),
      platform: "win32",
    });
    expect(result.finalPath).toBe(dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("v2");
    expect(fs.readFileSync(asidePath, "utf-8")).toBe("v1"); // swept by a later call
  });

  test("win32: rolls the aside back when the final rename keeps failing", async () => {
    const source = path.join(tmpDir, "rb-next.exe");
    const dest = path.join(tmpDir, "rb.exe");
    fs.writeFileSync(source, "v2");
    fs.writeFileSync(dest, "v1");
    const rename: FsLike["rename"] = async (from, to) => {
      if (String(from) === source && String(to) === dest) throw codeError("EPERM");
      await fsp.rename(from, to);
    };
    await expect(
      replaceExecutableAtomic(source, dest, {
        fsImpl: fsWith({ rename }),
        platform: "win32",
        sleepImpl: instantSleep,
        maxAttempts: 2,
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(fs.readFileSync(dest, "utf-8")).toBe("v1"); // rolled back — never left missing
  });
});

describe("moveWithFallback", () => {
  test("moves a file with a plain rename", async () => {
    const src = path.join(tmpDir, "move-me.txt");
    const dest = path.join(tmpDir, "moved.txt");
    fs.writeFileSync(src, "cargo");
    await moveWithFallback(src, dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("cargo");
    expect(fs.existsSync(src)).toBe(false);
  });

  test("moves a directory tree", async () => {
    const src = path.join(tmpDir, "dir-src");
    const dest = path.join(tmpDir, "dir-dest");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "sub", "deep.txt"), "deep");
    await moveWithFallback(src, dest);
    expect(fs.readFileSync(path.join(dest, "sub", "deep.txt"), "utf-8")).toBe("deep");
    expect(fs.existsSync(src)).toBe(false);
  });

  test("EXDEV falls back to copy+remove for files and directories", async () => {
    const srcDir = path.join(tmpDir, "xdev-dir");
    const destDir = path.join(tmpDir, "other-volume", "xdev-dir");
    fs.mkdirSync(path.join(srcDir, "inner"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, "inner", "f.txt"), "payload");
    const rename: FsLike["rename"] = async () => {
      throw codeError("EXDEV");
    };
    await moveWithFallback(srcDir, destDir, { fsImpl: fsWith({ rename }) });
    expect(fs.readFileSync(path.join(destDir, "inner", "f.txt"), "utf-8")).toBe("payload");
    expect(fs.existsSync(srcDir)).toBe(false);
  });

  test("win32: persistent lock codes become a typed FileLockedError after the retry budget", async () => {
    const src = path.join(tmpDir, "locked-src.txt");
    const dest = path.join(tmpDir, "locked-dest.txt");
    fs.writeFileSync(src, "held open");
    const rename = flakyRename("EBUSY", 99);
    let caught: unknown;
    try {
      await moveWithFallback(src, dest, {
        fsImpl: fsWith({ rename: rename.impl }),
        platform: "win32",
        sleepImpl: instantSleep,
        maxAttempts: 3,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FileLockedError);
    const lockError = caught as FileLockedError;
    expect(lockError.code).toBe("FILE_LOCKED");
    expect(lockError.lockedPath).toBe(src);
    expect((lockError.cause as NodeJS.ErrnoException).code).toBe("EBUSY");
    expect(rename.calls()).toBe(3); // bounded — never spins forever
    expect(fs.existsSync(src)).toBe(true); // nothing destroyed
  });

  test("posix: EPERM is a real answer — propagates raw with a single attempt", async () => {
    const src = path.join(tmpDir, "perm-src.txt");
    fs.writeFileSync(src, "x");
    const rename = flakyRename("EPERM", 99);
    let caught: unknown;
    try {
      await moveWithFallback(src, path.join(tmpDir, "perm-dest.txt"), {
        fsImpl: fsWith({ rename: rename.impl }),
        platform: "linux",
        sleepImpl: instantSleep,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(FileLockedError);
    expect((caught as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(rename.calls()).toBe(1);
  });

  test("non-lock errors (ENOENT) propagate immediately on win32 too", async () => {
    const rename = flakyRename("ENOENT", 99);
    await expect(
      moveWithFallback(path.join(tmpDir, "ghost"), path.join(tmpDir, "dest"), {
        fsImpl: fsWith({ rename: rename.impl }),
        platform: "win32",
        sleepImpl: instantSleep,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(rename.calls()).toBe(1);
  });
});

describe("removeWithRetry", () => {
  test("removes a file, and a directory tree with recursive: true", async () => {
    const file = path.join(tmpDir, "rm-file.txt");
    fs.writeFileSync(file, "x");
    await removeWithRetry(file);
    expect(fs.existsSync(file)).toBe(false);

    const dir = path.join(tmpDir, "rm-dir");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "f"), "x");
    await removeWithRetry(dir, { recursive: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  test("a missing target resolves quietly (force semantics)", async () => {
    await removeWithRetry(path.join(tmpDir, "never-existed"), { recursive: true });
  });

  test("win32: retries EPERM/EBUSY/ENOTEMPTY then succeeds", async () => {
    for (const code of ["EPERM", "EBUSY", "ENOTEMPTY"]) {
      const dir = path.join(tmpDir, `rm-retry-${code}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "f"), "x");
      let calls = 0;
      const rm: FsLike["rm"] = async (p, o) => {
        calls += 1;
        if (calls <= 2) throw codeError(code);
        await fsp.rm(p, o);
      };
      await removeWithRetry(
        dir,
        { recursive: true },
        {
          fsImpl: fsWith({ rm }),
          platform: "win32",
          sleepImpl: instantSleep,
        },
      );
      expect(calls).toBe(3);
      expect(fs.existsSync(dir)).toBe(false);
    }
  });

  test("win32: exhausted retries throw; bestEffort: true swallows the residual error", async () => {
    const dir = path.join(tmpDir, "rm-exhaust");
    fs.mkdirSync(dir);
    const rm: FsLike["rm"] = async () => {
      throw codeError("EBUSY");
    };
    const deps = {
      fsImpl: fsWith({ rm }),
      platform: "win32" as const,
      sleepImpl: instantSleep,
      maxAttempts: 2,
    };
    await expect(removeWithRetry(dir, { recursive: true }, deps)).rejects.toMatchObject({
      code: "EBUSY",
    });
    // Same failure with bestEffort resolves silently — cleanup-path semantics.
    await removeWithRetry(dir, { recursive: true, bestEffort: true }, deps);
  });

  test("posix: no retry loop — first EBUSY propagates", async () => {
    let calls = 0;
    const rm: FsLike["rm"] = async () => {
      calls += 1;
      throw codeError("EBUSY");
    };
    await expect(
      removeWithRetry(
        path.join(tmpDir, "posix-rm"),
        {},
        {
          fsImpl: fsWith({ rm }),
          platform: "linux",
          sleepImpl: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(1);
  });
});

describe("acquireLockDir", () => {
  const readOwner = (lockPath: string): LockDirOwner =>
    JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8")) as LockDirOwner;

  /** Writes a foreign lock dir as another (possibly dead) process would have left it. */
  function plantLock(lockPath: string, owner: Partial<LockDirOwner> | "corrupt" | "missing"): void {
    fs.mkdirSync(lockPath, { recursive: true });
    if (owner === "missing") return;
    const payload =
      owner === "corrupt"
        ? "{not json"
        : JSON.stringify({
            pid: 4242,
            hostname: os.hostname(),
            acquiredAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
            ...owner,
          });
    fs.writeFileSync(path.join(lockPath, "owner.json"), payload);
  }

  function spawnDeadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("failed to spawn probe child");
    return child.pid;
  }

  test("acquires a free lock, writes owner.json, and release removes the dir", async () => {
    const lockPath = path.join(tmpDir, "locks", "basic.lock");
    const handle = await acquireLockDir(lockPath);
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);
    const owner = readOwner(lockPath);
    expect(owner.pid).toBe(process.pid);
    expect(owner.hostname).toBe(os.hostname());
    expect(Date.parse(owner.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(owner.acquiredAt));
    await handle.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("release is idempotent", async () => {
    const lockPath = path.join(tmpDir, "idempotent.lock");
    const handle = await acquireLockDir(lockPath);
    await handle.release();
    await handle.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("contention: a second acquire waits and aborts via the signal while the lock is held", async () => {
    const lockPath = path.join(tmpDir, "contended.lock");
    const holder = await acquireLockDir(lockPath);
    await expect(
      acquireLockDir(lockPath, { signal: AbortSignal.timeout(200) }, { pollIntervalMs: 20 }),
    ).rejects.toThrow();
    expect(readOwner(lockPath).pid).toBe(process.pid); // still ours
    await holder.release();
  });

  test("a pre-aborted signal rejects immediately with the abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    controller.abort(reason);
    await expect(
      acquireLockDir(path.join(tmpDir, "aborted.lock"), { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  test("stale break: dead-pid owner.json is broken and the lock re-acquired (injected liveness)", async () => {
    const lockPath = path.join(tmpDir, "dead-owner.lock");
    plantLock(lockPath, { pid: 4242 });
    const handle = await acquireLockDir(lockPath, {}, { isAliveImpl: () => false });
    expect(readOwner(lockPath).pid).toBe(process.pid);
    await handle.release();
  });

  test("stale break: really-dead pid via the default kill(pid,0) liveness probe", async () => {
    const lockPath = path.join(tmpDir, "real-dead-owner.lock");
    plantLock(lockPath, { pid: spawnDeadPid() });
    const handle = await acquireLockDir(lockPath, {}, { pollIntervalMs: 10 });
    expect(readOwner(lockPath).pid).toBe(process.pid);
    await handle.release();
  });

  test("live-pid refusal: a live owner is NEVER stolen, even with an ancient heartbeat", async () => {
    const lockPath = path.join(tmpDir, "live-owner.lock");
    plantLock(lockPath, {
      pid: process.pid, // definitely alive
      acquiredAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(), // ancient — must not matter
    });
    await expect(
      acquireLockDir(
        lockPath,
        { staleMs: 1, signal: AbortSignal.timeout(200) },
        { pollIntervalMs: 20 },
      ),
    ).rejects.toThrow();
    expect(readOwner(lockPath).pid).toBe(process.pid);
  });

  test("another host's lock is never stolen even when the pid is locally dead", async () => {
    const lockPath = path.join(tmpDir, "foreign-host.lock");
    plantLock(lockPath, { pid: 4242, hostname: "definitely-not-this-host" });
    await expect(
      acquireLockDir(
        lockPath,
        { staleMs: 1, signal: AbortSignal.timeout(200) },
        { pollIntervalMs: 20, isAliveImpl: () => false },
      ),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(lockPath, "owner.json"))).toBe(true);
  });

  test.each(["corrupt", "missing"] as const)(
    "ownerless lock (%s owner.json): refused while fresh, broken once older than staleMs",
    async (kind) => {
      const lockPath = path.join(tmpDir, `ownerless-${kind}.lock`);
      plantLock(lockPath, kind);
      // Fresh dir: an acquirer may be mid-write — refuse within staleMs.
      await expect(
        acquireLockDir(
          lockPath,
          { staleMs: 60_000, signal: AbortSignal.timeout(200) },
          { pollIntervalMs: 20 },
        ),
      ).rejects.toThrow();
      // Once the dir is older than staleMs, the break goes through.
      await Bun.sleep(60);
      const handle = await acquireLockDir(lockPath, { staleMs: 20 }, { pollIntervalMs: 10 });
      expect(readOwner(lockPath).pid).toBe(process.pid);
      await handle.release();
    },
  );

  test("a delayed owner writer cannot overwrite a replacement acquirer's owner.json", async () => {
    const lockPath = path.join(tmpDir, "mid-acquire-replacement.lock");
    const ownerPath = path.join(lockPath, "owner.json");
    const startedAt = Date.now();
    let firstWriteStarted!: () => void;
    const firstWriteStartedPromise = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    let allowFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      allowFirstWrite = resolve;
    });
    const firstFs = fsWith({
      writeFile: (async (target, data, options) => {
        if (String(target) === ownerPath) {
          const handle = await fsp.open(target, "wx");
          try {
            firstWriteStarted();
            await firstWriteGate;
            await handle.writeFile(data);
          } finally {
            await handle.close();
          }
          return;
        }
        await fsp.writeFile(target, data, options);
      }) as FsLike["writeFile"],
    });

    const firstAttempt = acquireLockDir(
      lockPath,
      { staleMs: 1 },
      { fsImpl: firstFs, nowImpl: () => startedAt, pollIntervalMs: 1 },
    );
    await firstWriteStartedPromise;

    const replacement = await acquireLockDir(
      lockPath,
      { staleMs: 1 },
      { nowImpl: () => startedAt + 60_000, pollIntervalMs: 1 },
    );
    const replacementOwner = readOwner(lockPath);
    allowFirstWrite();

    await expect(firstAttempt).rejects.toMatchObject({ code: "LOCK_OWNERSHIP_LOST" });
    expect(readOwner(lockPath)).toEqual(replacementOwner);
    await replacement.release();
  });

  test("heartbeat() rewrites owner.json with a fresh heartbeatAt and preserves acquiredAt", async () => {
    const lockPath = path.join(tmpDir, "heartbeat.lock");
    let clock = 1_000_000;
    const handle = await acquireLockDir(lockPath, {}, { nowImpl: () => clock });
    const before = readOwner(lockPath);
    clock += 5_000;
    await handle.heartbeat();
    const after = readOwner(lockPath);
    expect(after.acquiredAt).toBe(before.acquiredAt);
    expect(Date.parse(after.heartbeatAt)).toBe(Date.parse(before.heartbeatAt) + 5_000);
    await handle.release();
  });

  test("heartbeatMs starts an auto-heartbeat that stops on release", async () => {
    const lockPath = path.join(tmpDir, "auto-heartbeat.lock");
    const handle = await acquireLockDir(lockPath, { heartbeatMs: 15 });
    const before = readOwner(lockPath);
    await Bun.sleep(100);
    const after = readOwner(lockPath);
    expect(Date.parse(after.heartbeatAt)).toBeGreaterThan(Date.parse(before.heartbeatAt));
    expect(after.acquiredAt).toBe(before.acquiredAt);
    await handle.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("release waits for an in-flight heartbeat before removing the lock", async () => {
    const lockPath = path.join(tmpDir, "heartbeat-release-race.lock");
    const ownerPath = path.join(lockPath, "owner.json");
    let ownerParentMkdirCalls = 0;
    let startHeartbeatMkdir!: () => void;
    const heartbeatMkdirStarted = new Promise<void>((resolve) => {
      startHeartbeatMkdir = resolve;
    });
    let allowHeartbeatMkdir!: () => void;
    const heartbeatMkdirGate = new Promise<void>((resolve) => {
      allowHeartbeatMkdir = resolve;
    });
    let finishHeartbeat!: () => void;
    const heartbeatFinished = new Promise<void>((resolve) => {
      finishHeartbeat = resolve;
    });
    const fsImpl = fsWith({
      mkdir: async (target, options) => {
        if (String(target) === lockPath && options?.recursive === true) {
          ownerParentMkdirCalls += 1;
          if (ownerParentMkdirCalls === 1) {
            startHeartbeatMkdir();
            await heartbeatMkdirGate;
          }
        }
        return await fsp.mkdir(target, options);
      },
      rename: async (from, to) => {
        await fsp.rename(from, to);
        if (String(to) === ownerPath && ownerParentMkdirCalls >= 1) {
          finishHeartbeat();
        }
      },
    });

    const handle = await acquireLockDir(lockPath, { heartbeatMs: 60_000 }, { fsImpl });
    const heartbeatPromise = handle.heartbeat();
    await heartbeatMkdirStarted;
    const releasePromise = handle.release();
    await Bun.sleep(10);
    allowHeartbeatMkdir();
    await Promise.all([releasePromise, heartbeatPromise, heartbeatFinished]);

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("heartbeat after release is a no-op", async () => {
    const lockPath = path.join(tmpDir, "hb-after-release.lock");
    const handle = await acquireLockDir(lockPath);
    await handle.release();
    await handle.heartbeat(); // must not throw or resurrect owner.json
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("win32: transient EPERM from mkdir is retried as contention, not fatal", async () => {
    const lockPath = path.join(tmpDir, "transient-eperm.lock");
    let mkdirCalls = 0;
    const mkdir = (async (p: string, o?: fs.MakeDirectoryOptions) => {
      // Count only the non-recursive lock-acquisition mkdir, not writeFileAtomic's
      // internal `mkdir(dir, { recursive: true })` for owner.json.
      if (String(p) === lockPath && o?.recursive !== true) {
        mkdirCalls += 1;
        if (mkdirCalls === 1) throw codeError("EPERM");
      }
      return fsp.mkdir(p, o);
    }) as FsLike["mkdir"];
    const handle = await acquireLockDir(
      lockPath,
      {},
      {
        fsImpl: fsWith({ mkdir }),
        platform: "win32",
        sleepImpl: instantSleep,
        pollIntervalMs: 1,
      },
    );
    expect(mkdirCalls).toBe(2);
    expect(readOwner(lockPath).pid).toBe(process.pid);
    await handle.release();
  });

  test("posix: EPERM from mkdir is fatal (real permission problem)", async () => {
    const lockPath = path.join(tmpDir, "posix-eperm.lock");
    const mkdir = (async (p: string, o?: fs.MakeDirectoryOptions) => {
      if (String(p) === lockPath) throw codeError("EPERM");
      return fsp.mkdir(p, o);
    }) as FsLike["mkdir"];
    await expect(
      acquireLockDir(lockPath, {}, { fsImpl: fsWith({ mkdir }), platform: "linux" }),
    ).rejects.toMatchObject({ code: "EPERM" });
  });

  test("creates missing parent directories for the lock path", async () => {
    const lockPath = path.join(tmpDir, "very", "deep", "parents", "nested.lock");
    const handle = await acquireLockDir(lockPath);
    expect(readOwner(lockPath).pid).toBe(process.pid);
    await handle.release();
  });

  test("two sequential acquirers hand the lock over cleanly", async () => {
    const lockPath = path.join(tmpDir, "handover.lock");
    const first = await acquireLockDir(lockPath);
    const secondAttempt = acquireLockDir(lockPath, {}, { pollIntervalMs: 10 });
    await Bun.sleep(30);
    await first.release();
    const second = await secondAttempt;
    expect(readOwner(lockPath).pid).toBe(process.pid);
    await second.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe("symlink", () => {
  test.skipIf(!isWindowsHost)(
    "win32: dir symlink EPERM falls back to a real junction and reports the mechanism",
    async () => {
      const target = path.join(tmpDir, "junction-target");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "inside.txt"), "through the junction");
      const linkPath = path.join(tmpDir, "junction-link");
      const symlinkImpl: FsLike["symlink"] = async (t, l, type) => {
        if (type === "dir") throw codeError("EPERM"); // unprivileged: no real dir symlinks
        await fsp.symlink(t, l, type as string);
      };
      const result = await symlink(
        target,
        linkPath,
        {},
        { fsImpl: fsWith({ symlink: symlinkImpl }) },
      );
      expect(result.mechanism).toBe("junction");
      expect(fs.readFileSync(path.join(linkPath, "inside.txt"), "utf-8")).toBe(
        "through the junction",
      );
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true); // junctions are reparse points
    },
  );

  test.skipIf(!isWindowsHost)(
    "win32: relative dir targets are resolved absolute for the junction fallback",
    async () => {
      const target = path.join(tmpDir, "rel-target");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "f.txt"), "relative works");
      const linkPath = path.join(tmpDir, "rel-link");
      const symlinkImpl: FsLike["symlink"] = async (t, l, type) => {
        if (type === "dir") throw codeError("EPERM");
        expect(path.isAbsolute(String(t))).toBe(true); // junctions require absolute targets
        await fsp.symlink(t, l, type as string);
      };
      const result = await symlink(
        "rel-target",
        linkPath,
        { type: "dir" },
        {
          fsImpl: fsWith({ symlink: symlinkImpl }),
        },
      );
      expect(result.mechanism).toBe("junction");
      expect(fs.readFileSync(path.join(linkPath, "f.txt"), "utf-8")).toBe("relative works");
    },
  );

  test.skipIf(!isWindowsHost)(
    "win32 live: dir link materializes as symlink (Developer Mode) or junction — either way it resolves",
    async () => {
      const target = path.join(tmpDir, "live-target");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "live.txt"), "live");
      const linkPath = path.join(tmpDir, "live-link");
      const result = await symlink(target, linkPath);
      expect(["symlink", "junction"]).toContain(result.mechanism);
      expect(fs.readFileSync(path.join(linkPath, "live.txt"), "utf-8")).toBe("live");
    },
  );

  test("win32: file symlink EPERM becomes a typed SymlinkPrivilegeError", async () => {
    const target = path.join(tmpDir, "file-target.txt");
    fs.writeFileSync(target, "x");
    const linkPath = path.join(tmpDir, "file-link.txt");
    const symlinkImpl: FsLike["symlink"] = async () => {
      throw codeError("EPERM");
    };
    let caught: unknown;
    try {
      await symlink(
        target,
        linkPath,
        { type: "file" },
        {
          fsImpl: fsWith({ symlink: symlinkImpl }),
          platform: "win32",
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SymlinkPrivilegeError);
    const privilegeError = caught as SymlinkPrivilegeError;
    expect(privilegeError.code).toBe("SYMLINK_PRIVILEGE");
    expect(privilegeError.linkPath).toBe(linkPath);
    expect(privilegeError.message).toContain("Developer Mode");
  });

  test("win32: non-privilege symlink errors propagate raw", async () => {
    const symlinkImpl: FsLike["symlink"] = async () => {
      throw codeError("EEXIST");
    };
    await expect(
      symlink(
        path.join(tmpDir, "t"),
        path.join(tmpDir, "l"),
        { type: "file" },
        {
          fsImpl: fsWith({ symlink: symlinkImpl }),
          platform: "win32",
        },
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  test("posix: plain symlink with no type argument and no junction fallback", async () => {
    const calls: Array<{ target: string; link: string; type: unknown }> = [];
    const symlinkImpl = (async (t: string, l: string, type?: unknown) => {
      calls.push({ target: String(t), link: String(l), type });
    }) as FsLike["symlink"];
    const result = await symlink(
      "/data/target",
      "/data/link",
      { type: "dir" },
      {
        fsImpl: fsWith({ symlink: symlinkImpl }),
        platform: "linux",
      },
    );
    expect(result.mechanism).toBe("symlink");
    expect(calls).toEqual([{ target: "/data/target", link: "/data/link", type: undefined }]);
  });

  test("type is inferred from the target when omitted", async () => {
    const dirTarget = path.join(tmpDir, "infer-dir");
    fs.mkdirSync(dirTarget);
    const attempted: unknown[] = [];
    const symlinkImpl = (async (_t: string, _l: string, type?: unknown) => {
      attempted.push(type);
    }) as FsLike["symlink"];
    await symlink(
      dirTarget,
      path.join(tmpDir, "infer-dir-link"),
      {},
      {
        fsImpl: fsWith({ symlink: symlinkImpl }),
        platform: "win32",
      },
    );
    expect(attempted).toEqual(["dir"]);

    attempted.length = 0;
    const fileTarget = path.join(tmpDir, "infer-file.txt");
    fs.writeFileSync(fileTarget, "x");
    await symlink(
      fileTarget,
      path.join(tmpDir, "infer-file-link"),
      {},
      {
        fsImpl: fsWith({ symlink: symlinkImpl }),
        platform: "win32",
      },
    );
    expect(attempted).toEqual(["file"]);

    attempted.length = 0;
    await symlink(
      path.join(tmpDir, "missing-target"),
      path.join(tmpDir, "missing-link"),
      {},
      {
        fsImpl: fsWith({ symlink: symlinkImpl }),
        platform: "win32",
      },
    );
    expect(attempted).toEqual(["file"]); // missing target defaults to "file" like Node
  });
});

describe("hardenPrivateDir / hardenPrivateFile", () => {
  test("win32: removes inherited ACLs and grants the current user", async () => {
    const dir = path.join(tmpDir, "private-dir");
    fs.mkdirSync(dir);
    const chmodCalls: string[] = [];
    const chmod = (async (p: string) => {
      chmodCalls.push(String(p));
    }) as FsLike["chmod"];
    const commands: Array<{ file: string; args: string[] }> = [];
    const runCommand = async (file: string, args: string[]) => {
      commands.push({ file, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const currentUserSid = "S-1-5-21-1000";
    await hardenPrivateDir(dir, {
      fsImpl: fsWith({ chmod }),
      platform: "win32",
      currentUserSid,
      runCommand,
    });
    const file = path.join(dir, "f");
    await hardenPrivateFile(file, {
      fsImpl: fsWith({ chmod }),
      platform: "win32",
      currentUserSid,
      runCommand,
    });
    expect(chmodCalls).toEqual([]);
    expect(commands).toEqual([
      {
        file: "icacls.exe",
        args: [dir, "/inheritancelevel:r", "/grant:r", `*${currentUserSid}:(OI)(CI)F`, "/Q"],
      },
      {
        file: "icacls.exe",
        args: [file, "/inheritancelevel:r", "/grant:r", `*${currentUserSid}:F`, "/Q"],
      },
    ]);
  });

  test("win32: rejects an invalid injected SID before mutating ACLs", async () => {
    const commands: Array<{ file: string; args: string[] }> = [];
    const runCommand = async (file: string, args: string[]) => {
      commands.push({ file, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await expect(
      hardenPrivateDir("C:\\private", {
        platform: "win32",
        currentUserSid: "not-a-sid",
        runCommand,
      }),
    ).rejects.toThrow('platform.fs: invalid Windows user SID: "not-a-sid"');
    expect(commands).toEqual([]);
  });

  test("win32: rejects malformed whoami output before mutating ACLs", async () => {
    const commands: Array<{ file: string; args: string[] }> = [];
    const runCommand = async (file: string, args: string[]) => {
      commands.push({ file, args });
      return { exitCode: 0, stdout: '"MACHINE\\user","not-a-sid"\r\n', stderr: "" };
    };

    await expect(
      hardenPrivateDir("C:\\private", { platform: "win32", runCommand }),
    ).rejects.toThrow(
      'platform.fs: resolve current Windows user SID: whoami.exe returned no SID: "\\"MACHINE\\\\user\\",\\"not-a-sid\\""',
    );
    expect(commands).toEqual([
      {
        file: "whoami.exe",
        args: ["/user", "/fo", "csv", "/nh"],
      },
    ]);
  });

  test("win32: resolves the current user SID and surfaces icacls failures", async () => {
    const commands: Array<{ file: string; args: string[] }> = [];
    const currentUserSid = "S-1-5-21-2000";
    const runCommand = async (file: string, args: string[]) => {
      commands.push({ file, args });
      if (file === "whoami.exe") {
        return {
          exitCode: 0,
          stdout: `"MACHINE\\user","${currentUserSid}"\r\n`,
          stderr: "",
        };
      }
      return { exitCode: 5, stdout: "", stderr: "Access is denied." };
    };

    await expect(
      hardenPrivateDir("C:\\private", { platform: "win32", runCommand }),
    ).rejects.toThrow(
      "platform.fs: harden private directory C:\\private: icacls.exe failed with exit code 5: Access is denied.",
    );
    expect(commands).toEqual([
      {
        file: "whoami.exe",
        args: ["/user", "/fo", "csv", "/nh"],
      },
      {
        file: "icacls.exe",
        args: [
          "C:\\private",
          "/inheritancelevel:r",
          "/grant:r",
          `*${currentUserSid}:(OI)(CI)F`,
          "/Q",
        ],
      },
    ]);
  });

  test.skipIf(!isWindowsHost)(
    "win32 host: real hardening removes inherited ACEs from directories and files",
    async () => {
      const dir = path.join(tmpDir, "real-private");
      fs.mkdirSync(dir);
      const file = path.join(dir, "auth.json");
      fs.writeFileSync(file, "{}");

      hardenPrivateDirSync(dir);
      await hardenPrivateFile(file);

      const dirAcl = spawnSync("icacls.exe", [dir], {
        encoding: "utf8",
        windowsHide: true,
      });
      const fileAcl = spawnSync("icacls.exe", [file], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(dirAcl.status).toBe(0);
      expect(fileAcl.status).toBe(0);
      expect(dirAcl.stdout).not.toContain("(I)");
      expect(fileAcl.stdout).not.toContain("(I)");
      expect(dirAcl.stdout).toContain("(OI)(CI)(F)");
      expect(fileAcl.stdout).toContain("(F)");
    },
  );

  test("posix: chmods 0o700 for dirs and 0o600 for files", async () => {
    const calls: Array<{ path: string; mode: unknown }> = [];
    const chmod = (async (p: string, mode: unknown) => {
      calls.push({ path: String(p), mode });
    }) as FsLike["chmod"];
    await hardenPrivateDir("/secrets", { fsImpl: fsWith({ chmod }), platform: "linux" });
    await hardenPrivateFile("/secrets/auth.json", {
      fsImpl: fsWith({ chmod }),
      platform: "darwin",
    });
    expect(calls).toEqual([
      { path: "/secrets", mode: 0o700 },
      { path: "/secrets/auth.json", mode: 0o600 },
    ]);
  });

  test("sync hardeners preserve the same platform contract", () => {
    const calls: Array<{ path: string; mode: number }> = [];
    const chmodSync = (candidate: string, mode: number) => {
      calls.push({ path: candidate, mode });
    };
    hardenPrivateDirSync("/secrets", { chmodSync, platform: "linux" });
    hardenPrivateFileSync("/secrets/auth.json", { chmodSync, platform: "darwin" });
    expect(calls).toEqual([
      { path: "/secrets", mode: 0o700 },
      { path: "/secrets/auth.json", mode: 0o600 },
    ]);

    const commands: Array<{ file: string; args: string[] }> = [];
    const runCommandSync = (file: string, args: string[]) => {
      commands.push({ file, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const currentUserSid = "S-1-5-21-1000";
    hardenPrivateDirSync("C:\\secrets", {
      chmodSync,
      platform: "win32",
      currentUserSid,
      runCommandSync,
    });
    hardenPrivateFileSync("C:\\secrets\\auth.json", {
      chmodSync,
      platform: "win32",
      currentUserSid,
      runCommandSync,
    });
    expect(calls).toHaveLength(2);
    expect(commands).toEqual([
      {
        file: "icacls.exe",
        args: [
          "C:\\secrets",
          "/inheritancelevel:r",
          "/grant:r",
          `*${currentUserSid}:(OI)(CI)F`,
          "/Q",
        ],
      },
      {
        file: "icacls.exe",
        args: [
          "C:\\secrets\\auth.json",
          "/inheritancelevel:r",
          "/grant:r",
          `*${currentUserSid}:F`,
          "/Q",
        ],
      },
    ]);
  });

  test.skipIf(isWindowsHost)("posix hosts: real modes end up 0o700 / 0o600", async () => {
    const dir = path.join(tmpDir, "real-private");
    fs.mkdirSync(dir);
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, "{}");
    await hardenPrivateDir(dir);
    await hardenPrivateFile(file);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
