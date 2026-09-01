import path from "node:path";

import {
  type BuildTarget,
  resolveBuildTarget,
  runCommand,
} from "../../../scripts/releaseBuildUtils";

const desktopRoot = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const platformSelectors = new Map([
  ["--mac", "darwin"],
  ["--macos", "darwin"],
  ["-m", "darwin"],
  ["-o", "darwin"],
  ["--win", "win32"],
  ["--windows", "win32"],
  ["-w", "win32"],
  ["--linux", "linux"],
  ["-l", "linux"],
]);
const architectureSelectors = new Set(["x64", "arm64", "ia32", "armv7l", "universal"]);

type DesktopBuildPlan = {
  target: BuildTarget;
  env: NodeJS.ProcessEnv;
  builderArgs: string[];
};

export function planDesktopBuild(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DesktopBuildPlan {
  const platforms = new Set<string>();
  const architectures = new Set<string>();
  let hasArchitectureFlag = false;
  for (const [index, argument] of argv.entries()) {
    const separator = argument.indexOf("=");
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? undefined : argument.slice(separator + 1);
    const platform = platformSelectors.get(flag);
    if (platform) {
      platforms.add(platform);
      const formats = value === undefined ? [] : [value];
      for (const format of argv.slice(index + 1)) {
        if (format.startsWith("-")) break;
        formats.push(format);
      }
      for (const format of formats) {
        const suffix = format.lastIndexOf(":");
        if (suffix > 0) architectures.add(format.slice(suffix + 1));
      }
    } else if (flag.startsWith("--") && architectureSelectors.has(flag.slice(2))) {
      if (value !== undefined && value !== "true") {
        throw new Error("Select one desktop architecture with --x64 or --arm64, without a value.");
      }
      architectures.add(flag.slice(2));
      hasArchitectureFlag = true;
    } else if (
      (flag.startsWith("--no-") && architectureSelectors.has(flag.slice(5))) ||
      ["--platform", "--target-platform", "--arch", "--target-arch"].includes(flag)
    ) {
      throw new Error(
        "Select the desktop target with --mac/--win/--linux and --x64/--arm64, or COWORK_BUILD_PLATFORM/COWORK_BUILD_ARCH.",
      );
    }
  }
  if (platforms.size > 1 || architectures.size > 1) {
    throw new Error("Desktop packaging requires a single platform and architecture per build.");
  }
  const explicitTarget = [
    ...[...platforms].flatMap((platform) => ["--platform", platform]),
    ...[...architectures].flatMap((arch) => ["--arch", arch]),
  ];
  const target = resolveBuildTarget(explicitTarget, env);
  const platformFlag =
    target.platform === "darwin" ? "--mac" : target.platform === "win32" ? "--win" : "--linux";
  const builderArgs = [...argv];
  if (platforms.size === 0) builderArgs.push(platformFlag);
  if (!hasArchitectureFlag) builderArgs.push(`--${target.arch}`);
  return {
    target,
    env: {
      ...env,
      COWORK_BUILD_PLATFORM: target.platform,
      COWORK_BUILD_ARCH: target.arch,
    },
    builderArgs,
  };
}

async function main(): Promise<void> {
  const plan = planDesktopBuild(process.argv.slice(2));
  const commands = [
    { cwd: repoRoot, args: ["run", "build:desktop-resources"] },
    { cwd: desktopRoot, args: ["run", "electron:ensure"] },
    { cwd: desktopRoot, args: ["run", "electron-vite", "--", "build"] },
    { cwd: desktopRoot, args: ["scripts/runElectronBuilder.ts", ...plan.builderArgs] },
  ];
  for (const command of commands) {
    await runCommand([process.execPath, ...command.args], { cwd: command.cwd, env: plan.env });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
