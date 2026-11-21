import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleRuneRelease,
  assertCandidateNewerThanOriginating,
  assertReleaseTagMatchesVersion,
  compareSemver,
  computeNextPatchVersion,
  ORIGINATING_ELECTRON_COMMIT,
  ORIGINATING_ELECTRON_TAG,
  ORIGINATING_ELECTRON_VERSION,
  type PackageSummaryRecord,
  parseVersionFromReleaseTag,
  REQUIRED_BRIDGE_PLATFORM_KEYS,
  verifyAssembledReleaseDir,
} from "../scripts/assemble_rune_release";
import {
  BRIDGE_UPGRADE_LANES,
  fetchPinnedOriginatingFixture,
  PINNED_ORIGINATING_FIXTURE,
  REQUIRED_BRIDGE_UPGRADE_LANES,
  seedDisposableBridgeProfile,
  verifyBridgeProfileContinuity,
} from "../scripts/bridge_upgrade_fixture";
import {
  advanceBridgeFeedAfterHop1Download,
  assertDisposableRunnerGuard,
  assertHop1AuditLog,
  assertHop2AuditLog,
  assertWindowsInstallLocationMatches,
  buildLateClientAdditionalAtomTags,
  normalizeWindowsInstallLocation,
  parseAndVerifyWindowsRuneRegistryOutput,
} from "../scripts/bridge_upgrade_harness";
import { startBridgeUpgradeServer } from "../scripts/bridge_upgrade_server";
import type { UpdaterFragment, UpdaterPlatformKey } from "../scripts/desktop_rune_release_manifest";
import {
  LEGACY_MAC_CHANNEL_FILENAME,
  serializeLegacyMacChannelYaml,
} from "../scripts/legacy_mac_updater";
import {
  LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME,
  LEGACY_WINDOWS_X64_CHANNEL_FILENAME,
  serializeLegacyWindowsChannelYaml,
} from "../scripts/legacy_windows_updater";
import { scratchRoots } from "../src/platform/scratchRoots";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Compile the Rust persistence continuity test binary at suite load, outside
// Bun's per-test timeout (matching `test/helpers/rustServerHarness.ts`). Cold
// `cowork-desktop` builds compile Rune's `opt-level = 3` dependency graph and
// routinely exceed a 120s per-test timeout on hosted CI runners.
function buildBridgeContinuityTestBinary(): string {
  const args = [
    "test",
    "-p",
    "cowork-desktop",
    "--test",
    "bridge_profile_continuity",
    "--no-run",
    "--message-format=json-render-diagnostics",
  ];
  const build = spawnSync("cargo", args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (build.error || build.status !== 0) {
    throw new Error(
      `Failed to build bridge_profile_continuity test binary with cargo ${args.join(" ")}: ${build.error?.message ?? `exit ${build.status ?? build.signal}`}`,
    );
  }
  for (const line of build.stdout.trim().split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as {
      reason?: string;
      target?: { name?: string };
      executable?: string | null;
    };
    if (
      event.reason === "compiler-artifact" &&
      event.target?.name === "bridge_profile_continuity" &&
      typeof event.executable === "string" &&
      existsSync(event.executable)
    ) {
      return event.executable;
    }
  }
  throw new Error(
    "Cargo test --no-run succeeded but did not report an executable for bridge_profile_continuity.",
  );
}

const bridgeProfileContinuityBinary = buildBridgeContinuityTestBinary();

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", prefix));
}

function sha512Base64(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function fakeMinisignSig(label: string): string {
  const line2 = Buffer.from(`RWQ${label}sig00000000000000000000000000`).toString("base64");
  const line4 = Buffer.from(`global-${label}-sig-0000000000000000000`).toString("base64");
  return [
    `untrusted comment: signature from minisign secret key (${label})`,
    line2,
    `trusted comment: ${label}`,
    line4,
  ].join("\n");
}

interface SyntheticPlatformOverrides {
  signedPlatform?: boolean;
  notarized?: boolean;
  signedUpdater?: boolean;
  omitPlatforms?: UpdaterPlatformKey[];
  omitSigFor?: UpdaterPlatformKey[];
  tamperSummaryShaFor?: UpdaterPlatformKey;
}

async function createSynthetic6PlatformArtifacts(
  artifactsDir: string,
  version: string,
  overrides: SyntheticPlatformOverrides = {},
): Promise<void> {
  const omitSet = new Set(overrides.omitPlatforms ?? []);
  const omitSigSet = new Set(overrides.omitSigFor ?? []);

  const specs: Array<{
    platformKey: UpdaterPlatformKey;
    rustTarget: string;
    updaterFile: string;
    updaterFormat: UpdaterFragment["format"];
    legacyMacZip?: string;
    legacyWindowsExe?: string;
    extraFiles?: string[];
  }> = [
    {
      platformKey: "macos-aarch64",
      rustTarget: "aarch64-apple-darwin",
      updaterFile: `Cowork_${version}_aarch64.app.tar.gz`,
      updaterFormat: "app",
      legacyMacZip: `Cowork_${version}_arm64-mac.zip`,
      extraFiles: [`Cowork_${version}_aarch64.dmg`],
    },
    {
      platformKey: "macos-x86_64",
      rustTarget: "x86_64-apple-darwin",
      updaterFile: `Cowork_${version}_x64.app.tar.gz`,
      updaterFormat: "app",
      legacyMacZip: `Cowork_${version}_x64-mac.zip`,
      extraFiles: [`Cowork_${version}_x64.dmg`],
    },
    {
      platformKey: "windows-x86_64",
      rustTarget: "x86_64-pc-windows-msvc",
      updaterFile: `Cowork_${version}_x64-setup.exe`,
      updaterFormat: "nsis",
      legacyWindowsExe: `Cowork_${version}_x64-setup.exe`,
    },
    {
      platformKey: "windows-aarch64",
      rustTarget: "aarch64-pc-windows-msvc",
      updaterFile: `Cowork_${version}_arm64-setup.exe`,
      updaterFormat: "nsis",
      legacyWindowsExe: `Cowork_${version}_arm64-setup.exe`,
    },
    {
      platformKey: "linux-x86_64",
      rustTarget: "x86_64-unknown-linux-gnu",
      updaterFile: `Cowork_${version}_x86_64.AppImage`,
      updaterFormat: "appimage",
      extraFiles: [`cowork-desktop_${version}_amd64.deb`],
    },
    {
      platformKey: "linux-aarch64",
      rustTarget: "aarch64-unknown-linux-gnu",
      updaterFile: `Cowork_${version}_aarch64.AppImage`,
      updaterFormat: "appimage",
      extraFiles: [`cowork-desktop_${version}_arm64.deb`],
    },
  ];

  for (const spec of specs) {
    if (omitSet.has(spec.platformKey)) continue;
    const platDir = path.join(artifactsDir, `desktop-rune-${spec.platformKey}`);
    await fs.mkdir(platDir, { recursive: true });

    const updaterBytes = Buffer.from(`payload:${spec.platformKey}:${version}:${spec.updaterFile}`);
    await fs.writeFile(path.join(platDir, spec.updaterFile), updaterBytes);

    const sig = fakeMinisignSig(`${spec.platformKey}-${version}`);
    if (!omitSigSet.has(spec.platformKey)) {
      await fs.writeFile(path.join(platDir, `${spec.updaterFile}.sig`), `${sig}\n`, "utf8");
    }

    const fragment: UpdaterFragment = {
      platformKey: spec.platformKey,
      version,
      format: spec.updaterFormat,
      fileName: spec.updaterFile,
      signature: sig,
    };
    await fs.writeFile(
      path.join(platDir, `updater-fragment-${spec.platformKey}.json`),
      `${JSON.stringify(fragment, null, 2)}\n`,
      "utf8",
    );

    let legacyMacZip: PackageSummaryRecord["legacyMacZip"] = null;
    if (spec.legacyMacZip) {
      const zipBytes = Buffer.from(`mac-zip:${spec.platformKey}:${version}:${spec.legacyMacZip}`);
      await fs.writeFile(path.join(platDir, spec.legacyMacZip), zipBytes);
      legacyMacZip = {
        fileName: spec.legacyMacZip,
        sha512:
          overrides.tamperSummaryShaFor === spec.platformKey
            ? sha512Base64(Buffer.from("tampered"))
            : sha512Base64(zipBytes),
        size: zipBytes.length,
      };
    }

    let legacyWindowsInstaller: PackageSummaryRecord["legacyWindowsInstaller"] = null;
    if (spec.legacyWindowsExe) {
      legacyWindowsInstaller = {
        fileName: spec.legacyWindowsExe,
        sha512:
          overrides.tamperSummaryShaFor === spec.platformKey
            ? sha512Base64(Buffer.from("tampered"))
            : sha512Base64(updaterBytes),
        size: updaterBytes.length,
      };
    }

    for (const extra of spec.extraFiles ?? []) {
      await fs.writeFile(path.join(platDir, extra), Buffer.from(`extra:${extra}:${version}`));
    }

    const isMac = spec.platformKey.startsWith("macos-");
    const isWin = spec.platformKey.startsWith("windows-");
    const summary: PackageSummaryRecord = {
      platformKey: spec.platformKey,
      rustTarget: spec.rustTarget,
      version,
      signedPlatform: overrides.signedPlatform ?? (isMac || isWin),
      notarized: overrides.notarized ?? isMac,
      signedUpdater: overrides.signedUpdater ?? true,
      artifacts: [
        spec.updaterFile,
        ...(spec.legacyMacZip ? [spec.legacyMacZip] : []),
        ...(spec.extraFiles ?? []),
      ],
      updaterFragment: `updater-fragment-${spec.platformKey}.json`,
      legacyMacZip,
      legacyWindowsInstaller,
    };
    await fs.writeFile(
      path.join(platDir, `package-summary-${spec.platformKey}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
  }
}

describe("bridge release assembly, late-client Latest tags, and integrity gates (VAL-UP-003)", () => {
  test("compares semver strictly, validates tags, and rejects versions <= originating 1.3.1", () => {
    expect(compareSemver("1.3.1", "1.3.1")).toBe(0);
    expect(compareSemver("1.4.0", "1.3.1")).toBe(1);
    expect(compareSemver("1.5.0", "1.4.0")).toBe(1);
    expect(compareSemver("1.3.1-rc.1", "1.3.1")).toBe(-1);
    expect(compareSemver("1.4.0-rc.2", "1.4.0-rc.1")).toBe(1);
    expect(compareSemver("1.4.0-rc.10", "1.4.0-rc.2")).toBe(1);

    expect(computeNextPatchVersion("1.4.0")).toBe("1.4.1");
    expect(computeNextPatchVersion("v1.5.2")).toBe("1.5.3");
    expect(parseVersionFromReleaseTag("v1.5.0")).toBe("1.5.0");
    expect(parseVersionFromReleaseTag("desktop-rune-v1.4.0")).toBe("1.4.0");
    expect(() => parseVersionFromReleaseTag("win-sandbox-v0.2.0")).toThrow(
      /Unsupported desktop release tag/,
    );

    expect(() => assertReleaseTagMatchesVersion("v1.5.0", "1.5.0")).not.toThrow();
    expect(() => assertReleaseTagMatchesVersion("v1.5.0", "1.4.0")).toThrow(/does not match/);

    expect(() => assertCandidateNewerThanOriginating("1.4.0")).not.toThrow();
    expect(() => assertCandidateNewerThanOriginating("1.5.0")).not.toThrow();
    expect(() => assertCandidateNewerThanOriginating("1.3.1")).toThrow(/strictly newer/);
    expect(() => assertCandidateNewerThanOriginating("1.3.0")).toThrow(/strictly newer/);
    expect(() => assertCandidateNewerThanOriginating("1.3.1-rc.1")).toThrow(/strictly newer/);
  });

  test("assembles and verifies both first bridge release (v1.4.0) and later Latest release (v1.5.0) with real electron-updater GitHubProvider", async () => {
    const tempRoot = await makeTempDir("cowork-bridge-assembly-");
    let server: Awaited<ReturnType<typeof startBridgeUpgradeServer>> | null = null;
    try {
      const artifacts140 = path.join(tempRoot, "artifacts-1.4.0");
      const release140 = path.join(tempRoot, "release-1.4.0");
      const artifacts150 = path.join(tempRoot, "artifacts-1.5.0");
      const release150 = path.join(tempRoot, "release-1.5.0");
      const artifacts151 = path.join(tempRoot, "artifacts-1.5.1");
      const release151 = path.join(tempRoot, "release-1.5.1");

      await createSynthetic6PlatformArtifacts(artifacts140, "1.4.0");
      await createSynthetic6PlatformArtifacts(artifacts150, "1.5.0");
      await createSynthetic6PlatformArtifacts(artifacts151, "1.5.1");

      const assembled140 = await assembleRuneRelease({
        artifactsDir: artifacts140,
        outDir: release140,
        version: "1.4.0",
        tag: "v1.4.0",
        pubDate: "2026-11-20T12:00:00.000Z",
        requireComplete: true,
        requireSigned: true,
      });
      const assembled150 = await assembleRuneRelease({
        artifactsDir: artifacts150,
        outDir: release150,
        version: "1.5.0",
        tag: "v1.5.0",
        pubDate: "2026-12-01T12:00:00.000Z",
        requireComplete: true,
        requireSigned: true,
      });
      const assembled151 = await assembleRuneRelease({
        artifactsDir: artifacts151,
        outDir: release151,
        version: "1.5.1",
        tag: "v1.5.1",
        pubDate: "2026-12-10T12:00:00.000Z",
        requireComplete: true,
        requireSigned: true,
      });

      // Internal metadata files must not leak into release-upload/.
      for (const assembled of [assembled140, assembled150, assembled151]) {
        expect(assembled.assets).toContain("latest.json");
        expect(assembled.assets).toContain(LEGACY_MAC_CHANNEL_FILENAME);
        expect(assembled.assets).toContain(LEGACY_WINDOWS_X64_CHANNEL_FILENAME);
        expect(assembled.assets).toContain(LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME);
        expect(assembled.assets.some((f) => f.startsWith("updater-fragment-"))).toBe(false);
        expect(assembled.assets.some((f) => f.startsWith("package-summary-"))).toBe(false);
      }

      // Spin up local non-publishing GitHub Release feed server starting at v1.4.0, then advancing
      // to v1.5.0 (late user skipping v1.4.0) and v1.5.1 (Hop 2 Rune -> Rune update).
      server = await startBridgeUpgradeServer({
        owner: "mweinbach",
        repo: "agent-coworker",
        releases: [
          { tag: "v1.4.0", version: "1.4.0", dir: release140, pubDate: "2026-11-20T12:00:00Z" },
          { tag: "v1.5.0", version: "1.5.0", dir: release150, pubDate: "2026-12-01T12:00:00Z" },
          { tag: "v1.5.1", version: "1.5.1", dir: release151, pubDate: "2026-12-10T12:00:00Z" },
        ],
        initialLatestTag: "v1.4.0",
        additionalAtomTags: buildLateClientAdditionalAtomTags({
          candidateTag: "v1.5.0",
          candidateVersion: "1.5.0",
        }),
      });

      // Exercise the real installed electron-updater@6.8.9 GitHubProvider against our local server.
      const { GitHubProvider } = await import(
        "../node_modules/electron-updater/out/providers/GitHubProvider.js"
      );
      const { MacUpdater } = await import("../node_modules/electron-updater/out/MacUpdater.js");

      const makeHttpExecutor = () => ({
        request: async (options: {
          protocol?: string;
          hostname?: string;
          port?: number | string;
          path?: string;
          headers?: Record<string, string>;
        }) => {
          const proto = (options.protocol ?? "http:").replace(/:$/, "");
          const portPart = options.port ? `:${options.port}` : "";
          const reqUrl = `${proto}://${options.hostname}${portPart}${options.path}`;
          const resp = await fetch(reqUrl, {
            headers: options.headers,
            redirect: "manual",
          });
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} for ${reqUrl}`);
          }
          return await resp.text();
        },
      });

      const resolveWithRealGitHubProvider = async (opts: {
        channel: string | null;
        platform: "darwin" | "win32";
        isArm64Mac?: boolean;
      }) => {
        const updaterStub = {
          channel: opts.channel,
          allowPrerelease: false,
          fullChangelog: false,
          currentVersion: { raw: ORIGINATING_ELECTRON_VERSION },
          isAddNoCacheQuery: false,
          getRequestHeaders: () => ({}),
        };
        const provider = new GitHubProvider(
          {
            provider: "github",
            owner: "mweinbach",
            repo: "agent-coworker",
            protocol: "http",
            host: `127.0.0.1:${server!.port}`,
          },
          updaterStub,
          {
            isUseMultipleRangeRequest: false,
            platform: opts.platform,
            executor: makeHttpExecutor(),
          },
        );
        const info = await provider.getLatestVersion();
        const files = provider.resolveFiles(info);
        const selected =
          opts.platform === "darwin"
            ? MacUpdater.filterFilesForArch(files, Boolean(opts.isArm64Mac))[0]
            : files[0];
        // Also actually fetch the resolved asset from the server and verify exact SHA-512!
        const assetResp = await fetch(selected.url.href);
        expect(assetResp.status).toBe(200);
        const downloaded = Buffer.from(await assetResp.arrayBuffer());
        expect(downloaded.length).toBe(selected.info.size);
        expect(sha512Base64(downloaded)).toBe(selected.info.sha512);
        return { tag: info.tag, version: info.version, url: selected.url.pathname };
      };

      // Phase A: First transition release (v1.4.0)
      const macArm140 = await resolveWithRealGitHubProvider({
        channel: null,
        platform: "darwin",
        isArm64Mac: true,
      });
      expect(macArm140).toEqual({
        tag: "v1.4.0",
        version: "1.4.0",
        url: "/mweinbach/agent-coworker/releases/download/v1.4.0/Cowork_1.4.0_arm64-mac.zip",
      });
      const macX64140 = await resolveWithRealGitHubProvider({
        channel: null,
        platform: "darwin",
        isArm64Mac: false,
      });
      expect(macX64140.url).toBe(
        "/mweinbach/agent-coworker/releases/download/v1.4.0/Cowork_1.4.0_x64-mac.zip",
      );
      const winX64140 = await resolveWithRealGitHubProvider({
        channel: null,
        platform: "win32",
      });
      expect(winX64140.url).toBe(
        "/mweinbach/agent-coworker/releases/download/v1.4.0/Cowork_1.4.0_x64-setup.exe",
      );
      const winArm140 = await resolveWithRealGitHubProvider({
        channel: "latest-arm64",
        platform: "win32",
      });
      expect(winArm140.url).toBe(
        "/mweinbach/agent-coworker/releases/download/v1.4.0/Cowork_1.4.0_arm64-setup.exe",
      );

      // Phase B: Late user skipping v1.4.0 directly onto later Latest tag v1.5.0
      const switchResp = await fetch(`${server.controlUrl}/_control/set-latest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "v1.5.0" }),
      });
      expect(switchResp.status).toBe(200);

      const macArm150 = await resolveWithRealGitHubProvider({
        channel: null,
        platform: "darwin",
        isArm64Mac: true,
      });
      expect(macArm150).toEqual({
        tag: "v1.5.0",
        version: "1.5.0",
        url: "/mweinbach/agent-coworker/releases/download/v1.5.0/Cowork_1.5.0_arm64-mac.zip",
      });
      const winX64150 = await resolveWithRealGitHubProvider({
        channel: null,
        platform: "win32",
      });
      expect(winX64150.url).toBe(
        "/mweinbach/agent-coworker/releases/download/v1.5.0/Cowork_1.5.0_x64-setup.exe",
      );
      const winArm150 = await resolveWithRealGitHubProvider({
        channel: "latest-arm64",
        platform: "win32",
      });
      expect(winArm150.url).toBe(
        "/mweinbach/agent-coworker/releases/download/v1.5.0/Cowork_1.5.0_arm64-setup.exe",
      );

      // Verify Hop 1 audit log passes for every native upgrade lane against v1.5.0!
      for (const laneId of REQUIRED_BRIDGE_UPGRADE_LANES) {
        assertHop1AuditLog({
          requests: server.getRequests(),
          owner: "mweinbach",
          repo: "agent-coworker",
          candidateTag: "v1.5.0",
          candidateVersion: "1.5.0",
          lane: BRIDGE_UPGRADE_LANES[laneId],
        });
      }

      // Phase C: Hop 2 (Rune v1.5.0 -> next signed Rune v1.5.1 via latest.json)
      server.setActiveTag("v1.5.1");
      const latestJsonResp = await fetch(
        `${server.url}/mweinbach/agent-coworker/releases/latest/download/latest.json`,
      );
      expect(latestJsonResp.status).toBe(200);
      const latestJson = (await latestJsonResp.json()) as {
        version: string;
        platforms: Record<UpdaterPlatformKey, { url: string; signature: string }>;
      };
      expect(latestJson.version).toBe("1.5.1");
      expect(Object.keys(latestJson.platforms).sort()).toEqual(
        [...REQUIRED_BRIDGE_PLATFORM_KEYS].sort(),
      );

      for (const laneId of REQUIRED_BRIDGE_UPGRADE_LANES) {
        const lane = BRIDGE_UPGRADE_LANES[laneId];
        const entry = latestJson.platforms[lane.platformKey];
        const assetPath = new URL(entry.url).pathname;
        const assetResp = await fetch(`${server.url}${assetPath}`);
        expect(assetResp.status).toBe(200);
        assertHop2AuditLog({
          requests: server.getRequests(),
          owner: "mweinbach",
          repo: "agent-coworker",
          followupTag: "v1.5.1",
          followupVersion: "1.5.1",
          lane,
        });
      }
    } finally {
      await server?.stop();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("fails closed on missing assets, hash drift, bad signatures, wrong tags, unsigned summaries, and non-newer versions", async () => {
    const tempRoot = await makeTempDir("cowork-bridge-failclosed-");
    try {
      // 1. Version <= originating 1.3.1 rejected
      const art131 = path.join(tempRoot, "art-1.3.1");
      await createSynthetic6PlatformArtifacts(art131, "1.3.1");
      await expect(
        assembleRuneRelease({
          artifactsDir: art131,
          outDir: path.join(tempRoot, "out-1.3.1"),
          version: "1.3.1",
          tag: "v1.3.1",
          requireComplete: true,
          requireSigned: true,
        }),
      ).rejects.toThrow(/strictly newer/);

      // 2. Missing required platform (windows-aarch64) rejected
      const artMissingWinArm = path.join(tempRoot, "art-missing-win-arm64");
      await createSynthetic6PlatformArtifacts(artMissingWinArm, "1.5.0", {
        omitPlatforms: ["windows-aarch64"],
      });
      await expect(
        assembleRuneRelease({
          artifactsDir: artMissingWinArm,
          outDir: path.join(tempRoot, "out-missing-win-arm64"),
          version: "1.5.0",
          tag: "v1.5.0",
          requireComplete: true,
          requireSigned: true,
        }),
      ).rejects.toThrow(/Missing package-summary-windows-aarch64\.json/);

      // 3. Unnotarized macOS rejected when requireSigned=true
      const artUnnotarized = path.join(tempRoot, "art-unnotarized");
      await createSynthetic6PlatformArtifacts(artUnnotarized, "1.5.0", {
        notarized: false,
      });
      await expect(
        assembleRuneRelease({
          artifactsDir: artUnnotarized,
          outDir: path.join(tempRoot, "out-unnotarized"),
          version: "1.5.0",
          tag: "v1.5.0",
          requireComplete: true,
          requireSigned: true,
        }),
      ).rejects.toThrow(/not Apple notarized/);

      // 4. Unsigned Windows rejected when requireSigned=true
      const artUnsignedPlatform = path.join(tempRoot, "art-unsigned-platform");
      await createSynthetic6PlatformArtifacts(artUnsignedPlatform, "1.5.0", {
        signedPlatform: false,
      });
      await expect(
        assembleRuneRelease({
          artifactsDir: artUnsignedPlatform,
          outDir: path.join(tempRoot, "out-unsigned-platform"),
          version: "1.5.0",
          tag: "v1.5.0",
          requireComplete: true,
          requireSigned: true,
        }),
      ).rejects.toThrow(/not Developer ID codesigned|not Authenticode signed/);

      // 5. Missing .sig file rejected
      const artMissingSig = path.join(tempRoot, "art-missing-sig");
      await createSynthetic6PlatformArtifacts(artMissingSig, "1.5.0", {
        omitSigFor: ["macos-aarch64"],
      });
      await expect(
        assembleRuneRelease({
          artifactsDir: artMissingSig,
          outDir: path.join(tempRoot, "out-missing-sig"),
          version: "1.5.0",
          tag: "v1.5.0",
          requireComplete: true,
          requireSigned: true,
        }),
      ).rejects.toThrow(/Missing Minisign signature file/);

      // 6. Summary digest drift against staged bytes rejected
      const artTamperedSummary = path.join(tempRoot, "art-tampered-summary");
      await createSynthetic6PlatformArtifacts(artTamperedSummary, "1.5.0", {
        tamperSummaryShaFor: "macos-aarch64",
      });
      await expect(
        assembleRuneRelease({
          artifactsDir: artTamperedSummary,
          outDir: path.join(tempRoot, "out-tampered-summary"),
          version: "1.5.0",
          tag: "v1.5.0",
          requireComplete: true,
          requireSigned: true,
        }),
      ).rejects.toThrow(/drifted from package summary/);

      // 7. Post-assembly tampering (corrupted ZIP, wrong tag URL, deleted feed) rejected by verifyAssembledReleaseDir
      const goodArt = path.join(tempRoot, "art-good");
      const goodOut = path.join(tempRoot, "out-good");
      await createSynthetic6PlatformArtifacts(goodArt, "1.5.0");
      await assembleRuneRelease({
        artifactsDir: goodArt,
        outDir: goodOut,
        version: "1.5.0",
        tag: "v1.5.0",
        requireComplete: true,
        requireSigned: true,
      });

      // Corrupt macOS arm64 ZIP bytes after assembly -> verify must fail
      const macZipPath = path.join(goodOut, "Cowork_1.5.0_arm64-mac.zip");
      const origZip = await fs.readFile(macZipPath);
      await fs.writeFile(macZipPath, Buffer.concat([origZip, Buffer.from("X")]));
      await expect(
        verifyAssembledReleaseDir({
          dir: goodOut,
          version: "1.5.0",
          tag: "v1.5.0",
          requireComplete: true,
        }),
      ).rejects.toThrow(/latest-mac\.yml digest\/size mismatch/);
      await fs.writeFile(macZipPath, origZip);

      // Rewrite latest.json URL to point to wrong tag -> verify must fail
      const latestJsonPath = path.join(goodOut, "latest.json");
      const origLatestJson = await fs.readFile(latestJsonPath, "utf8");
      await fs.writeFile(latestJsonPath, origLatestJson.replace("/v1.5.0/", "/v1.4.0/"), "utf8");
      await expect(
        verifyAssembledReleaseDir({
          dir: goodOut,
          version: "1.5.0",
          tag: "v1.5.0",
          requireComplete: true,
        }),
      ).rejects.toThrow(/does not resolve to release tag "v1\.5\.0"/);
      await fs.writeFile(latestJsonPath, origLatestJson, "utf8");

      // Delete latest-arm64.yml -> verify must fail
      await fs.rm(path.join(goodOut, LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME));
      await expect(
        verifyAssembledReleaseDir({
          dir: goodOut,
          version: "1.5.0",
          tag: "v1.5.0",
          requireComplete: true,
        }),
      ).rejects.toThrow(/missing legacy Windows arm64 feed/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("assemble_rune_release CLI succeeds on valid candidate and exits non-zero on failing inputs", async () => {
    const tempRoot = await makeTempDir("cowork-assemble-cli-");
    try {
      const artDir = path.join(tempRoot, "art");
      const outDir = path.join(tempRoot, "out");
      await createSynthetic6PlatformArtifacts(artDir, "1.5.0");

      const assembleProc = Bun.spawn(
        [
          "bun",
          path.join(repoRoot, "scripts", "assemble_rune_release.ts"),
          "assemble",
          "--artifacts-dir",
          artDir,
          "--out-dir",
          outDir,
          "--version",
          "1.5.0",
          "--tag",
          "v1.5.0",
          "--require-complete",
          "--require-signed",
        ],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      expect(await assembleProc.exited).toBe(0);

      const verifyProc = Bun.spawn(
        [
          "bun",
          path.join(repoRoot, "scripts", "assemble_rune_release.ts"),
          "verify",
          "--dir",
          outDir,
          "--version",
          "1.5.0",
          "--tag",
          "v1.5.0",
        ],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      expect(await verifyProc.exited).toBe(0);

      // Failing version check CLI must exit non-zero
      const badVersionProc = Bun.spawn(
        [
          "bun",
          path.join(repoRoot, "scripts", "assemble_rune_release.ts"),
          "check-version",
          "--version",
          "1.3.1",
          "--tag",
          "v1.3.1",
        ],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      expect(await badVersionProc.exited).not.toBe(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("pinned historical fixture, disposable guards, profile continuity, and native CI gates (VAL-CROSS-001)", () => {
  test("pins historical v1.3.1 originating release commit without depending on active Electron product", async () => {
    expect(PINNED_ORIGINATING_FIXTURE.tag).toBe(ORIGINATING_ELECTRON_TAG);
    expect(PINNED_ORIGINATING_FIXTURE.version).toBe(ORIGINATING_ELECTRON_VERSION);
    expect(PINNED_ORIGINATING_FIXTURE.commitSha).toBe(ORIGINATING_ELECTRON_COMMIT);
    expect(PINNED_ORIGINATING_FIXTURE.bundleId).toBe("com.cowork.desktop");

    // Verify the pinned commit matches git tag v1.3.1 when tags are present locally.
    const revParse = Bun.spawn(["git", "rev-parse", `${ORIGINATING_ELECTRON_TAG}^{commit}`], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await revParse.exited;
    if (code === 0) {
      const actualSha = (await new Response(revParse.stdout).text()).trim();
      expect(actualSha).toBe(ORIGINATING_ELECTRON_COMMIT);
    }
  });

  test("fetches and integrity-verifies pinned v1.3.1 fixture per lane and fails closed on tampering", async () => {
    const tempRoot = await makeTempDir("cowork-pinned-fixture-");
    let mirror: ReturnType<typeof Bun.serve> | null = null;
    try {
      const macBytes = Buffer.from("synthetic-originating-mac-v1.3.1-zip");
      const winX64Bytes = Buffer.from("synthetic-originating-win-x64-v1.3.1-exe");
      const winArmBytes = Buffer.from("synthetic-originating-win-arm64-v1.3.1-exe");

      const files: Record<string, Buffer | string> = {
        "Cowork-1.3.1-arm64-mac.zip": macBytes,
        "Cowork-1.3.1-win-x64.exe": winX64Bytes,
        "Cowork-1.3.1-win-arm64.exe": winArmBytes,
        [LEGACY_MAC_CHANNEL_FILENAME]: serializeLegacyMacChannelYaml({
          version: "1.3.1",
          files: [
            {
              url: "Cowork-1.3.1-arm64-mac.zip",
              sha512: sha512Base64(macBytes),
              size: macBytes.length,
            },
          ],
          path: "Cowork-1.3.1-arm64-mac.zip",
          sha512: sha512Base64(macBytes),
          releaseDate: "2026-10-04T16:00:00.000Z",
        }),
        [LEGACY_WINDOWS_X64_CHANNEL_FILENAME]: serializeLegacyWindowsChannelYaml({
          version: "1.3.1",
          files: [
            {
              url: "Cowork-1.3.1-win-x64.exe",
              sha512: sha512Base64(winX64Bytes),
              size: winX64Bytes.length,
            },
          ],
          path: "Cowork-1.3.1-win-x64.exe",
          sha512: sha512Base64(winX64Bytes),
          releaseDate: "2026-10-04T16:00:00.000Z",
        }),
        [LEGACY_WINDOWS_ARM64_CHANNEL_FILENAME]: serializeLegacyWindowsChannelYaml({
          version: "1.3.1",
          files: [
            {
              url: "Cowork-1.3.1-win-arm64.exe",
              sha512: sha512Base64(winArmBytes),
              size: winArmBytes.length,
            },
          ],
          path: "Cowork-1.3.1-win-arm64.exe",
          sha512: sha512Base64(winArmBytes),
          releaseDate: "2026-10-04T16:00:00.000Z",
        }),
      };

      mirror = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const name = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
          const body = files[name];
          if (body === undefined) return new Response("Not found", { status: 404 });
          return new Response(body, { status: 200 });
        },
      });
      const baseUrl = `http://127.0.0.1:${mirror.port}`;

      for (const laneId of REQUIRED_BRIDGE_UPGRADE_LANES) {
        const fetched = await fetchPinnedOriginatingFixture({
          lane: laneId,
          outDir: path.join(tempRoot, laneId),
          baseUrl,
          requireSigned: false,
        });
        expect(fetched.version).toBe("1.3.1");
        expect(fetched.tag).toBe("v1.3.1");
        expect(fetched.commitSha).toBe(ORIGINATING_ELECTRON_COMMIT);
      }

      // Tamper bytes on mirror -> SHA-512 check must fail closed
      files["Cowork-1.3.1-arm64-mac.zip"] = Buffer.from("CORRUPTED-ZIP-BYTES-SAME-LENGTH-XX!!");
      await expect(
        fetchPinnedOriginatingFixture({
          lane: "macos-arm64",
          outDir: path.join(tempRoot, "tampered"),
          baseUrl,
          requireSigned: false,
        }),
      ).rejects.toThrow(/SHA-512 mismatch|size mismatch/);
    } finally {
      mirror?.stop(true);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("disposable runner guard blocks local developer execution and profile/audit checks fail closed", async () => {
    expect(() =>
      assertDisposableRunnerGuard({ allowDisposableHost: false, env: { GITHUB_ACTIONS: "true" } }),
    ).toThrow(/--allow-disposable-host/);
    expect(() => assertDisposableRunnerGuard({ allowDisposableHost: true, env: {} })).toThrow(
      /outside disposable CI/,
    );
    expect(() =>
      assertDisposableRunnerGuard({ allowDisposableHost: true, env: { GITHUB_ACTIONS: "true" } }),
    ).not.toThrow();

    // Missing updater requests fail Hop 1 / Hop 2 audit checks
    expect(() =>
      assertHop1AuditLog({
        requests: [],
        owner: "mweinbach",
        repo: "agent-coworker",
        candidateTag: "v1.5.0",
        candidateVersion: "1.5.0",
        lane: BRIDGE_UPGRADE_LANES["macos-arm64"],
      }),
    ).toThrow(/did not observe required real updater requests/);

    expect(() =>
      assertHop2AuditLog({
        requests: [],
        owner: "mweinbach",
        repo: "agent-coworker",
        followupTag: "v1.5.1",
        followupVersion: "1.5.1",
        lane: BRIDGE_UPGRADE_LANES["windows-arm64"],
      }),
    ).toThrow(/did not observe required real native updater requests/);

    // Disposable profile continuity check passes on intact profile and fails closed on loss
    const tempRoot = await makeTempDir("cowork-profile-continuity-");
    try {
      const profile = await seedDisposableBridgeProfile({
        userDataDir: path.join(tempRoot, "Cowork"),
        coworkHomeDir: path.join(tempRoot, ".cowork"),
        workspaceDir: path.join(tempRoot, "workspace"),
      });
      await expect(verifyBridgeProfileContinuity(profile)).resolves.toBeUndefined();

      await fs.rm(profile.sentinelFilePath);
      await expect(verifyBridgeProfileContinuity(profile)).rejects.toThrow(/sentinel missing/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("seeded canonical version-2 profile is read by Rune's actual PersistenceService reader and survives save", async () => {
    const tempRoot = await makeTempDir("cowork-rune-persistence-bridge-");
    try {
      const realWorkspaceTarget = path.join(tempRoot, "real-workspace");
      await fs.mkdir(realWorkspaceTarget, { recursive: true });
      const symlinkWorkspaceDir = path.join(tempRoot, "workspace-link");
      await fs.symlink(realWorkspaceTarget, symlinkWorkspaceDir);

      const profile = await seedDisposableBridgeProfile({
        userDataDir: path.join(tempRoot, "Cowork"),
        coworkHomeDir: path.join(tempRoot, ".cowork"),
        workspaceDir: symlinkWorkspaceDir,
      });

      // 1. Verify canonical v2 schema fields directly on disk (no invented threadsByWorkspace).
      const seededDoc = JSON.parse(await fs.readFile(profile.stateFilePath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(seededDoc.version).toBe(2);
      expect(seededDoc.schemaVersion).toBeUndefined();
      expect(seededDoc.threadsByWorkspace).toBeUndefined();
      expect(Array.isArray(seededDoc.threads)).toBe(true);
      expect((seededDoc.onboarding as { status?: string })?.status).toBe("completed");
      expect((seededDoc.onboarding as { dismissedAt?: unknown })?.dismissedAt).toBeNull();
      expect(seededDoc.activeWorkspaceId).toBe(profile.workspaceId);
      expect(seededDoc.activeThreadId).toBe(profile.threadId);

      // 2. Run Rune's actual Rust PersistenceService reader + merge_and_save_core_snapshot
      //    against the exact disposable profile seeded by seedDisposableBridgeProfile.
      const runRunePersistenceCheck = async (extraEnv?: Record<string, string>) => {
        const proc = Bun.spawn(
          [
            bridgeProfileContinuityBinary,
            "seeded_bridge_profile_from_env_roundtrips_through_rune_persistence",
            "--exact",
            "--nocapture",
          ],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              COWORK_TEST_BRIDGE_PROFILE_DIR: profile.userDataDir,
              COWORK_TEST_BRIDGE_WORKSPACE_DIR: profile.workspaceDir,
              ...extraEnv,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(exitCode, `Rune persistence check failed:\n${stdout}\n${stderr}`).toBe(0);
      };

      await runRunePersistenceCheck();
      // Verify continuity checker still passes after Rune's real merge_and_save_core_snapshot write-back.
      await expect(verifyBridgeProfileContinuity(profile)).resolves.toBeUndefined();

      // 3. Simulate Electron v1.3.1's sanitizePersistedState write-back (which strips
      //    activeWorkspaceId/activeThreadId and desktopSettings.theme while keeping version: 2,
      //    workspaces, top-level threads, and completed onboarding) and re-verify through Rune.
      const postElectronState = JSON.parse(
        await fs.readFile(profile.stateFilePath, "utf8"),
      ) as Record<string, unknown>;
      delete postElectronState.activeWorkspaceId;
      delete postElectronState.activeThreadId;
      postElectronState.desktopSettings = {
        quickChat: {
          iconEnabled: true,
          shortcutEnabled: true,
          shortcutAccelerator: "CommandOrControl+Shift+Space",
        },
        archivedChatsAutoDeleteDays: 30,
        sidebarSectionOrder: ["workspaces", "threads"],
      };
      await fs.writeFile(
        profile.stateFilePath,
        `${JSON.stringify(postElectronState, null, 2)}\n`,
        "utf8",
      );

      await runRunePersistenceCheck({ COWORK_TEST_BRIDGE_EXPECT_ELECTRON_SANITIZED: "1" });
      await expect(verifyBridgeProfileContinuity(profile)).resolves.toBeUndefined();

      // 4. Negative schema checks: verifier fails closed on incompatible/broken state.json.
      await fs.writeFile(
        profile.stateFilePath,
        `${JSON.stringify({
          schemaVersion: 2,
          workspaces: [
            {
              id: profile.workspaceId,
              name: "Bridge Workspace",
              path: profile.workspaceDir,
              kind: "project",
            },
          ],
          threadsByWorkspace: {
            [profile.workspaceId]: [{ id: profile.threadId, title: profile.threadTitle }],
          },
        })}\n`,
        "utf8",
      );
      await expect(verifyBridgeProfileContinuity(profile)).rejects.toThrow(/version must be >= 2/);

      // Pending onboarding fails closed (would leave Rune onboarding modal open during Hop 2).
      const pendingOnboardingDoc = {
        ...seededDoc,
        onboarding: { status: "pending", completedAt: null, dismissedAt: null },
      };
      await fs.writeFile(
        profile.stateFilePath,
        `${JSON.stringify(pendingOnboardingDoc, null, 2)}\n`,
        "utf8",
      );
      await expect(verifyBridgeProfileContinuity(profile)).rejects.toThrow(
        /completed onboarding state missing or modified/,
      );

      // Missing top-level thread fails closed.
      const missingThreadDoc = { ...seededDoc, threads: [] };
      await fs.writeFile(
        profile.stateFilePath,
        `${JSON.stringify(missingThreadDoc, null, 2)}\n`,
        "utf8",
      );
      await expect(verifyBridgeProfileContinuity(profile)).rejects.toThrow(
        /seeded top-level thread/,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);

  test("Windows InstallLocation comparison accepts quoted and unquoted matching paths and rejects drifted or malformed paths", async () => {
    // Confirm the NSIS template still writes quoted UNINSTKEY\InstallLocation and unquoted MANUPRODUCTKEY\InstallLocation.
    const nsiSource = await fs.readFile(
      path.join(repoRoot, "crates", "cowork-desktop", "packaging", "nsis", "installer.nsi"),
      "utf8",
    );
    expect(nsiSource).toContain(
      'WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\\"$INSTDIR$\\""',
    );
    expect(nsiSource).toContain(
      'WriteRegStr SHCTX "${MANUPRODUCTKEY}" "InstallLocation" "$INSTDIR"',
    );

    const expectedDir = "C:\\Users\\runneradmin\\AppData\\Local\\Programs\\Cowork";

    // Legitimate quoted and unquoted InstallLocation values match cleanly.
    expect(normalizeWindowsInstallLocation(`"${expectedDir}"`)).toBe(expectedDir);
    expect(normalizeWindowsInstallLocation(`"${expectedDir}\\"`)).toBe(expectedDir);
    expect(normalizeWindowsInstallLocation(expectedDir)).toBe(expectedDir);
    expect(normalizeWindowsInstallLocation(`${expectedDir}\\`)).toBe(expectedDir);

    expect(() =>
      assertWindowsInstallLocationMatches(`"${expectedDir}"`, expectedDir),
    ).not.toThrow();
    expect(() =>
      assertWindowsInstallLocationMatches(`"${expectedDir}\\"`, expectedDir),
    ).not.toThrow();
    expect(() => assertWindowsInstallLocationMatches(expectedDir, expectedDir)).not.toThrow();
    expect(() =>
      assertWindowsInstallLocationMatches(
        '"c:\\program files\\Cowork\\"',
        "C:\\Program Files\\Cowork",
      ),
    ).not.toThrow();

    // Realistic PowerShell ConvertTo-Json -Compress output with NSIS-quoted InstallLocation passes.
    expect(() =>
      parseAndVerifyWindowsRuneRegistryOutput(
        JSON.stringify({
          DisplayVersion: "1.5.0",
          InstallLocation: `"${expectedDir}"`,
        }),
        { installDir: expectedDir, expectedVersion: "1.5.0" },
      ),
    ).not.toThrow();

    // Unquoted InstallLocation also passes when exact path matches.
    expect(() =>
      parseAndVerifyWindowsRuneRegistryOutput(
        JSON.stringify({
          DisplayVersion: "1.5.0",
          InstallLocation: expectedDir,
        }),
        { installDir: expectedDir, expectedVersion: "1.5.0" },
      ),
    ).not.toThrow();

    // Different paths MUST be rejected (never silently accepted after quote stripping).
    for (const differentPath of [
      '"C:\\Other\\Cowork"',
      `"${expectedDir}2"`,
      `"${expectedDir}\\sub"`,
      '"C:\\Users\\runneradmin\\AppData\\Local\\Programs"',
      "D:\\Users\\runneradmin\\AppData\\Local\\Programs\\Cowork",
    ]) {
      expect(() => assertWindowsInstallLocationMatches(differentPath, expectedDir)).toThrow(
        /InstallLocation drifted/,
      );
    }

    // Malformed, unbalanced, double-quoted, empty, or relative values MUST be rejected.
    for (const malformed of [
      `"${expectedDir}`,
      `${expectedDir}"`,
      `""${expectedDir}""`,
      `"${expectedDir}" --extra`,
      '""',
      "   ",
      "Cowork",
    ]) {
      expect(() => assertWindowsInstallLocationMatches(malformed, expectedDir)).toThrow();
    }

    // DisplayVersion drift MUST be rejected.
    expect(() =>
      parseAndVerifyWindowsRuneRegistryOutput(
        JSON.stringify({
          DisplayVersion: "1.4.0",
          InstallLocation: `"${expectedDir}"`,
        }),
        { installDir: expectedDir, expectedVersion: "1.5.0" },
      ),
    ).toThrow(/DisplayVersion is 1\.4\.0, expected 1\.5\.0/);
  });

  test("fixture feed advances to next native release before candidate's first poll without changing production timers", async () => {
    // Production updater timers in Rune must remain unchanged.
    const updaterSource = await fs.readFile(
      path.join(repoRoot, "crates", "cowork-desktop", "src", "native", "updater.rs"),
      "utf8",
    );
    expect(updaterSource).toContain(
      "const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(10);",
    );
    expect(updaterSource).toContain(
      "const AUTOMATIC_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);",
    );

    const tempRoot = await makeTempDir("cowork-bridge-feed-timing-");
    let server: Awaited<ReturnType<typeof startBridgeUpgradeServer>> | null = null;
    try {
      const candidateArtifacts = path.join(tempRoot, "cand-in");
      await createSynthetic6PlatformArtifacts(candidateArtifacts, "1.5.0");
      const candidateOut = path.join(tempRoot, "cand-out");
      await assembleRuneRelease({
        artifactsDir: candidateArtifacts,
        outDir: candidateOut,
        version: "1.5.0",
        tag: "v1.5.0",
        owner: "mweinbach",
        repo: "agent-coworker",
        pubDate: "2026-11-15T12:00:00Z",
        requireSigned: true,
        requireComplete: true,
        minOriginatingVersion: ORIGINATING_ELECTRON_VERSION,
      });

      const followupArtifacts = path.join(tempRoot, "next-in");
      await createSynthetic6PlatformArtifacts(followupArtifacts, "1.5.1");
      const followupOut = path.join(tempRoot, "next-out");
      await assembleRuneRelease({
        artifactsDir: followupArtifacts,
        outDir: followupOut,
        version: "1.5.1",
        tag: "v1.5.1",
        owner: "mweinbach",
        repo: "agent-coworker",
        pubDate: "2026-11-15T13:00:00Z",
        requireSigned: true,
        requireComplete: true,
        minOriginatingVersion: "1.5.0",
      });

      server = await startBridgeUpgradeServer({
        owner: "mweinbach",
        repo: "agent-coworker",
        releases: [
          { tag: "v1.5.0", version: "1.5.0", dir: candidateOut },
          { tag: "v1.5.1", version: "1.5.1", dir: followupOut },
        ],
        initialLatestTag: "v1.5.0",
        additionalAtomTags: buildLateClientAdditionalAtomTags({
          candidateTag: "v1.5.0",
          candidateVersion: "1.5.0",
        }),
      });

      const lane = BRIDGE_UPGRADE_LANES["windows-x64"];

      // Advancing before Hop 1 completes must fail closed without mutating activeTag.
      expect(() =>
        advanceBridgeFeedAfterHop1Download({
          server: server!,
          owner: "mweinbach",
          repo: "agent-coworker",
          candidateTag: "v1.5.0",
          candidateVersion: "1.5.0",
          followupTag: "v1.5.1",
          lane,
        }),
      ).toThrow(/did not observe required real updater requests/);
      expect(server.getActiveTag()).toBe("v1.5.0");

      // Execute Hop 1 requests while activeTag === v1.5.0.
      const r1 = await fetch(`${server.url}/mweinbach/agent-coworker/releases.atom`);
      expect(r1.status).toBe(200);
      const r2 = await fetch(`${server.url}/mweinbach/agent-coworker/releases/latest`, {
        headers: { Accept: "application/json" },
      });
      expect(r2.status).toBe(200);
      const r3 = await fetch(
        `${server.url}/mweinbach/agent-coworker/releases/download/v1.5.0/${lane.candidateChannelFile}`,
      );
      expect(r3.status).toBe(200);
      const r4 = await fetch(
        `${server.url}/mweinbach/agent-coworker/releases/download/v1.5.0/${lane.resolveCandidateLegacyAsset("1.5.0")}`,
      );
      expect(r4.status).toBe(200);

      // Advance Latest -> v1.5.1 BEFORE candidate Rune starts or makes its first poll.
      advanceBridgeFeedAfterHop1Download({
        server,
        owner: "mweinbach",
        repo: "agent-coworker",
        candidateTag: "v1.5.0",
        candidateVersion: "1.5.0",
        followupTag: "v1.5.1",
        lane,
      });
      expect(server.getActiveTag()).toBe("v1.5.1");

      // Candidate Rune's VERY FIRST poll of latest.json must immediately receive v1.5.1 (not v1.5.0).
      const firstFeedResp = await fetch(
        `${server.url}/mweinbach/agent-coworker/releases/latest/download/latest.json`,
      );
      expect(firstFeedResp.status).toBe(200);
      const firstFeed = (await firstFeedResp.json()) as { version: string };
      expect(firstFeed.version).toBe("1.5.1");

      const followupAssetResp = await fetch(
        `${server.url}/mweinbach/agent-coworker/releases/download/v1.5.1/${lane.resolveFollowupNativeAsset("1.5.1")}`,
      );
      expect(followupAssetResp.status).toBe(200);

      expect(() =>
        assertHop2AuditLog({
          requests: server!.getRequests(),
          owner: "mweinbach",
          repo: "agent-coworker",
          followupTag: "v1.5.1",
          followupVersion: "1.5.1",
          lane,
          candidateTag: "v1.5.0",
        }),
      ).not.toThrow();

      // Negative timing race check: if Rune polled latest.json while activeTag was still v1.5.0,
      // assertHop2AuditLog must reject it as a feed timing race.
      const racedServer = await startBridgeUpgradeServer({
        owner: "mweinbach",
        repo: "agent-coworker",
        releases: [
          { tag: "v1.5.0", version: "1.5.0", dir: candidateOut },
          { tag: "v1.5.1", version: "1.5.1", dir: followupOut },
        ],
        initialLatestTag: "v1.5.0",
      });
      try {
        const premature = await fetch(
          `${racedServer.url}/mweinbach/agent-coworker/releases/latest/download/latest.json`,
        );
        expect(premature.status).toBe(200);
        racedServer.setActiveTag("v1.5.1");
        await fetch(
          `${racedServer.url}/mweinbach/agent-coworker/releases/latest/download/latest.json`,
        );
        await fetch(
          `${racedServer.url}/mweinbach/agent-coworker/releases/download/v1.5.1/${lane.resolveFollowupNativeAsset("1.5.1")}`,
        );

        expect(() =>
          assertHop2AuditLog({
            requests: racedServer.getRequests(),
            owner: "mweinbach",
            repo: "agent-coworker",
            followupTag: "v1.5.1",
            followupVersion: "1.5.1",
            lane,
            candidateTag: "v1.5.0",
          }),
        ).toThrow(/feed timing race detected/);
      } finally {
        await racedServer.stop();
      }
    } finally {
      await server?.stop();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("desktop-rune-release workflow wires non-publishing native macOS/Win-x64/Win-ARM64 upgrade gates and fail-closed promotion", async () => {
    const rawWorkflow = await fs.readFile(
      path.join(repoRoot, ".github", "workflows", "desktop-rune-release.yml"),
      "utf8",
    );
    const parsed = Bun.YAML.parse(rawWorkflow) as {
      permissions?: Record<string, string>;
      jobs: Record<
        string,
        {
          needs?: string | string[];
          if?: string;
          permissions?: Record<string, string>;
          strategy?: {
            "fail-fast"?: boolean;
            matrix?: { include?: Array<Record<string, string>> };
          };
          steps?: Array<{
            name?: string;
            uses?: string;
            run?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };

    expect(parsed.permissions).toEqual({ contents: "read" });

    // assemble-candidate is non-publishing and depends on validate + package
    const assembleJob = parsed.jobs["assemble-candidate"];
    expect(assembleJob).toBeDefined();
    expect(assembleJob?.needs).toEqual(["validate", "package"]);
    expect(assembleJob?.permissions).toEqual({ contents: "read" });

    // verify-upgrade is non-publishing, fail-fast=false, covers macos-15, windows-latest, windows-11-arm
    const verifyJob = parsed.jobs["verify-upgrade"];
    expect(verifyJob).toBeDefined();
    expect(verifyJob?.needs).toEqual(["validate", "assemble-candidate"]);
    expect(verifyJob?.permissions).toEqual({ contents: "read" });
    expect(verifyJob?.strategy?.["fail-fast"]).toBe(false);

    const matrix = verifyJob?.strategy?.matrix?.include ?? [];
    expect(matrix.map((row) => ({ lane: row.lane, runner: row.runner, arch: row.arch }))).toEqual([
      { lane: "macos-arm64", runner: "macos-15", arch: "arm64" },
      { lane: "windows-x64", runner: "windows-latest", arch: "x64" },
      { lane: "windows-arm64", runner: "windows-11-arm", arch: "arm64" },
    ]);

    const verifyScriptText = (verifyJob?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(verifyScriptText).toContain("scripts/bridge_upgrade_fixture.ts fetch");
    expect(verifyScriptText).toContain("scripts/bridge_upgrade_harness.ts run");
    expect(verifyScriptText).toContain("--require-signed");
    expect(verifyScriptText).toContain("--allow-disposable-host");

    // release job depends on ALL four upstream jobs and requires verify-upgrade success for promotion
    const releaseJob = parsed.jobs.release;
    expect(releaseJob).toBeDefined();
    expect(releaseJob?.needs).toEqual([
      "validate",
      "package",
      "assemble-candidate",
      "verify-upgrade",
    ]);
    expect(releaseJob?.if).toContain("needs.validate.result == 'success'");
    expect(releaseJob?.if).toContain("needs.package.result == 'success'");
    expect(releaseJob?.if).toContain("needs.assemble-candidate.result == 'success'");
    expect(releaseJob?.if).toContain("needs.verify-upgrade.result == 'success'");

    const releaseStep = (releaseJob?.steps ?? []).find((s) =>
      s.uses?.startsWith("softprops/action-gh-release@"),
    );
    expect(releaseStep?.uses).toMatch(/^softprops\/action-gh-release@[0-9a-f]{40}$/);
    expect(String(releaseStep?.with?.make_latest ?? "")).toContain(
      "needs.validate.outputs.prerelease == 'true' && 'false' || 'true'",
    );

    // Other non-desktop release workflows must NEVER displace GitHub's Latest tag
    for (const nonDesktopWorkflow of ["win-sandbox-release.yml", "cowork-server-release.yml"]) {
      const content = await fs.readFile(
        path.join(repoRoot, ".github", "workflows", nonDesktopWorkflow),
        "utf8",
      );
      const doc = Bun.YAML.parse(content) as {
        jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
      };
      const ghReleaseSteps = Object.values(doc.jobs)
        .flatMap((j) => j.steps ?? [])
        .filter((s) => s.uses?.startsWith("softprops/action-gh-release@"));
      expect(ghReleaseSteps.length, nonDesktopWorkflow).toBeGreaterThan(0);
      for (const step of ghReleaseSteps) {
        expect(String(step.with?.make_latest ?? ""), nonDesktopWorkflow).toBe("false");
      }
    }
  });
});
