export const SERVER_BINARY_BASE_NAME = "cowork-server";
export const SERVER_BINARY_MANIFEST_NAME = "cowork-server-manifest.json";

export type ServerBinaryManifest = {
  filename: string;
  targetTriple: string;
  platform: NodeJS.Platform;
  arch: string;
};

export function resolveServerTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }

  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }

  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
  }

  throw new Error(`Unsupported platform/arch for cowork-server binary: ${platform}/${arch}`);
}

export function resolveServerBinaryFilename(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  includeTargetTriple?: boolean;
  basename?: string;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const basename = options.basename ?? SERVER_BINARY_BASE_NAME;
  const ext = platform === "win32" ? ".exe" : "";
  const suffix = options.includeTargetTriple === false ? "" : `-${resolveServerTargetTriple(platform, arch)}`;
  return `${basename}${suffix}${ext}`;
}

export function buildServerBinaryManifest(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  includeTargetTriple?: boolean;
  basename?: string;
} = {}): ServerBinaryManifest {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return {
    filename: resolveServerBinaryFilename({ ...options, platform, arch }),
    targetTriple: resolveServerTargetTriple(platform, arch),
    platform,
    arch,
  };
}
