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

export const COWORK_RUNTIME_BOOTSTRAP_PHASES = [
  "waiting",
  "downloading",
  "installing",
  "ready",
] as const;

export type CoworkRuntimeBootstrapProgress = {
  phase: (typeof COWORK_RUNTIME_BOOTSTRAP_PHASES)[number];
  version: string;
  transferredBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
};

export type CoworkRuntimeManifest = {
  schemaVersion: 1 | 2;
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
    heifConvert?: string;
    jxrDecApp?: string;
    popplerBin?: string;
    soffice?: string;
    libreOffice?: string;
    libreOfficeBinary?: string;
  };
  payload: {
    fileCount: number;
    unpackedBytes: number;
  };
  /** Present and required for schema 2. Schema 1 remains diagnostics-only. */
  integrity?: {
    algorithm: "Ed25519";
    keyId: string;
    manifest: "runtime-integrity.json";
    signature: "runtime-integrity.sig";
  };
};

export type TrustedCoworkRuntimeManifest = CoworkRuntimeManifest & {
  schemaVersion: 2;
  integrity: NonNullable<CoworkRuntimeManifest["integrity"]>;
};

export type RuntimeIntegrityFile = {
  path: string;
  kind: "file" | "symlink";
  size: number;
  sha256: string;
};

export type RuntimeIntegrityManifest = {
  schemaVersion: 2;
  algorithm: "Ed25519";
  keyId: string;
  runtimeVersion: string;
  asset: RuntimeAssetId;
  files: RuntimeIntegrityFile[];
  components: Record<string, string[]>;
  entrypoints: Record<string, string[]>;
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
