import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostPlatform } from "../../src/platform/host";
import {
  expectPrivateMode,
  forEachPlatform,
  pinHome,
  platformMatrix,
  symlinkOrJunction,
} from "../helpers/platform";

const HOME_KEYS = ["HOME", "USERPROFILE", "COWORK_HOME_OVERRIDE"] as const;

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("pinHome", () => {
  test("sets HOME, USERPROFILE, and COWORK_HOME_OVERRIDE to the pinned dir", () => {
    const restore = pinHome("/pinned/home");
    try {
      for (const key of HOME_KEYS) {
        expect(process.env[key]).toBe("/pinned/home");
      }
    } finally {
      restore();
    }
  });

  test("restore reinstates prior values exactly and deletes keys that did not exist", () => {
    const priorState = new Map<string, string | undefined>(
      HOME_KEYS.map((key) => [key, process.env[key]]),
    );
    process.env.HOME = "/original/home";
    process.env.USERPROFILE = "C:\\Users\\original";
    delete process.env.COWORK_HOME_OVERRIDE;

    const restore = pinHome("/pinned/home");
    restore();

    expect(process.env.HOME).toBe("/original/home");
    expect(process.env.USERPROFILE).toBe("C:\\Users\\original");
    expect(process.env.COWORK_HOME_OVERRIDE).toBeUndefined();
    expect("COWORK_HOME_OVERRIDE" in process.env).toBe(false);

    // Put the real host environment back.
    for (const [key, value] of priorState) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("restore removes keys even when mutated during the pin", () => {
    const priorState = new Map<string, string | undefined>(
      HOME_KEYS.map((key) => [key, process.env[key]]),
    );
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.COWORK_HOME_OVERRIDE;

    const restore = pinHome("/pinned/home");
    process.env.HOME = "/mutated/mid-pin";
    restore();

    for (const key of HOME_KEYS) {
      expect(key in process.env).toBe(false);
    }

    for (const [key, value] of priorState) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("nested pins unwind in LIFO order", () => {
    const priorState = new Map<string, string | undefined>(
      HOME_KEYS.map((key) => [key, process.env[key]]),
    );
    process.env.HOME = "/outer/original";

    const restoreOuter = pinHome("/outer/pin");
    const restoreInner = pinHome("/inner/pin");
    expect(process.env.HOME).toBe("/inner/pin");
    restoreInner();
    expect(process.env.HOME).toBe("/outer/pin");
    restoreOuter();
    expect(process.env.HOME).toBe("/outer/original");

    for (const [key, value] of priorState) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});

describe("platformMatrix / forEachPlatform", () => {
  test("platformMatrix is exactly win32, darwin, linux", () => {
    expect([...platformMatrix]).toEqual(["win32", "darwin", "linux"]);
  });

  test("forEachPlatform invokes the callback once per platform, in matrix order", () => {
    const seen: NodeJS.Platform[] = [];
    forEachPlatform((platform) => {
      seen.push(platform);
    });
    expect(seen).toEqual(["win32", "darwin", "linux"]);
  });
});

describe("symlinkOrJunction", () => {
  test("creates a traversable directory link (symlink on POSIX; symlink or junction on win32)", async () => {
    const root = await makeTempDir("cowork-symlink-dir-");
    const target = path.join(root, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "inside.txt"), "hello");
    const linkPath = path.join(root, "link");

    const result = await symlinkOrJunction(target, linkPath, { type: "dir" });

    expect(result.created).toBe(true);
    expect(result.skipped).toBeUndefined();
    if (hostPlatform() === "win32") {
      // Either lane is legitimate on win32 depending on Developer Mode / privileges.
      expect(["symlink", "junction"]).toContain(result.how);
    } else {
      expect(result.how).toBe("symlink");
    }
    // The link must actually resolve, whichever mechanism was used.
    expect(await fs.readFile(path.join(linkPath, "inside.txt"), "utf8")).toBe("hello");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  test("file links either create a symlink or report a skip reason on win32 (never throw on EPERM)", async () => {
    const root = await makeTempDir("cowork-symlink-file-");
    const target = path.join(root, "target.txt");
    await fs.writeFile(target, "file-contents");
    const linkPath = path.join(root, "link.txt");

    const result = await symlinkOrJunction(target, linkPath, { type: "file" });

    if (result.created) {
      expect(result.how).toBe("symlink");
      expect(result.skipped).toBeUndefined();
      expect(await fs.readFile(linkPath, "utf8")).toBe("file-contents");
    } else {
      // Only win32 without symlink privilege lands here; the reason is the
      // documented skip rationale callers surface in test.skip messages.
      expect(hostPlatform()).toBe("win32");
      expect(result.how).toBe("symlink");
      expect(result.skipped).toMatch(/EPERM/);
    }
  });

  test("non-permission errors still throw (missing link parent)", async () => {
    const root = await makeTempDir("cowork-symlink-err-");
    const target = path.join(root, "target");
    await fs.mkdir(target);
    const linkPath = path.join(root, "does-not-exist", "link");

    await expect(symlinkOrJunction(target, linkPath, { type: "dir" })).rejects.toThrow();
  });
});

describe("expectPrivateMode", () => {
  test("win32 branch is a no-op that resolves without touching the filesystem", async () => {
    // Path does not exist; the win32 branch must return before stat.
    await expectPrivateMode(path.join(os.tmpdir(), "definitely-missing-cowork-path"), "win32");
  });

  test("posix branch rejects a group/other-accessible file on every host", async () => {
    const root = await makeTempDir("cowork-mode-file-");
    const file = path.join(root, "loose.txt");
    await fs.writeFile(file, "x");
    // POSIX: chmod grants group/other read; win32: writable files report 0o666.
    await fs.chmod(file, 0o644);
    await expect(expectPrivateMode(file, "linux")).rejects.toThrow(/owner-only mode 0o600/);
  });

  test("posix branch rejects a group/other-accessible directory on every host", async () => {
    const root = await makeTempDir("cowork-mode-dir-");
    const dir = path.join(root, "loose");
    await fs.mkdir(dir);
    // POSIX: chmod grants group/other access; win32: directories report 0o777.
    await fs.chmod(dir, 0o755);
    await expect(expectPrivateMode(dir, "darwin")).rejects.toThrow(/owner-only mode 0o700/);
  });

  // Real mode-bit enforcement (0o600/0o700 round-trips through chmod) is genuinely
  // host-bound: Windows filesystems do not persist POSIX owner-only modes.
  test.skipIf(hostPlatform() === "win32")(
    "posix branch accepts owner-only file (0o600) and directory (0o700)",
    async () => {
      const root = await makeTempDir("cowork-mode-ok-");
      const file = path.join(root, "secret.txt");
      await fs.writeFile(file, "x");
      await fs.chmod(file, 0o600);
      await expectPrivateMode(file);

      const dir = path.join(root, "secret-dir");
      await fs.mkdir(dir, { mode: 0o700 });
      await fs.chmod(dir, 0o700);
      await expectPrivateMode(dir);
    },
  );
});
