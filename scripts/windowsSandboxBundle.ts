import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { getEnv, mergePathDirs, setEnv } from "../src/platform/env";
import { which } from "../src/platform/exec";
import { hostArch, hostPlatform } from "../src/platform/host";
import { home } from "../src/platform/paths";
import {
  WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  WINDOWS_SANDBOX_HASH_MANIFEST_NAME,
  WINDOWS_SANDBOX_HELPER_NAME,
  WINDOWS_SANDBOX_SETUP_NAME,
} from "../src/platform/sandbox/windows";
import { isNativeWindowsBinary } from "../src/platform/windowsBinary";
import { pathExists, runCommand } from "./releaseBuildUtils";
import { tryDownloadPrebuiltHelpers } from "./winSandboxPrebuilt";

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

function buildWindowsRustCommandRunner(rustTarget: string): typeof runCommand {
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

export async function syncWindowsSandboxHelper(opts: {
  root: string;
  dest: string;
  previousFingerprint: string | null;
  nextFingerprint: string | null;
  platform: NodeJS.Platform;
  arch: string;
  commandRunner?: typeof runCommand;
  forceBuild?: boolean;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const destinationDir = path.dirname(opts.dest);
  const binaryNames = [
    WINDOWS_SANDBOX_HELPER_NAME,
    WINDOWS_SANDBOX_SETUP_NAME,
    WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  ];
  const manifestDest = path.join(destinationDir, WINDOWS_SANDBOX_HASH_MANIFEST_NAME);
  if (opts.platform !== "win32" || opts.nextFingerprint === null) {
    await Promise.all([
      ...binaryNames.map((name) => fs.rm(path.join(destinationDir, name), { force: true })),
      fs.rm(manifestDest, { force: true }),
    ]);
    console.log("[resources] Windows sandbox helpers: disabled");
    return;
  }

  const cachedBundleIsValid = await (async () => {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestDest, "utf8")) as {
        schemaVersion?: unknown;
        rustTarget?: unknown;
        files?: Record<string, unknown>;
      };
      if (
        manifest.schemaVersion !== 1 ||
        manifest.rustTarget !== resolveWindowsRustTarget(opts.arch)
      ) {
        return false;
      }
      for (const name of binaryNames) {
        const expected = manifest.files?.[name];
        if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
        const actual = createHash("sha256")
          .update(await fs.readFile(path.join(destinationDir, name)))
          .digest("hex");
        if (actual !== expected) return false;
      }
      return true;
    } catch {
      return false;
    }
  })();
  const needsBuild =
    opts.forceBuild === true ||
    opts.previousFingerprint !== opts.nextFingerprint ||
    !cachedBundleIsValid;
  if (!needsBuild) {
    console.log("[resources] Windows sandbox helpers: cached");
    return;
  }

  const crateDir = path.join(opts.root, "crates", "cowork-win-sandbox");
  const rustTarget = resolveWindowsRustTarget(opts.arch);

  // Fast path: download prebuilt helpers published by win-sandbox-release.yml when
  // the checked-in lock matches the local crate source. Any soft miss (no lock,
  // fingerprint drift, unavailable asset) falls back to the cargo source build;
  // hash mismatches inside tryDownloadPrebuiltHelpers throw instead of falling back.
  if (opts.forceBuild !== true) {
    const prebuilt = await tryDownloadPrebuiltHelpers({
      crateDir,
      destinationDir,
      rustTarget,
      binaryNames,
      fetchImpl: opts.fetchImpl,
      env: opts.env,
      logger: (message) => console.log(`[resources] Windows sandbox helpers: ${message}`),
    });
    if (prebuilt.ok) {
      await fs.writeFile(
        manifestDest,
        `${JSON.stringify({ schemaVersion: 1, rustTarget, files: prebuilt.files }, null, 2)}\n`,
        "utf8",
      );
      console.log(
        `[resources] Windows sandbox helpers: prebuilt ${path.relative(opts.root, destinationDir)}`,
      );
      return;
    }
    console.log(
      `[resources] Windows sandbox helpers: prebuilt unavailable (${prebuilt.reason}); building from source`,
    );
  }

  const manifestPath = path.join(crateDir, "Cargo.toml");
  const runner = opts.commandRunner ?? buildWindowsRustCommandRunner(rustTarget);
  await runner(["rustup", "target", "add", rustTarget], {
    cwd: opts.root,
  });
  await runner(
    [
      "cargo",
      "build",
      "--release",
      "--bins",
      "--manifest-path",
      manifestPath,
      "--target",
      rustTarget,
    ],
    {
      cwd: opts.root,
      ...(opts.forceBuild
        ? {
            env: {
              ...process.env,
              COWORK_SANDBOX_BUILD_NONCE: `${Date.now()}-${process.pid}`,
            },
          }
        : {}),
    },
  );

  const releaseDir = path.join(crateDir, "target", rustTarget, "release");
  const builtBinaries = binaryNames.map((name) => ({ name, path: path.join(releaseDir, name) }));
  for (const binary of builtBinaries) {
    if (!(await pathExists(binary.path))) {
      throw new Error(`Windows sandbox build did not produce ${binary.path}`);
    }
    if (!opts.commandRunner && !isNativeWindowsBinary(binary.path, opts.arch)) {
      throw new Error(
        `Windows sandbox build produced a non-native ${opts.arch} executable: ${binary.path}`,
      );
    }
  }

  await fs.mkdir(destinationDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const binary of builtBinaries) {
    const destination = path.join(destinationDir, binary.name);
    await fs.copyFile(binary.path, destination);
    files[binary.name] = createHash("sha256")
      .update(await fs.readFile(destination))
      .digest("hex");
  }
  await fs.writeFile(
    manifestDest,
    `${JSON.stringify({ schemaVersion: 1, rustTarget, files }, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[resources] Windows sandbox helpers: updated ${path.relative(opts.root, destinationDir)}`,
  );
}

function resolveWindowsRustTarget(arch: string): string {
  if (arch === "x64") return "x86_64-pc-windows-msvc";
  if (arch === "arm64") return "aarch64-pc-windows-msvc";
  throw new Error(`Unsupported Windows sandbox helper architecture: ${arch}`);
}
