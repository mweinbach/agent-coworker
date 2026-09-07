import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";

import { spawnCodeModeProcess } from "../../src/platform/codeModeProcess";
import * as host from "../../src/platform/host";
import * as proc from "../../src/platform/proc";
import { sandboxManager } from "../../src/platform/sandbox";

/**
 * Exercise the actual launcher with deterministic OS seams. No fake control
 * files are created on disk and no simulated platform can spawn real processes.
 */
function fixture(options: { badReadback?: boolean; killFailure?: boolean } = {}) {
  const order: string[] = [];
  const controls = new Map<string, string>();
  const previousRoot = process.env.COWORK_CODE_MODE_CGROUP_ROOT;
  delete process.env.COWORK_CODE_MODE_CGROUP_ROOT;
  const group = "/sys/fs/cgroup/owned/cowork-code-mode-fixture";
  const child: proc.ChildHandle = {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    exited: Promise.resolve({ reason: "terminated", code: null }),
    stdout: new ReadableStream({ start: (controller) => controller.close() }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    kill() {},
    async killTree() {
      order.push("killTree");
    },
  };
  const mocks = [
    spyOn(host, "hostPlatform").mockReturnValue("linux"),
    spyOn(sandboxManager, "transform").mockReturnValue({
      file: "/usr/bin/bwrap",
      args: ["sandbox-fixture"],
      env: { COWORK_SANDBOX: "linux-bwrap" },
      sandbox: "linux-bwrap",
      unsandboxed: false,
      enforcement: { filesystem: true, network: true, process: true, integrity: true },
    }),
    spyOn(fs, "statfsSync").mockReturnValue({ type: 0x63677270 } as fs.StatsFs),
    spyOn(fs, "mkdtempSync").mockImplementation((() => {
      order.push("create");
      return group;
    }) as unknown as typeof fs.mkdtempSync),
    spyOn(fs, "accessSync").mockImplementation(() => {}),
    spyOn(fs, "writeFileSync").mockImplementation((file, value) => {
      const name = String(file).split("/").at(-1)!;
      order.push(`write:${name}`);
      if (options.killFailure && name === "cgroup.kill") throw new Error("fixture kill failure");
      controls.set(String(file), String(value));
    }),
    spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor) => {
      if (String(file) === "/proc/self/cgroup") return "0::/owned";
      if (String(file).endsWith("/cgroup.events")) return "populated 0\n";
      if (options.badReadback && String(file).endsWith("/memory.max")) return "max";
      return controls.get(String(file)) ?? "";
    }) as typeof fs.readFileSync),
    spyOn(fs, "rmdirSync").mockImplementation(() => {
      order.push("remove");
    }),
  ];
  const spawn = spyOn(proc, "spawnStreaming").mockImplementation(() => {
    order.push("spawn");
    return child;
  });
  return {
    group,
    order,
    controls,
    spawn,
    restore() {
      spawn.mockRestore();
      for (const mock of mocks.reverse()) mock.mockRestore();
      if (previousRoot === undefined) delete process.env.COWORK_CODE_MODE_CGROUP_ROOT;
      else process.env.COWORK_CODE_MODE_CGROUP_ROOT = previousRoot;
    },
  };
}

test("all kernel controls are verified before launch; cgroup entry precedes sandbox exec", async () => {
  const f = fixture();
  try {
    const executor = spawnCodeModeProcess({ source: "trusted", maxMemoryBytes: 268435456 });
    expect(f.order).toEqual([
      "create",
      "write:memory.max",
      "write:memory.swap.max",
      "write:memory.oom.group",
      "write:pids.max",
      "spawn",
    ]);
    const [file, args, options] = f.spawn.mock.calls[0];
    expect(file).toBe("/bin/sh");
    expect(args).toEqual([
      "-c",
      'printf "%s" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"',
      "code-mode",
      f.group,
      "/usr/bin/bwrap",
      "sandbox-fixture",
    ]);
    expect(options?.env?.BUN_BE_BUN).toBe("1");
    expect(options?.stdin).toBe("pipe");
    await executor.dispose();
    await executor.dispose();
    expect(f.order.slice(-3)).toEqual(["write:cgroup.kill", "killTree", "remove"]);
    expect(f.order.filter((entry) => entry === "remove")).toHaveLength(1);
  } finally {
    f.restore();
  }
});

test("unaccepted memory controls prevent process spawn and remove the empty owned cgroup", () => {
  const f = fixture({ badReadback: true });
  try {
    expect(() =>
      spawnCodeModeProcess({ source: "must-not-run", maxMemoryBytes: 268435456 }),
    ).toThrow("requires writable cgroup-v2");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.order).toEqual(["create", "write:memory.max", "remove"]);
  } finally {
    f.restore();
  }
});

test("failure to signal the cgroup still terminates/reaps the launcher and reports failure", async () => {
  const f = fixture({ killFailure: true });
  try {
    const executor = spawnCodeModeProcess({ source: "trusted", maxMemoryBytes: 268435456 });
    await expect(executor.dispose()).rejects.toThrow("fixture kill failure");
    expect(f.order.at(-1)).toBe("killTree");
    // Do not falsely remove/report complete cleanup after failed tree control.
    expect(f.order).not.toContain("remove");
  } finally {
    f.restore();
  }
});
