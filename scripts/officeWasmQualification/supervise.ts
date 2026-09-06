import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { hostPlatform } from "../../src/platform/host";
import { killDetachedPosixGroup } from "../../src/platform/processTree";
import { sandboxManager } from "../../src/platform/sandbox";
import { positiveLinuxReadView } from "./linuxReadView";

export const limits = {
  timeoutMs: 180_000,
  rssKiB: 3 * 1024 * 1024,
  outputBytes: 2_000_000,
  workspaceBytes: 128 * 1024 * 1024,
  nodeFlags: ["--max-old-space-size=1024", "--wasm-max-mem-pages=32768"],
};

type ProcessRow = { pid: number; ppid: number; pgid: number; rss: number };
function processes(): ProcessRow[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss="], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 2_000_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  })
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, pgid, rss] = line.trim().split(/\s+/).map(Number);
      if (![pid, ppid, pgid, rss].every(Number.isFinite)) throw new Error("Invalid process sample");
      return { pid, ppid, pgid, rss };
    });
}

function descendants(rows: ProcessRow[], root: number): ProcessRow[] {
  const ids = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if ((ids.has(row.ppid) || row.pgid === root) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => ids.has(row.pid));
}

function workspaceBytes(directory: string): number {
  let count = 0;
  let bytes = 0;
  function walk(dir: string, depth: number): void {
    if (depth > 12) throw new Error("Workspace depth limit");
    const iterator = fs.opendirSync(dir);
    try {
      for (let entry = iterator.readSync(); entry; entry = iterator.readSync()) {
        if (++count > 500) throw new Error("Workspace entry limit");
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (entry.isFile()) {
          try {
            bytes += fs.lstatSync(file).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    } finally {
      iterator.closeSync();
    }
  }
  walk(directory, 0);
  return bytes;
}

export async function supervise(opts: {
  label: string;
  file: string;
  args: string[];
  root: string;
  assets: string;
  artifacts: string;
  env: Record<string, string>;
  readRoots: string[];
  executables: string[];
  canaryDir?: string;
}): Promise<{ stdout: string }> {
  const transformed = sandboxManager.transform({
    file: opts.file,
    args: opts.args,
    cwd: opts.root,
    policy: { kind: "workspace-write", writableRoots: [opts.root], network: false },
  });
  if (
    transformed.unsandboxed ||
    !["macos-seatbelt", "linux-bwrap"].includes(transformed.sandbox) ||
    Object.values(transformed.enforcement).some((value) => value !== true)
  )
    throw new Error(`Required sandbox unavailable: ${transformed.warning ?? transformed.sandbox}`);

  let args = [...transformed.args];
  // Only tighten the real backend policy. In particular, remove unrelated
  // automatic temp-root write grants rather than blessing the whole runner temp.
  if (hostPlatform() === "darwin") {
    if (args[0] !== "-p") throw new Error("Unexpected Seatbelt wrapper");
    const readRoots = [
      opts.root,
      opts.assets,
      ...opts.readRoots,
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      "/dev",
      "/Library/Fonts",
      "/Library/Apple",
      "/private/var/db/dyld",
      "/opt/homebrew",
    ];
    args[1] += `
(deny user-preference-read)
(deny file-write* (require-all (require-not (subpath ${JSON.stringify(opts.root)})) (require-not (subpath "/dev"))))
(deny file-read-data (require-all (vnode-type REGULAR-FILE)
${readRoots.map((root) => `(require-not (subpath ${JSON.stringify(root)}))`).join("\n")}))`;
  } else {
    args = positiveLinuxReadView(args, opts);
  }
  fs.writeFileSync(
    path.join(opts.artifacts, `${opts.label}.policy.json`),
    JSON.stringify({ ...transformed, args }, null, 2),
  );
  const started = performance.now();
  const child = spawn(transformed.file, args, {
    cwd: opts.root,
    env: { ...opts.env, ...transformed.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let failure: string | undefined;
  let peakRssKiB = 0;
  let peakWorkspaceBytes = 0;
  let bytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const observed = new Map<number, number>();
  const stop = (reason?: string) => {
    if (reason && !failure) failure = reason;
    if (pid) killDetachedPosixGroup(pid, "SIGKILL");
  };
  const onSignal = () => stop("Supervisor interrupted");
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const capture = (chunks: Buffer[], buffer: Buffer) => {
    bytes += buffer.length;
    if (bytes > limits.outputBytes) stop("Output byte limit");
    else chunks.push(buffer);
  };
  child.stdout.on("data", (buffer: Buffer) => capture(stdout, buffer));
  child.stderr.on("data", (buffer: Buffer) => capture(stderr, buffer));
  const timer = setTimeout(() => stop("Elapsed time limit"), limits.timeoutMs);
  const sample = () => {
    try {
      const rows = pid ? descendants(processes(), pid) : [];
      for (const row of rows) observed.set(row.pid, row.pgid);
      const rss = rows.reduce((total, row) => total + row.rss, 0);
      peakRssKiB = Math.max(peakRssKiB, rss);
      peakWorkspaceBytes = Math.max(peakWorkspaceBytes, workspaceBytes(opts.root));
      if (rss > limits.rssKiB) stop("Aggregate RSS limit");
      if (peakWorkspaceBytes > limits.workspaceBytes) stop("Workspace byte limit");
    } catch (error) {
      stop(`Resource sampling failed: ${String(error)}`);
    }
  };
  const interval = setInterval(sample, 250);
  let exitCode: number | null = null;
  let signal: string | null = null;
  let survivors: number[] = [];
  try {
    [exitCode, signal] = await new Promise<[number | null, string | null]>((resolve, reject) => {
      child.once("exit", (code, sig) => resolve([code, sig]));
      child.once("error", reject);
    });
  } catch (error) {
    failure = String(error);
  } finally {
    clearTimeout(timer);
    clearInterval(interval);
    stop();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    // bwrap has a separate session but --die-with-parent + its PID namespace
    // tears that tree down. Check sampled descendants as well as our POSIX group.
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const rows = processes();
        survivors = rows
          .filter(
            (row) =>
              row.pgid === pid || (observed.has(row.pid) && observed.get(row.pid) === row.pgid),
          )
          .map((row) => row.pid);
        if (!survivors.length) break;
        await Bun.sleep(100);
      }
      if (survivors.length) failure ??= "Descendants survived teardown";
    } catch (error) {
      failure ??= `Teardown verification failed: ${String(error)}`;
    }
    await Promise.race([closed, Bun.sleep(1000)]);
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const text = Buffer.concat(stdout).toString("utf8");
  fs.writeFileSync(path.join(opts.artifacts, `${opts.label}.stdout.log`), text);
  fs.writeFileSync(path.join(opts.artifacts, `${opts.label}.stderr.log`), Buffer.concat(stderr));
  fs.writeFileSync(
    path.join(opts.artifacts, `${opts.label}.run.json`),
    JSON.stringify(
      {
        exitCode,
        signal,
        failure,
        durationMs: performance.now() - started,
        peakRssKiB,
        peakWorkspaceBytes,
        outputBytes: bytes,
        survivors,
        limits,
        sandbox: transformed.sandbox,
        enforcement: transformed.enforcement,
        runtimeNetwork: false,
      },
      null,
      2,
    ),
  );
  if (exitCode !== 0 || failure)
    throw new Error(`${opts.label} failed: ${failure ?? `exit ${exitCode}`}`);
  return { stdout: text };
}
