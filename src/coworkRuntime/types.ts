export const RUNTIME_ASSET_IDS = [
  "win-x86",
  "macos-x86",
  "macos-arm64",
  "linux-x86",
  "linux-arm64",
] as const;

export type RuntimeAssetId = (typeof RUNTIME_ASSET_IDS)[number];

export type RuntimeHost = {
  platform: NodeJS.Platform;
  arch: string;
};

export type CoworkRuntimeManifest = {
  schemaVersion: 1;
  version: string;
  createdAt: string;
  asset: RuntimeAssetId;
  assetFileName: string;
  compatibleHosts: string[];
  source: {
    kind: "codex-primary-runtime";
    bundleVersion: string;
    targetPlatform: string;
    targetArch: string;
  };
  components: Array<{
    id: string;
    strategy: "built" | "generated" | "copied";
    path: string;
    source?: string;
    note?: string;
  }>;
  versions: {
    node?: string;
    python?: string;
    pnpm?: string;
    libreOffice?: string;
  };
  paths: {
    bin: string;
    node: string;
    python: string;
    nodeModules: string;
    nodeResolver: string;
    artifactToolPackage: string;
    pnpm?: string;
    git?: string;
    pdfinfo?: string;
    pdftoppm?: string;
    popplerBin?: string;
    soffice?: string;
    libreOffice?: string;
    libreOfficeBinary?: string;
  };
  payload: {
    fileCount: number;
    unpackedBytes: number;
  };
};

export type InstalledRuntimePointer = {
  schemaVersion: 1;
  version: string;
  asset: RuntimeAssetId;
  installedAt: string;
  confirmedAt?: string;
};

export type RuntimeVerification = {
  ok: boolean;
  runtimeDir: string;
  manifest?: CoworkRuntimeManifest;
  errors: string[];
  checks: Record<string, string>;
};

export type CoworkRuntimeSetupResult = {
  runtimeDir: string;
  manifest: CoworkRuntimeManifest;
  runtimeEnv: Record<string, string>;
  source: "explicit" | "installed" | "downloaded" | "fallback";
};
