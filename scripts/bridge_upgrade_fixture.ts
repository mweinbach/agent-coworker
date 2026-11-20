import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ORIGINATING_ELECTRON_COMMIT,
  ORIGINATING_ELECTRON_TAG,
  ORIGINATING_ELECTRON_VERSION,
} from "./assemble_rune_release";
import {
  DEFAULT_GITHUB_OWNER,
  DEFAULT_GITHUB_REPO,
  type UpdaterPlatformKey,
} from "./desktop_rune_release_manifest";
import {
  LEGACY_MAC_CHANNEL_FILENAME,
  parseLegacyMacChannelYaml,
  resolveLegacyMacZipName,
  resolveMacTarGzName,
  selectLegacyMacZipForClient,
  verifyMacCodeSignatureAndNotarization,
} from "./legacy_mac_updater";
import {
  LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME,
  LEGACY_WINDOWS_X64_CHANNEL_FILENAME,
  parseLegacyWindowsChannelYaml,
  resolveLegacyWindowsInstallerName,
  selectLegacyWindowsInstallerForClient,
  verifyWindowsAuthenticodeSignature,
} from "./legacy_windows_updater";

export type BridgeUpgradeLaneId = "macos-arm64" | "windows-x64" | "windows-arm64";

export interface BridgeUpgradeLaneSpec {
  lane: BridgeUpgradeLaneId;
  runner: "macos-15" | "windows-latest" | "windows-11-arm";
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  platformKey: UpdaterPlatformKey;
  rustTarget: string;
  packagerFormats: string;
  originatingChannelFile: string;
  originatingAssetPattern: RegExp;
  candidateChannelFile: string;
  resolveCandidateLegacyAsset: (version: string) => string;
  resolveFollowupNativeAsset: (version: string) => string;
}

export const PINNED_ORIGINATING_FIXTURE = {
  owner: DEFAULT_GITHUB_OWNER,
  repo: DEFAULT_GITHUB_REPO,
  tag: ORIGINATING_ELECTRON_TAG,
  version: ORIGINATING_ELECTRON_VERSION,
  commitSha: ORIGINATING_ELECTRON_COMMIT,
  bundleId: "com.cowork.desktop",
  productName: "Cowork",
  windowsLegacyUninstallGuid: "dd76376f-991d-5a9b-8b5f-cc05306dc019",
} as const;

export const BRIDGE_UPGRADE_LANES: Record<BridgeUpgradeLaneId, BridgeUpgradeLaneSpec> = {
  "macos-arm64": {
    lane: "macos-arm64",
    runner: "macos-15",
    platform: "darwin",
    arch: "arm64",
    platformKey: "macos-aarch64",
    rustTarget: "aarch64-apple-darwin",
    packagerFormats: "app,dmg",
    originatingChannelFile: LEGACY_MAC_CHANNEL_FILENAME,
    originatingAssetPattern: /^Cowork-1\.3\.1-arm64-mac\.zip$/,
    candidateChannelFile: LEGACY_MAC_CHANNEL_FILENAME,
    resolveCandidateLegacyAsset: (version) => resolveLegacyMacZipName("arm64", version),
    resolveFollowupNativeAsset: (version) => resolveMacTarGzName("arm64", version),
  },
  "windows-x64": {
    lane: "windows-x64",
    runner: "windows-latest",
    platform: "win32",
    arch: "x64",
    platformKey: "windows-x86_64",
    rustTarget: "x86_64-pc-windows-msvc",
    packagerFormats: "nsis",
    originatingChannelFile: LEGACY_WINDOWS_X64_CHANNEL_FILENAME,
    originatingAssetPattern: /^Cowork-1\.3\.1-win-x64\.exe$/,
    candidateChannelFile: LEGACY_WINDOWS_X64_CHANNEL_FILENAME,
    resolveCandidateLegacyAsset: (version) => resolveLegacyWindowsInstallerName("x64", version),
    resolveFollowupNativeAsset: (version) => resolveLegacyWindowsInstallerName("x64", version),
  },
  "windows-arm64": {
    lane: "windows-arm64",
    runner: "windows-11-arm",
    platform: "win32",
    arch: "arm64",
    platformKey: "windows-aarch64",
    rustTarget: "aarch64-pc-windows-msvc",
    packagerFormats: "nsis",
    originatingChannelFile: LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME,
    originatingAssetPattern: /^Cowork-1\.3\.1-win-arm64\.exe$/,
    candidateChannelFile: LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME,
    resolveCandidateLegacyAsset: (version) => resolveLegacyWindowsInstallerName("arm64", version),
    resolveFollowupNativeAsset: (version) => resolveLegacyWindowsInstallerName("arm64", version),
  },
};

export const REQUIRED_BRIDGE_UPGRADE_LANES: readonly BridgeUpgradeLaneId[] = [
  "macos-arm64",
  "windows-x64",
  "windows-arm64",
];

export function resolveBridgeUpgradeLane(raw: string): BridgeUpgradeLaneSpec {
  const key = raw.trim().toLowerCase() as BridgeUpgradeLaneId;
  const spec = BRIDGE_UPGRADE_LANES[key];
  if (!spec) {
    throw new Error(
      `Unsupported bridge upgrade lane "${raw}". Expected one of: ${REQUIRED_BRIDGE_UPGRADE_LANES.join(", ")}.`,
    );
  }
  return spec;
}

export interface FetchedOriginatingFixture {
  lane: BridgeUpgradeLaneId;
  tag: string;
  version: string;
  commitSha: string;
  channelFile: string;
  assetName: string;
  assetPath: string;
  sha512: string;
  sha256: string;
  size: number;
  verifiedSigned: boolean;
}

async function downloadToBuffer(url: string, token?: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    "User-Agent": "cowork-bridge-upgrade-fixture/1.0",
    Accept: "application/octet-stream",
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch pinned fixture URL ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function execCapture(
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export async function fetchPinnedOriginatingFixture(params: {
  lane: BridgeUpgradeLaneId;
  outDir: string;
  baseUrl?: string;
  githubToken?: string;
  requireSigned?: boolean;
  expectedSha256?: string;
  expectedWindowsPublisher?: string;
}): Promise<FetchedOriginatingFixture> {
  const spec = resolveBridgeUpgradeLane(params.lane);
  const outDir = path.resolve(params.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const baseUrl = (
    params.baseUrl ??
    `https://github.com/${PINNED_ORIGINATING_FIXTURE.owner}/${PINNED_ORIGINATING_FIXTURE.repo}/releases/download/${PINNED_ORIGINATING_FIXTURE.tag}`
  ).replace(/\/+$/, "");

  const channelUrl = `${baseUrl}/${spec.originatingChannelFile}`;
  const channelText = (await downloadToBuffer(channelUrl, params.githubToken)).toString("utf8");

  let expectedAssetName: string;
  let expectedSha512: string;
  let expectedSize: number;

  if (spec.platform === "darwin") {
    const meta = parseLegacyMacChannelYaml(channelText);
    if (meta.version !== PINNED_ORIGINATING_FIXTURE.version) {
      throw new Error(
        `Pinned originating ${spec.originatingChannelFile} reports version ${meta.version}, expected ${PINNED_ORIGINATING_FIXTURE.version}.`,
      );
    }
    const selected = selectLegacyMacZipForClient(meta, {
      processArch: spec.arch,
      isRosetta: false,
      owner: PINNED_ORIGINATING_FIXTURE.owner,
      repo: PINNED_ORIGINATING_FIXTURE.repo,
      tag: PINNED_ORIGINATING_FIXTURE.tag,
    });
    if (!selected) {
      throw new Error(
        `Pinned originating ${spec.originatingChannelFile} did not select a macOS ZIP for ${spec.arch}.`,
      );
    }
    expectedAssetName = selected.fileName;
    expectedSha512 = selected.entry.sha512;
    expectedSize = selected.entry.size;
  } else {
    const meta = parseLegacyWindowsChannelYaml(channelText, spec.arch);
    if (meta.version !== PINNED_ORIGINATING_FIXTURE.version) {
      throw new Error(
        `Pinned originating ${spec.originatingChannelFile} reports version ${meta.version}, expected ${PINNED_ORIGINATING_FIXTURE.version}.`,
      );
    }
    const selected = selectLegacyWindowsInstallerForClient(
      { [spec.originatingChannelFile]: meta },
      {
        arch: spec.arch,
        tag: PINNED_ORIGINATING_FIXTURE.tag,
        owner: PINNED_ORIGINATING_FIXTURE.owner,
        repo: PINNED_ORIGINATING_FIXTURE.repo,
      },
    );
    if (!selected) {
      throw new Error(
        `Pinned originating ${spec.originatingChannelFile} did not select a Windows installer for ${spec.arch}.`,
      );
    }
    expectedAssetName = selected.fileName;
    expectedSha512 = selected.entry.sha512;
    expectedSize = selected.entry.size;
  }

  if (!spec.originatingAssetPattern.test(expectedAssetName)) {
    throw new Error(
      `Pinned originating asset "${expectedAssetName}" does not match expected pattern ${spec.originatingAssetPattern} for lane ${spec.lane}.`,
    );
  }

  const assetUrl = `${baseUrl}/${encodeURIComponent(expectedAssetName)}`;
  const assetBytes = await downloadToBuffer(assetUrl, params.githubToken);

  const actualSha512 = createHash("sha512").update(assetBytes).digest("base64");
  const actualSha256 = createHash("sha256").update(assetBytes).digest("hex");

  if (assetBytes.length !== expectedSize) {
    throw new Error(
      `Pinned originating asset ${expectedAssetName} size mismatch: expected ${expectedSize}, got ${assetBytes.length}.`,
    );
  }
  if (actualSha512 !== expectedSha512) {
    throw new Error(
      `Pinned originating asset ${expectedAssetName} SHA-512 mismatch against ${spec.originatingChannelFile}.`,
    );
  }
  if (params.expectedSha256 && actualSha256 !== params.expectedSha256.trim().toLowerCase()) {
    throw new Error(
      `Pinned originating asset ${expectedAssetName} SHA-256 mismatch: expected ${params.expectedSha256}, got ${actualSha256}.`,
    );
  }

  const assetPath = path.join(outDir, expectedAssetName);
  await fs.writeFile(assetPath, assetBytes);
  await fs.writeFile(path.join(outDir, spec.originatingChannelFile), channelText, "utf8");

  let verifiedSigned = false;
  if (params.requireSigned) {
    if (spec.platform === "darwin") {
      const verifyDir = await fs.mkdtemp(path.join(outDir, ".verify-mac-sign-"));
      try {
        const extract = await execCapture(["ditto", "-x", "-k", assetPath, verifyDir]);
        if (extract.exitCode !== 0) {
          throw new Error(
            `Failed to extract originating macOS ZIP for signature check: ${extract.stderr}`,
          );
        }
        await verifyMacCodeSignatureAndNotarization({
          appPath: path.join(verifyDir, "Cowork.app"),
          requireDeveloperId: true,
          requireNotarization: true,
          expectedBundleId: PINNED_ORIGINATING_FIXTURE.bundleId,
        });
        verifiedSigned = true;
      } finally {
        await fs.rm(verifyDir, { recursive: true, force: true });
      }
    } else {
      await verifyWindowsAuthenticodeSignature(assetPath, params.expectedWindowsPublisher);
      verifiedSigned = true;
    }
  }

  return {
    lane: spec.lane,
    tag: PINNED_ORIGINATING_FIXTURE.tag,
    version: PINNED_ORIGINATING_FIXTURE.version,
    commitSha: PINNED_ORIGINATING_FIXTURE.commitSha,
    channelFile: spec.originatingChannelFile,
    assetName: expectedAssetName,
    assetPath,
    sha512: actualSha512,
    sha256: actualSha256,
    size: assetBytes.length,
    verifiedSigned,
  };
}

export interface SeededBridgeProfile {
  userDataDir: string;
  coworkHomeDir: string;
  workspaceDir: string;
  workspaceId: string;
  threadId: string;
  threadTitle: string;
  transcriptText: string;
  sentinelToken: string;
  stateFilePath: string;
  transcriptFilePath: string;
  sentinelFilePath: string;
}

async function canonicalizePathForCompare(rawPath: string): Promise<string> {
  const resolved = path.resolve(rawPath);
  const real = await fs.realpath(resolved).catch(() => resolved);
  return real.replace(/[\\/]+$/, "").toLowerCase();
}

export async function seedDisposableBridgeProfile(params: {
  userDataDir: string;
  coworkHomeDir: string;
  workspaceDir: string;
  sentinelToken?: string;
}): Promise<SeededBridgeProfile> {
  const userDataDir = path.resolve(params.userDataDir);
  const coworkHomeDir = path.resolve(params.coworkHomeDir);
  const rawWorkspaceDir = path.resolve(params.workspaceDir);
  const workspaceId = "ws-bridge-continuity-001";
  const threadId = "thread-bridge-continuity-001";
  const threadTitle = "Bridge upgrade profile continuity check";
  const transcriptText = "Preserved historical message before Electron to Rune upgrade.";
  const sentinelToken =
    params.sentinelToken ?? `bridge-sentinel-${PINNED_ORIGINATING_FIXTURE.version}`;

  await fs.mkdir(path.join(userDataDir, "transcripts"), { recursive: true });
  await fs.mkdir(coworkHomeDir, { recursive: true });
  await fs.mkdir(rawWorkspaceDir, { recursive: true });
  const workspaceDir = await fs.realpath(rawWorkspaceDir).catch(() => rawWorkspaceDir);
  await fs.writeFile(
    path.join(workspaceDir, "README.md"),
    "# Disposable Bridge Upgrade Workspace\n",
    "utf8",
  );

  // Canonical version-2 persisted desktop state shared by Electron v1.3.1
  // (`sanitizePersistedState`) and Rune (`crates/cowork-desktop/src/native/persistence.rs`).
  const now = "2026-10-04T16:00:00.000Z";
  const state = {
    version: 2,
    workspaces: [
      {
        id: workspaceId,
        name: "Bridge Workspace",
        path: workspaceDir,
        workspaceKind: "project",
        createdAt: now,
        lastOpenedAt: now,
        archived: false,
        wsProtocol: "jsonrpc",
        defaultEnableMcp: true,
        defaultBackupsEnabled: false,
        yolo: false,
      },
    ],
    threads: [
      {
        id: threadId,
        workspaceId,
        title: threadTitle,
        titleSource: "manual",
        createdAt: now,
        lastMessageAt: now,
        status: "active",
        sessionId: null,
        messageCount: 1,
        lastEventSeq: 1,
        archived: false,
      },
    ],
    workspaceOrder: [workspaceId],
    collapsedWorkspaceIds: [],
    collapsedSidebarSections: [],
    activeWorkspaceId: workspaceId,
    activeThreadId: threadId,
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: false,
    desktopSettings: {
      theme: "dark",
    },
    onboarding: {
      status: "completed",
      completedAt: now,
      dismissedAt: null,
    },
  };

  const stateFilePath = path.join(userDataDir, "state.json");
  await fs.writeFile(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const transcriptEvent = {
    ts: now,
    threadId,
    direction: "client",
    payload: {
      id: "msg-bridge-001",
      role: "user",
      text: transcriptText,
    },
  };
  const transcriptFilePath = path.join(userDataDir, "transcripts", `${threadId}.jsonl`);
  await fs.writeFile(transcriptFilePath, `${JSON.stringify(transcriptEvent)}\n`, "utf8");

  const sentinelFilePath = path.join(coworkHomeDir, "bridge-profile-sentinel.json");
  await fs.writeFile(
    sentinelFilePath,
    `${JSON.stringify({ token: sentinelToken, originatingVersion: PINNED_ORIGINATING_FIXTURE.version }, null, 2)}\n`,
    "utf8",
  );

  return {
    userDataDir,
    coworkHomeDir,
    workspaceDir,
    workspaceId,
    threadId,
    threadTitle,
    transcriptText,
    sentinelToken,
    stateFilePath,
    transcriptFilePath,
    sentinelFilePath,
  };
}

export async function verifyBridgeProfileContinuity(profile: SeededBridgeProfile): Promise<void> {
  const stateRaw = await fs.readFile(profile.stateFilePath, "utf8").catch(() => null);
  if (!stateRaw) {
    throw new Error(
      `Profile continuity failed: missing desktop state file ${profile.stateFilePath}`,
    );
  }
  const state = JSON.parse(stateRaw) as {
    version?: unknown;
    workspaces?: Array<{ id?: string; path?: string; workspaceKind?: string }>;
    threads?: Array<{
      id?: string;
      workspaceId?: string;
      title?: string;
      createdAt?: string;
      lastMessageAt?: string;
    }>;
    onboarding?: {
      status?: string;
      completedAt?: string | null;
      dismissedAt?: string | null;
    };
  };
  if (typeof state.version !== "number" || !Number.isFinite(state.version) || state.version < 2) {
    throw new Error(
      `Profile continuity failed: desktop state version must be >= 2 in ${profile.stateFilePath} (got ${String(state.version)}).`,
    );
  }

  const workspace = state.workspaces?.find((ws) => ws.id === profile.workspaceId);
  if (!workspace) {
    throw new Error(
      `Profile continuity failed: workspace "${profile.workspaceId}" missing from ${profile.stateFilePath}`,
    );
  }
  if (workspace.workspaceKind !== "project") {
    throw new Error(
      `Profile continuity failed: workspace "${profile.workspaceId}" workspaceKind drifted (${String(workspace.workspaceKind)} vs project).`,
    );
  }
  const normalizedExpected = await canonicalizePathForCompare(profile.workspaceDir);
  const normalizedActual = await canonicalizePathForCompare(workspace.path ?? "");
  if (normalizedActual !== normalizedExpected) {
    throw new Error(
      `Profile continuity failed: workspace path drifted (${workspace.path} vs ${profile.workspaceDir}).`,
    );
  }

  const threads = Array.isArray(state.threads) ? state.threads : [];
  const thread = threads.find(
    (t) => t.id === profile.threadId && t.workspaceId === profile.workspaceId,
  );
  if (
    !thread ||
    thread.title !== profile.threadTitle ||
    typeof thread.createdAt !== "string" ||
    !thread.createdAt.trim() ||
    typeof thread.lastMessageAt !== "string" ||
    !thread.lastMessageAt.trim()
  ) {
    throw new Error(
      `Profile continuity failed: seeded top-level thread "${profile.threadId}" missing or modified in ${profile.stateFilePath}.`,
    );
  }

  if (
    state.onboarding?.status !== "completed" ||
    typeof state.onboarding.completedAt !== "string" ||
    !state.onboarding.completedAt.trim() ||
    state.onboarding.dismissedAt !== null
  ) {
    throw new Error(
      `Profile continuity failed: completed onboarding state missing or modified in ${profile.stateFilePath} (got ${JSON.stringify(state.onboarding ?? null)}).`,
    );
  }

  const transcriptRaw = await fs.readFile(profile.transcriptFilePath, "utf8").catch(() => null);
  if (!transcriptRaw) {
    throw new Error(`Profile continuity failed: missing transcript ${profile.transcriptFilePath}.`);
  }
  const transcriptLines = transcriptRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasSeededTranscriptEvent = transcriptLines.some((line) => {
    try {
      const event = JSON.parse(line) as { threadId?: string; payload?: { text?: string } };
      return event.threadId === profile.threadId && event.payload?.text === profile.transcriptText;
    } catch {
      return false;
    }
  });
  if (!hasSeededTranscriptEvent) {
    throw new Error(
      `Profile continuity failed: transcript ${profile.transcriptFilePath} missing seeded message.`,
    );
  }

  const sentinelRaw = await fs.readFile(profile.sentinelFilePath, "utf8").catch(() => null);
  if (!sentinelRaw) {
    throw new Error(
      `Profile continuity failed: ~/.cowork sentinel missing at ${profile.sentinelFilePath}.`,
    );
  }
  const sentinel = JSON.parse(sentinelRaw) as { token?: string };
  if (sentinel.token !== profile.sentinelToken) {
    throw new Error(
      `Profile continuity failed: ~/.cowork sentinel token mismatch (${sentinel.token} vs ${profile.sentinelToken}).`,
    );
  }
}

function getFlagValue(argv: readonly string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  const prefix = `${flag}=`;
  const eq = argv.find((arg) => arg.startsWith(prefix));
  return eq ? eq.slice(prefix.length) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(
      [
        "Usage:",
        "  bun scripts/bridge_upgrade_fixture.ts info [--lane <macos-arm64|windows-x64|windows-arm64>]",
        "  bun scripts/bridge_upgrade_fixture.ts fetch --lane <lane> --out-dir <dir> [--base-url <url>] [--require-signed] [--expected-sha256 <hex>] [--publisher <subject>]",
      ].join("\n"),
    );
    return;
  }

  if (subcommand === "info") {
    const laneArg = getFlagValue(args, "--lane");
    if (laneArg) {
      const spec = resolveBridgeUpgradeLane(laneArg);
      console.log(
        JSON.stringify(
          {
            pinnedFixture: PINNED_ORIGINATING_FIXTURE,
            lane: {
              ...spec,
              originatingAssetPattern: spec.originatingAssetPattern.source,
            },
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(JSON.stringify(PINNED_ORIGINATING_FIXTURE, null, 2));
    return;
  }

  if (subcommand === "fetch") {
    const lane = getFlagValue(args, "--lane");
    const outDir = getFlagValue(args, "--out-dir");
    const baseUrl = getFlagValue(args, "--base-url");
    const expectedSha256 =
      getFlagValue(args, "--expected-sha256") ?? process.env.COWORK_BRIDGE_ORIGINATING_SHA256;
    const expectedWindowsPublisher =
      getFlagValue(args, "--publisher") ?? process.env.WINDOWS_SIGN_PUBLISHER;
    const requireSigned = args.includes("--require-signed");

    if (!lane) throw new Error("Missing required --lane <macos-arm64|windows-x64|windows-arm64>.");
    if (!outDir) throw new Error("Missing required --out-dir <dir>.");

    const result = await fetchPinnedOriginatingFixture({
      lane: resolveBridgeUpgradeLane(lane).lane,
      outDir,
      baseUrl,
      githubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      requireSigned,
      expectedSha256,
      expectedWindowsPublisher,
    });
    console.log(
      `[bridge-fixture] Verified pinned ${result.tag} (${result.commitSha.slice(0, 12)}) for ${result.lane}: ${result.assetName} (${result.size} bytes, sha256=${result.sha256.slice(0, 16)}..., signed=${result.verifiedSigned})`,
    );
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand}". Expected "info" or "fetch".`);
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
