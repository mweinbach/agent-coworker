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

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Replace ONLY the mount view of the real Rust sandbox bwrap command
 * (`cowork-server __sandbox-exec --print-command`).
 * Preserve its namespace/session controls and entire seccomp re-exec launcher
 * (`<cowork-server> __sandbox-exec --linux-seccomp --deny-network -- <file> ...`).
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
  // Credential read-deny masks (`--tmpfs D --remount-ro D`, `--ro-bind /dev/null F`) and
  // protected-metadata re-binds (`--ro-bind P P`, e.g. <root>/.git). They are re-applied below
  // only when they fall inside a root this positive view mounts.
  const overlays: string[][] = [];
  for (let i = 0; i < separator; ) {
    const flag = original[i];
    if (requiredFlags.includes(flag)) {
      control.push(flag);
      i++;
    } else if (["--ro-bind", "--bind"].includes(flag)) {
      if (i + 2 >= separator) throw new Error("Truncated bubblewrap mount");
      if (
        flag === "--ro-bind" &&
        (original[i + 1] === "/dev/null" || original[i + 1] === original[i + 2])
      ) {
        overlays.push(original.slice(i, i + 3));
      }
      i += 3; // Discard ALL original host mounts, including --ro-bind / /.
    } else if (flag === "--tmpfs") {
      if (i + 1 >= separator) throw new Error("Truncated bubblewrap option");
      const target = original[i + 1];
      if (original[i + 2] !== "--remount-ro" || original[i + 3] !== target) {
        throw new Error("Unexpected bubblewrap tmpfs mount");
      }
      overlays.push(original.slice(i, i + 4));
      i += 4;
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
  const launcher = inner[1];
  if (
    !launcher?.startsWith("/") ||
    inner[2] !== "__sandbox-exec" ||
    inner[3] !== "--linux-seccomp" ||
    inner[4] !== "--deny-network" ||
    inner[5] !== "--" ||
    !inner[6]
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
  // The seccomp launcher re-execs the sandbox binary itself, so it must be visible inside.
  for (const file of new Set([launcher, ...opts.executables])) {
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
  mounts.push("--bind", opts.root, opts.root);
  const mounted = [opts.root, opts.assets, ...(opts.canaryDir ? [opts.canaryDir] : [])];
  for (const overlay of overlays) {
    const target = overlay[overlay.length - 1];
    if (target !== "/" && mounted.some((root) => within(root, target))) mounts.push(...overlay);
  }
  mounts.push("--proc", "/proc", "--dev", "/dev", "--remount-ro", "/", "--chdir", opts.root);
  return [...control, ...mounts, ...inner];
}
