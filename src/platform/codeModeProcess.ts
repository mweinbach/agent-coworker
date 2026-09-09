import fs from "node:fs";
import path from "node:path";

import { hostPlatform } from "./host";
import { type ChildHandle, spawnStreaming } from "./proc";
import { type SandboxTransformResult, sandboxManager } from "./sandbox";

/**
 * There is deliberately no Worker/heap-flag fallback. RLIMIT_RSS (including
 * macOS's RLIMIT_AS alias) is not a hard resident-memory limit; JSC heap limits
 * do not bound every native allocation. Windows needs a memory-limited Job
 * Object launcher, which the current sandbox helper does not expose.
 */
export function assertCodeModeProcessPlatform(platform = hostPlatform()): void {
  if (platform !== "linux") {
    throw new Error(
      `code mode unavailable on ${platform}: no enforced process-memory backend ` +
        "(requires Linux cgroup v2 delegation; no unsafe Worker fallback)",
    );
  }
}

interface CodeModeProcess {
  child: ChildHandle;
  /** Kill/reap the executor and remove its private resource-control group. */
  dispose(): Promise<void>;
}

export type CodeModeProcessSpawner = (input: {
  source: string;
  maxMemoryBytes: number;
}) => CodeModeProcess;

/**
 * Re-enter the CURRENT Bun executable, including a signed --compile executable.
 * BUN_BE_BUN selects Bun's CLI rather than the bundled application entry point.
 * No runtime-relative source files, PATH Node, inherited environment or preload.
 * Only trusted bootstrap source is in argv; model source travels over stdin.
 */
export function codeModeBunCommand(
  source: string,
  platform = hostPlatform(),
): {
  file: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    file: process.execPath,
    args: [
      "--no-env-file",
      "--no-install",
      `--config=${platform === "win32" ? "NUL" : "/dev/null"}`,
      "--eval",
      source,
    ],
    env: {
      BUN_BE_BUN: "1",
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      TMPDIR: "/nonexistent",
      // Disable disk caches; none of these flags are claimed as memory limits.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      BUN_DISABLE_TRANSPILER_CACHE: "1",
      ...(platform === "win32" && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    },
  };
}

/** Only used beneath /sys/fs/cgroup, never a user-provided arbitrary path. */
export function codeModeCgroupParent(membership: string, delegatedRoot?: string): string {
  if (delegatedRoot !== undefined) {
    if (!delegatedRoot.startsWith("/sys/fs/cgroup/") || delegatedRoot.split("/").includes("..")) {
      throw new Error("code mode delegated root must be beneath /sys/fs/cgroup");
    }
    return path.posix.normalize(delegatedRoot);
  }
  const entry = membership.split("\n").find((line) => line.startsWith("0::"));
  const relative = entry?.slice(3);
  if (!relative?.startsWith("/") || relative.split("/").includes("..")) {
    throw new Error("code mode requires a unified cgroup-v2 membership");
  }
  return path.posix.join("/sys/fs/cgroup", relative);
}

export function requireCodeModeSandbox(result: SandboxTransformResult): void {
  if (
    result.unsandboxed ||
    result.sandbox !== "linux-bwrap" ||
    !result.enforcement.filesystem ||
    !result.enforcement.network ||
    !result.enforcement.process ||
    !result.enforcement.integrity
  ) {
    throw new Error(
      `code mode requires OS sandbox enforcement: ${result.warning ?? "unavailable"}`,
    );
  }
}

/** Testable ordered settings: the kernel enforces RAM+swap for the whole tree. */
export function codeModeCgroupLimits(maxMemoryBytes: number): Record<string, string> {
  if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes <= 0) {
    throw new Error("code mode maxMemoryBytes must be a positive safe integer");
  }
  return {
    "memory.max": String(maxMemoryBytes),
    "memory.swap.max": "0",
    "memory.oom.group": "1",
    // Includes Bun's runtime threads and bwrap's supervisor.
    "pids.max": "64",
  };
}

/**
 * The shell joins the already-limited cgroup BEFORE execing the sandbox.
 * Positional arguments, not interpolation; failure stops before Bun starts.
 * The child cannot change its cgroup through bwrap's read-only filesystem.
 */
const JOIN_CGROUP = 'printf "%s" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"';

export const spawnCodeModeProcess: CodeModeProcessSpawner = ({ source, maxMemoryBytes }) => {
  assertCodeModeProcessPlatform();
  const command = codeModeBunCommand(source);
  const sandbox = sandboxManager.transform({
    file: command.file,
    args: command.args,
    cwd: "/",
    policy: { kind: "read-only", network: false },
  });
  requireCodeModeSandbox(sandbox);

  let group: string | undefined;
  try {
    const parent = codeModeCgroupParent(
      fs.readFileSync("/proc/self/cgroup", "utf8"),
      process.env.COWORK_CODE_MODE_CGROUP_ROOT,
    );
    // Refuse an ordinary directory masquerading as the cgroup control mount.
    if (fs.statfsSync(parent).type !== 0x63677270) {
      throw new Error("cgroup path is not a cgroup-v2 filesystem");
    }
    // Do not change delegation/controller state of the harness or its siblings.
    // Administrators must delegate memory+pids and enable them for children.
    // The optional trusted root selects a delegated resource directory with
    // no internal processes (Linux cannot enable memory on an occupied leaf).
    // It is never forwarded to the executor or inferred by escaping upward
    // from the harness's current cgroup.
    group = fs.mkdtempSync(path.join(parent, "cowork-code-mode-"));
    fs.accessSync(path.join(group, "cgroup.kill"), fs.constants.W_OK);
    for (const [name, value] of Object.entries(codeModeCgroupLimits(maxMemoryBytes))) {
      fs.writeFileSync(path.join(group, name), value);
      if (fs.readFileSync(path.join(group, name), "utf8").trim() !== value) {
        throw new Error(`kernel did not accept ${name}`);
      }
    }
  } catch (error) {
    if (group) fs.rmdirSync(group);
    throw new Error("code mode requires writable cgroup-v2 memory/pids delegation", {
      cause: error,
    });
  }
  const ownedGroup = group;
  let child: ChildHandle;
  try {
    child = spawnStreaming(
      "/bin/sh",
      ["-c", JOIN_CGROUP, "code-mode", ownedGroup, sandbox.file, ...sandbox.args],
      { cwd: "/", stdin: "pipe", env: { ...command.env, ...sandbox.env } },
    );
  } catch (error) {
    fs.rmdirSync(ownedGroup);
    throw error;
  }

  let disposal: Promise<void> | undefined;
  return {
    child,
    dispose() {
      disposal ??= (async () => {
        // cgroup.kill also reaches descendants outside the original process
        // group. killTree covers a launcher cancelled before joining the group.
        try {
          fs.writeFileSync(path.join(ownedGroup, "cgroup.kill"), "1");
        } finally {
          // A control-filesystem failure must not skip direct termination.
          await child.killTree();
          await child.exited;
        }
        // Kernel reaping can lag the launcher's exit. Never resolve ownership
        // while a descendant is still charged to the execution's cgroup.
        while (
          /\bpopulated 1\b/.test(fs.readFileSync(path.join(ownedGroup, "cgroup.events"), "utf8"))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        fs.rmdirSync(ownedGroup);
      })();
      return disposal;
    },
  };
};
