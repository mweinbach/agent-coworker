import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxExecutionPlan, SandboxPolicy } from "./types";

const LINUX_HELPER_SOURCE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "native",
  "sandbox",
  "cowork-linux-sandbox.c",
);

function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  return pathValue.split(path.delimiter).some((dir) => pathExists(path.join(dir, command)));
}

function linuxHelperCachePath(): string {
  const sourceStat = fs.statSync(LINUX_HELPER_SOURCE);
  const sourceKey = `${sourceStat.size}-${Math.floor(sourceStat.mtimeMs)}`;
  return path.join(os.tmpdir(), "cowork-sandbox", sourceKey, "cowork-linux-sandbox");
}

function ensureLinuxHelper(): string | null {
  const fromEnv = process.env.COWORK_LINUX_SANDBOX_HELPER?.trim();
  if (fromEnv) return pathExists(fromEnv) ? fromEnv : null;

  const packagedCandidates = [
    path.join(path.dirname(process.execPath), "sandbox", "cowork-linux-sandbox"),
    path.resolve(import.meta.dirname, "..", "..", "dist", "sandbox", "cowork-linux-sandbox"),
  ];
  for (const candidate of packagedCandidates) {
    if (pathExists(candidate)) return candidate;
  }

  if (!fs.existsSync(LINUX_HELPER_SOURCE) || !commandExists("cc")) return null;

  const helper = linuxHelperCachePath();
  if (pathExists(helper)) return helper;

  fs.mkdirSync(path.dirname(helper), { recursive: true });
  try {
    execFileSync("cc", ["-O2", "-Wall", "-Wextra", LINUX_HELPER_SOURCE, "-o", helper], {
      stdio: "pipe",
    });
    fs.chmodSync(helper, 0o755);
    return helper;
  } catch {
    return null;
  }
}

function buildLinuxPlan(
  policy: SandboxPolicy,
  command: { file: string; args: string[] },
  cwd: string,
): SandboxExecutionPlan {
  const helper = ensureLinuxHelper();
  if (!helper) {
    return {
      ...command,
      unavailableReason:
        "Linux sandbox helper is unavailable. Install a C compiler or set COWORK_LINUX_SANDBOX_HELPER.",
    };
  }

  const args = ["--mode", policy.mode, "--cwd", cwd, "--network", policy.network];

  if (policy.fileSystem.kind === "restricted") {
    for (const root of policy.fileSystem.writableRoots) {
      args.push("--writable-root", root.root);
    }
  }

  args.push("--", command.file, ...command.args);
  return { file: helper, args };
}

function escapeSeatbeltString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function buildSeatbeltPolicy(policy: SandboxPolicy): string {
  const sections = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
  ];

  if (policy.network === "enabled") {
    sections.push("(allow network*)");
  }

  if (policy.fileSystem.kind === "restricted") {
    for (const root of policy.fileSystem.writableRoots) {
      sections.push(`(allow file-write* (subpath "${escapeSeatbeltString(root.root)}"))`);
      for (const protectedPath of root.readOnlySubpaths) {
        sections.push(`(deny file-write* (subpath "${escapeSeatbeltString(protectedPath)}"))`);
      }
    }
  }

  return sections.join("\n");
}

function buildMacosPlan(
  policy: SandboxPolicy,
  command: { file: string; args: string[] },
): SandboxExecutionPlan {
  const sandboxExec = "/usr/bin/sandbox-exec";
  if (!pathExists(sandboxExec)) {
    return {
      ...command,
      unavailableReason: "macOS sandbox-exec is unavailable at /usr/bin/sandbox-exec.",
    };
  }

  return {
    file: sandboxExec,
    args: ["-p", buildSeatbeltPolicy(policy), "--", command.file, ...command.args],
  };
}

function buildWindowsPlan(command: { file: string; args: string[] }): SandboxExecutionPlan {
  const helper = process.env.COWORK_WINDOWS_SANDBOX_HELPER?.trim();
  if (!helper || !pathExists(helper)) {
    return {
      ...command,
      unavailableReason:
        "Windows sandbox helper is unavailable. Set COWORK_WINDOWS_SANDBOX_HELPER to the native restricted-token helper.",
    };
  }

  return { file: helper, args: ["--", command.file, ...command.args] };
}

export function buildSandboxedExecutionPlan(opts: {
  platform: NodeJS.Platform;
  policy: SandboxPolicy;
  command: { file: string; args: string[] };
  cwd: string;
}): SandboxExecutionPlan {
  if (!opts.policy.platformSandboxRequired) return opts.command;

  if (opts.platform === "linux") {
    return buildLinuxPlan(opts.policy, opts.command, opts.cwd);
  }
  if (opts.platform === "darwin") {
    return buildMacosPlan(opts.policy, opts.command);
  }
  if (opts.platform === "win32") {
    return buildWindowsPlan(opts.command);
  }

  return {
    ...opts.command,
    unavailableReason: `No sandbox backend is available for platform ${opts.platform}.`,
  };
}

export const __internal = {
  buildSeatbeltPolicy,
  ensureLinuxHelper,
};
