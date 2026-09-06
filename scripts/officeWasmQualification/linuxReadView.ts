import fs from "node:fs";

// Qualification-specific positive view, NOT a production sandbox change.
// No /, /home, /etc, /opt, /usr or tool-prefix ancestor mounts. These are
// system executables, dynamic loaders/stdlibs, font and Poppler data only.
const systemRoots = [
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/lib64",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/usr/share/fonts",
  "/usr/share/fontconfig",
  "/usr/share/poppler",
  "/usr/share/mime",
  "/usr/share/zoneinfo",
  "/etc/fonts",
  "/etc/ld.so.cache",
  "/etc/localtime",
];

const requiredFlags = [
  "--new-session",
  "--die-with-parent",
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-net",
];

/** Replace ONLY the mount view of the real SandboxManager bwrap command.
 * Preserve its namespace/session controls and entire Python/seccomp launcher.
 * Reject unknown wrapper options rather than accidentally restoring host reads.
 */
export function positiveLinuxReadView(
  original: string[],
  opts: { root: string; assets: string; executables: string[]; canaryDir?: string },
  filesystem = {
    exists: fs.existsSync,
    realpath: (file: string) => fs.realpathSync(file),
    isFile: (file: string) => fs.statSync(file).isFile(),
  },
): string[] {
  const separator = original.indexOf("--");
  if (separator < 0) throw new Error("Missing bubblewrap inner command");
  const control: string[] = [];
  for (let i = 0; i < separator; ) {
    const flag = original[i];
    if (requiredFlags.includes(flag)) {
      control.push(flag);
      i++;
    } else if (["--ro-bind", "--bind"].includes(flag)) {
      if (i + 2 >= separator) throw new Error("Truncated bubblewrap mount");
      i += 3; // Discard ALL original host mounts, including --ro-bind / /.
    } else if (["--dev", "--proc", "--chdir"].includes(flag)) {
      if (i + 1 >= separator) throw new Error("Truncated bubblewrap option");
      i += 2;
    } else {
      throw new Error(`Unexpected bubblewrap option: ${flag}`);
    }
  }
  if (requiredFlags.some((flag) => !control.includes(flag))) {
    throw new Error("Missing required namespace/session enforcement");
  }
  const inner = original.slice(separator);
  if (
    inner[1] !== "/usr/bin/python3" ||
    inner[2] !== "-I" ||
    inner[3] !== "-S" ||
    inner[4] !== "-c"
  ) {
    throw new Error("Unexpected sandbox seccomp launcher");
  }
  for (const root of [opts.root, opts.assets]) {
    if (root === "/" || filesystem.realpath(root) !== root)
      throw new Error("Non-canonical scoped root");
  }
  const mounts: string[] = ["--tmpfs", "/"];
  for (const destination of systemRoots) {
    if (filesystem.exists(destination)) {
      mounts.push("--ro-bind", filesystem.realpath(destination), destination);
    }
  }
  for (const file of new Set(opts.executables)) {
    if (!filesystem.isFile(file) || filesystem.realpath(file) !== file) {
      throw new Error(`Executable must be a resolved regular file: ${file}`);
    }
    mounts.push("--ro-bind", file, file);
  }
  mounts.push("--ro-bind", opts.assets, opts.assets);
  // Mount only the synthetic write canary. Its parent (runner temp) stays absent.
  // A present read-only file makes EROFS meaningful, rather than accepting ENOENT.
  if (opts.canaryDir) {
    if (filesystem.realpath(opts.canaryDir) !== opts.canaryDir || opts.canaryDir === "/") {
      throw new Error("Non-canonical canary directory");
    }
    mounts.push("--ro-bind", opts.canaryDir, opts.canaryDir);
  }
  mounts.push(
    "--bind",
    opts.root,
    opts.root,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--remount-ro",
    "/",
    "--chdir",
    opts.root,
  );
  return [...control, ...mounts, ...inner];
}
