import { describe, expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

import { killDetachedPosixGroup, killTree } from "../../src/platform/processTree";

describe("processTree.killTree — posix branch (unit, injected kill)", () => {
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
    killDetachedPosixGroup(1234, "SIGKILL", (pid, signal) => {
      calls.push([pid, signal]);
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(calls).toEqual([[-1234, "SIGKILL"]]);
  });
});

describe("processTree.killTree — win32 Node compatibility", () => {
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
