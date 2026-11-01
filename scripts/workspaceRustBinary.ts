import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { hostArch, hostPlatform } from "../src/platform/host";
import { resolveRustCompileTarget } from "./releaseBuildUtils";

/** Let Cargo check freshness and report the executable (including any custom target layout). */
export function buildWorkspaceBinary(
  root: string,
  name: "cowork" | "cowork-server",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pkg = name === "cowork" ? "cowork-cli" : "cowork-server";
  const args = ["build", "-p", pkg, "--bin", name, "--message-format=json-render-diagnostics"];
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
  for (const line of build.stdout.trim().split("\n")) {
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
