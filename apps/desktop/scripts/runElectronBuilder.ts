import path from "node:path";
import { fileURLToPath } from "node:url";

type BuildHost = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
};

type BuildEnvironment = Record<string, string | undefined>;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const installedElectronDist = path.resolve(desktopRoot, "../../node_modules/electron/dist");

function hasArg(args: string[], ...names: string[]): boolean {
  return args.some((arg) => names.includes(arg.split("=", 1)[0] ?? arg));
}

function targetPlatform(
  args: string[],
  env: BuildEnvironment,
  fallback: NodeJS.Platform,
): NodeJS.Platform {
  if (hasArg(args, "--mac", "-m")) return "darwin";
  if (hasArg(args, "--win", "-w")) return "win32";
  if (hasArg(args, "--linux", "-l")) return "linux";

  const configured = env.COWORK_BUILD_PLATFORM;
  if (configured === "darwin" || configured === "win32" || configured === "linux") {
    return configured;
  }
  return fallback;
}

function targetArch(
  args: string[],
  env: BuildEnvironment,
  fallback: NodeJS.Architecture,
): NodeJS.Architecture | "universal" {
  for (const arch of ["x64", "arm64", "ia32", "armv7l", "universal"] as const) {
    if (hasArg(args, `--${arch}`)) return arch;
  }

  const configured = env.COWORK_BUILD_ARCH;
  if (["x64", "arm64", "ia32", "armv7l", "universal"].includes(configured ?? "")) {
    return configured as NodeJS.Architecture | "universal";
  }
  return fallback;
}

export function resolveNativeElectronDist(
  args: string[],
  env: BuildEnvironment = process.env,
  host: BuildHost = { platform: process.platform, arch: process.arch },
): string | undefined {
  if (hasArg(args, "--config.electronDist")) return undefined;
  if (targetPlatform(args, env, host.platform) !== host.platform) return undefined;
  if (targetArch(args, env, host.arch) !== host.arch) return undefined;
  return installedElectronDist;
}

export function resolveWindowsSigningConfig(
  args: string[],
  env: BuildEnvironment = process.env,
  host: BuildHost = { platform: process.platform, arch: process.arch },
): string[] {
  if (targetPlatform(args, env, host.platform) !== "win32") {
    return [];
  }

  if (env.CSC_LINK && env.CSC_KEY_PASSWORD) {
    return [];
  }

  return ["--config.win.verifyUpdateCodeSignature=false"];
}

async function main(): Promise<void> {
  const forwardedArgs = process.argv.slice(2);
  const electronDist = resolveNativeElectronDist(forwardedArgs);
  const args = [
    "x",
    "electron-builder",
    "--config",
    "electron-builder.yml",
    ...forwardedArgs,
    ...resolveWindowsSigningConfig(forwardedArgs),
    ...(electronDist ? [`--config.electronDist=${electronDist}`] : []),
  ];
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: desktopRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

if (import.meta.main) await main();
