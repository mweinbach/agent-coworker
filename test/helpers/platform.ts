import { promises as fs } from "node:fs";
import path from "node:path";
import { hostPlatform } from "../../src/platform/host";

const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "COWORK_HOME_OVERRIDE"] as const;

/**
 * Pins the process home to `dir` on every platform by setting HOME, USERPROFILE,
 * and COWORK_HOME_OVERRIDE together, so home resolution agrees on win32 and POSIX.
 * Returns a restore function that reinstates the prior values exactly, deleting keys
 * that did not exist before the pin.
 */
export function pinHome(dir: string): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of HOME_ENV_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = dir;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export type SymlinkOrJunctionResult = {
  created: boolean;
  how: "symlink" | "junction";
  skipped?: string;
};

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * Creates a link from `linkPath` to `target` for tests without requiring elevation.
 * POSIX: always a real symlink. win32: tries a real symlink first (works with
 * Developer Mode); on EPERM/EACCES falls back to a junction for directories, and for
 * files returns { created: false, skipped } instead of throwing so callers can
 * convert to a documented test skip.
 */
export async function symlinkOrJunction(
  target: string,
  linkPath: string,
  opts: { type?: "file" | "dir" } = {},
): Promise<SymlinkOrJunctionResult> {
  const type = opts.type ?? "dir";
  if (hostPlatform() !== "win32") {
    await fs.symlink(target, linkPath, type);
    return { created: true, how: "symlink" };
  }

  try {
    await fs.symlink(target, linkPath, type);
    return { created: true, how: "symlink" };
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    if (type === "dir") {
      // Junction targets must be absolute paths.
      await fs.symlink(path.resolve(target), linkPath, "junction");
      return { created: true, how: "junction" };
    }
    return {
      created: false,
      how: "symlink",
      skipped:
        "win32 file symlink denied (EPERM: needs Developer Mode or SeCreateSymbolicLinkPrivilege); no junction fallback exists for files",
    };
  }
}

/**
 * Asserts owner-only permissions on POSIX: mode must be exactly 0o700 for
 * directories and 0o600 for files. On win32 (where POSIX mode bits are not
 * enforced by the filesystem) this is a documented no-op that resolves.
 */
export async function expectPrivateMode(
  p: string,
  platform: NodeJS.Platform = hostPlatform(),
): Promise<void> {
  if (platform === "win32") return;
  const stats = await fs.stat(p);
  const mode = stats.mode & 0o777;
  const expected = stats.isDirectory() ? 0o700 : 0o600;
  if (mode !== expected) {
    throw new Error(
      `expected ${p} to have owner-only mode 0o${expected.toString(8)}, got 0o${mode.toString(8)}`,
    );
  }
}

/**
 * The three platforms every platform-branching unit test must cover explicitly,
 * regardless of the host it runs on.
 */
export const platformMatrix = ["win32", "darwin", "linux"] as const satisfies readonly [
  "win32",
  "darwin",
  "linux",
];

/**
 * Runs `fn` once per platform in `platformMatrix`, so every platform branch
 * executes on every host. Typically wraps test registration.
 */
export function forEachPlatform(fn: (platform: (typeof platformMatrix)[number]) => void): void {
  for (const platform of platformMatrix) {
    fn(platform);
  }
}
