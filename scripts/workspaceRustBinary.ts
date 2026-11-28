import { spawnSync } from "node:child_process";
import fsSync, { existsSync } from "node:fs";
import path from "node:path";

import { getEnv, mergePathDirs, setEnv } from "../src/platform/env";
import { which } from "../src/platform/exec";
import { hostArch, hostPlatform } from "../src/platform/host";
import { home } from "../src/platform/paths";
import { resolvePackagedSidecarFilename, resolveStagedBinariesDir } from "../src/platform/sidecar";
import { resolveRustCompileTarget, runCommand } from "./releaseBuildUtils";

type WorkspaceBinary = "cowork" | "cowork-server";

function firstSubdir(dir: string): string | null {
  try {
    return (
      fsSync.readdirSync(dir, { withFileTypes: true }).find((entry) => entry.isDirectory())?.name ??
      null
    );
  } catch {
    return null;
  }
}

export function buildWindowsRustCommandRunner(rustTarget: string): typeof runCommand {
  return async (command, options) => {
    const baseEnv = options.env ?? process.env;
    if (hostPlatform() !== "win32") {
      return await runCommand(command, options);
    }
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    const userHome = home(env);
    const extraPathDirs: string[] = [];
    const cargoBin = path.join(userHome, ".cargo", "bin");
    if (fsSync.existsSync(cargoBin)) {
      extraPathDirs.push(cargoBin);
    }
    const msvcRoot = path.join(userHome, ".msvc");
    const msvcToolsRoot = path.join(msvcRoot, "VC", "Tools", "MSVC");
    const sdkRoot = path.join(msvcRoot, "Windows Kits", "10");
    const msvcVersion = firstSubdir(msvcToolsRoot);
    const sdkVersion = firstSubdir(path.join(sdkRoot, "Lib"));
    if (msvcVersion && sdkVersion) {
      const hostArchName = hostArch() === "arm64" ? "arm64" : "x64";
      const targetArch = rustTarget === "x86_64-pc-windows-msvc" ? "x64" : "arm64";
      const hostDir = hostArchName === "arm64" ? "Hostarm64" : "Hostx64";
      const targetBinDir = targetArch === "arm64" ? "ARM64" : "x64";
      const llvmArchDir = hostArchName === "arm64" ? "ARM64" : "x64";
      const vcDir = path.join(msvcToolsRoot, msvcVersion);
      const llvmBin = path.join(msvcRoot, "VC", "Tools", "Llvm", llvmArchDir, "bin");
      const msvcTargetBin = path.join(vcDir, "bin", hostDir, targetBinDir);
      const sdkBin = path.join(sdkRoot, "bin", sdkVersion, hostArchName);
      for (const dir of [llvmBin, msvcTargetBin, sdkBin]) {
        if (fsSync.existsSync(dir)) extraPathDirs.push(dir);
      }
      if (!getEnv(env, "VSINSTALLDIR", "win32")) {
        setEnv(env, "VSINSTALLDIR", `${msvcRoot}\\`, "win32");
      }
      if (!getEnv(env, "VCINSTALLDIR", "win32")) {
        setEnv(env, "VCINSTALLDIR", `${path.join(msvcRoot, "VC")}\\`, "win32");
      }
      if (!getEnv(env, "VCToolsInstallDir", "win32")) {
        setEnv(env, "VCToolsInstallDir", `${vcDir}\\`, "win32");
      }
      if (!getEnv(env, "VSCMD_ARG_TGT_ARCH", "win32")) {
        setEnv(env, "VSCMD_ARG_TGT_ARCH", targetArch, "win32");
      }
      if (!getEnv(env, "WindowsSdkDir", "win32")) {
        setEnv(env, "WindowsSdkDir", `${sdkRoot}\\`, "win32");
      }
      if (!getEnv(env, "WindowsSdkVersion", "win32")) {
        setEnv(env, "WindowsSdkVersion", `${sdkVersion}\\`, "win32");
      }
      if (!getEnv(env, "INCLUDE", "win32")) {
        setEnv(
          env,
          "INCLUDE",
          [
            path.join(vcDir, "include"),
            path.join(sdkRoot, "Include", sdkVersion, "ucrt"),
            path.join(sdkRoot, "Include", sdkVersion, "shared"),
            path.join(sdkRoot, "Include", sdkVersion, "um"),
            path.join(sdkRoot, "Include", sdkVersion, "winrt"),
            path.join(sdkRoot, "Include", sdkVersion, "cppwinrt"),
          ].join(";"),
          "win32",
        );
      }
      setEnv(
        env,
        "LIB",
        [
          path.join(vcDir, "lib", targetArch),
          path.join(sdkRoot, "Lib", sdkVersion, "ucrt", targetArch),
          path.join(sdkRoot, "Lib", sdkVersion, "um", targetArch),
        ].join(";"),
        "win32",
      );
    }
    const mergedEnv =
      extraPathDirs.length > 0
        ? mergePathDirs(env, extraPathDirs, { position: "prepend", platform: "win32" })
        : env;
    const resolvedCommand = command[0]
      ? [which(command[0], { env: mergedEnv, cwd: options.cwd }) ?? command[0], ...command.slice(1)]
      : command;
    await runCommand(resolvedCommand, { ...options, env: mergedEnv });
  };
}

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
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (target.includes("windows") && env.MXC_TELEMETRY_COMPONENT_PATH === undefined) {
    // Keep Windows release builds of `mxc-sdk` unrouted (no bundled Microsoft telemetry DLL).
    env.MXC_TELEMETRY_COMPONENT_PATH = "";
  }
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
      env,
      onStdout: (text) => {
        output = text;
      },
    },
  );
  return names.map((name) => reportedExecutable(output, name));
}

/** True when `root` is a Cargo workspace and a Rust toolchain can build it. */
export function cargoAvailable(root: string, env: NodeJS.ProcessEnv): boolean {
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
  const arch = hostArch();
  const triple = resolveRustCompileTarget(platform, arch);
  const ext = platform === "win32" ? ".exe" : "";
  const targetDir = path.resolve(root, env.CARGO_TARGET_DIR || "target");
  const candidates: string[] = [];
  if (includeStaged) {
    candidates.push(
      path.join(resolveStagedBinariesDir(root), resolvePackagedSidecarFilename(platform, arch)),
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
