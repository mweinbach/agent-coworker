import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { hostArch, hostPlatform } from "../src/platform/host";
import { resolveRustCompileTarget, type runCommand } from "./releaseBuildUtils";

type WorkspaceBinary = "cowork" | "cowork-server";

function cargoPackage(name: WorkspaceBinary): string {
  return name === "cowork" ? "cowork-cli" : "cowork-server";
}

/** Let Cargo check freshness and report the executable (including any custom target layout). */
export function buildWorkspaceBinary(
  root: string,
  name: WorkspaceBinary,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const args = [
    "build",
    "-p",
    cargoPackage(name),
    "--bin",
    name,
    "--message-format=json-render-diagnostics",
  ];
  const build = spawnSync("cargo", args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (build.error || build.status !== 0) {
    throw new Error(
      `Failed to build ${name} with cargo ${args.join(" ")}: ${build.error?.message ?? `exit ${build.status ?? build.signal}`}`,
    );
  }
  return reportedExecutable(build.stdout, name);
}

function reportedExecutable(output: string, name: WorkspaceBinary): string {
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (
      event.reason === "compiler-artifact" &&
      event.target?.name === name &&
      typeof event.executable === "string" &&
      existsSync(event.executable)
    ) {
      return event.executable;
    }
  }
  throw new Error(`Cargo build succeeded but did not report an executable for ${name}.`);
}

export async function buildWorkspaceReleaseBinaries(
  root: string,
  target: string,
  names: WorkspaceBinary[],
  runner: typeof runCommand,
): Promise<string[]> {
  let output = "";
  await runner(
    [
      "cargo",
      "build",
      "--release",
      "--locked",
      ...names.flatMap((name) => ["-p", cargoPackage(name)]),
      "--target",
      target,
      "--message-format=json-render-diagnostics",
    ],
    {
      cwd: root,
      env: process.env,
      onStdout: (text) => {
        output = text;
      },
    },
  );
  return names.map((name) => reportedExecutable(output, name));
}

function cargoAvailable(root: string, env: NodeJS.ProcessEnv): boolean {
  if (!existsSync(path.join(root, "Cargo.toml"))) return false;
  const probe = spawnSync("cargo", ["--version"], { cwd: root, env, stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/**
 * With a Rust toolchain, let Cargo rebuild (or confirm freshness of) the server so
 * developer launchers never run a binary older than the checked-out sources.
 * Without one, fall back to an existing native build.
 */
export function resolveWorkspaceServerBinary(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  { includeStaged = true } = {},
): string {
  if (cargoAvailable(root, env)) {
    return buildWorkspaceBinary(root, "cowork-server", env);
  }
  const platform = hostPlatform();
  const triple = resolveRustCompileTarget(platform, hostArch());
  const ext = platform === "win32" ? ".exe" : "";
  const targetDir = path.resolve(root, env.CARGO_TARGET_DIR || "target");
  const candidates: string[] = [];
  if (includeStaged) {
    candidates.push(
      path.join(root, "apps", "desktop", "resources", "binaries", `cowork-server-${triple}${ext}`),
    );
  }
  for (const profile of ["release", "debug"]) {
    candidates.push(
      path.join(targetDir, triple, profile, `cowork-server${ext}`),
      path.join(targetDir, profile, `cowork-server${ext}`),
    );
  }
  // Nothing prebuilt: attempt the build anyway so the caller sees Cargo's error.
  return (
    candidates.find((candidate) => existsSync(candidate)) ??
    buildWorkspaceBinary(root, "cowork-server", env)
  );
}
