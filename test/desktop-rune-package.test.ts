import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCargoPackagerEnv,
  buildPackagerConfig,
  loadPackagerBaseConfig,
  parsePackageCliArgs,
  prepareMacSigningEnv,
  refreshWindowsSandboxHashManifests,
  resolveCargoBuildEnv,
  resolveMacArchiveNames,
  resolvePackageVersion,
  resolvePlatformKey,
  resolveUpdaterPayloadDescriptor,
  stageRuntimeResources,
  validateUpdaterSignKeys,
} from "../scripts/desktop_rune_package";
import {
  buildLatestJsonManifest,
  normalizeSemverVersion,
  readFragmentsFromDirectory,
  type UpdaterFragment,
  validateLatestJsonManifest,
} from "../scripts/desktop_rune_release_manifest";
import {
  buildLegacyMacChannelMetadata,
  classifyLegacyMacZipArch,
  inspectMachOArchs,
  LEGACY_MAC_CHANNEL_FILENAME,
  parseLegacyMacChannelYaml,
  resolveLegacyMacZipName,
  selectLegacyMacZipForClient,
  serializeLegacyMacChannelYaml,
  verifyMacAppBundle,
  verifyMacReleaseOutputs,
  verifyMacUpdaterTarGz,
  writeLegacyMacChannelFile,
} from "../scripts/legacy_mac_updater";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/scratchRoots";
import { buildSidecarManifest, resolveStagedBinariesDir } from "../src/platform/sidecar";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", prefix));
}

describe("cowork-desktop Packager.toml & entitlements", () => {
  test("Packager.toml declares expected identity and valid asset paths", async () => {
    const config = await loadPackagerBaseConfig(repoRoot);
    expect(config.name).toBe("cowork-desktop");
    expect(config.productName).toBe("Cowork");
    expect(config.identifier).toBe("com.cowork.desktop");

    const icons = config.icons as string[];
    expect(Array.isArray(icons)).toBe(true);
    expect(icons.length).toBeGreaterThanOrEqual(3);
    for (const relIcon of icons) {
      const stat = await fs.stat(path.join(repoRoot, relIcon));
      expect(stat.isFile()).toBe(true);
    }

    const macos = config.macos as { minimumSystemVersion?: string; entitlements?: string };
    expect(macos.minimumSystemVersion).toBe("12.0");
    expect(typeof macos.entitlements).toBe("string");
    const entitlementsPath = path.join(repoRoot, macos.entitlements ?? "");
    const entitlementsXml = await fs.readFile(entitlementsPath, "utf8");
    expect(entitlementsXml).toContain("com.apple.security.cs.allow-jit");
    expect(entitlementsXml).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(entitlementsXml).toContain("com.apple.security.cs.disable-library-validation");
  });
});

describe("desktop_rune_package CLI and build config helpers", () => {
  test("parsePackageCliArgs parses target shorthands, formats, and unsigned mode", () => {
    const mac = parsePackageCliArgs(
      ["--target=macos-aarch64", "--unsigned", "--version", "1.4.0"],
      {},
      "darwin",
      "arm64",
    );
    expect(mac.platform).toBe("darwin");
    expect(mac.arch).toBe("arm64");
    expect(mac.formats).toEqual(["app", "dmg"]);
    expect(mac.skipSign).toBe(true);
    expect(mac.version).toBe("1.4.0");

    const win = parsePackageCliArgs(["--target", "x86_64-pc-windows-msvc"], {}, "win32", "x64");
    expect(win.platform).toBe("win32");
    expect(win.arch).toBe("x64");
    expect(win.formats).toEqual(["nsis"]);

    const linux = parsePackageCliArgs(
      ["--target", "linux-x64", "--formats=deb"],
      {},
      "linux",
      "x64",
    );
    expect(linux.platform).toBe("linux");
    expect(linux.arch).toBe("x64");
    expect(linux.formats).toEqual(["deb"]);

    expect(() =>
      parsePackageCliArgs(["--formats", "invalid-format"], {}, "darwin", "arm64"),
    ).toThrow(/Unsupported package format/);
  });

  test("resolves platform keys, updater payload descriptors, and mac archive names", () => {
    expect(resolvePlatformKey("darwin", "arm64")).toBe("macos-aarch64");
    expect(resolvePlatformKey("darwin", "x64")).toBe("macos-x86_64");
    expect(resolvePlatformKey("win32", "x64")).toBe("windows-x86_64");
    expect(resolvePlatformKey("win32", "arm64")).toBe("windows-aarch64");
    expect(resolvePlatformKey("linux", "x64")).toBe("linux-x86_64");
    expect(resolvePlatformKey("linux", "arm64")).toBe("linux-aarch64");

    expect(resolveUpdaterPayloadDescriptor("darwin", "arm64", "v1.3.1", ["app", "dmg"])).toEqual({
      format: "app",
      fileName: "Cowork_1.3.1_aarch64.app.tar.gz",
    });
    expect(resolveUpdaterPayloadDescriptor("win32", "x64", "1.3.1", ["nsis"])).toEqual({
      format: "nsis",
      fileName: "Cowork_1.3.1_x64-setup.exe",
    });
    expect(resolveUpdaterPayloadDescriptor("linux", "x64", "1.3.1", ["deb", "appimage"])).toEqual({
      format: "appimage",
      fileName: "Cowork_1.3.1_x86_64.AppImage",
    });
    expect(resolveMacArchiveNames("arm64", "v1.3.1")).toEqual({
      dmgName: "Cowork_1.3.1_aarch64.dmg",
      zipName: "Cowork_1.3.1_arm64-mac.zip",
      updaterTarGzName: "Cowork_1.3.1_aarch64.app.tar.gz",
    });
    expect(resolveMacArchiveNames("x64", "v1.3.1")).toEqual({
      dmgName: "Cowork_1.3.1_x64.dmg",
      zipName: "Cowork_1.3.1_x64-mac.zip",
      updaterTarGzName: "Cowork_1.3.1_x64.app.tar.gz",
    });
  });

  test("resolveCargoBuildEnv forwards version, updater pubkey, and telemetry vars", () => {
    const buildEnv = resolveCargoBuildEnv(
      {
        COWORK_UPDATER_PUBKEY: "RWTestPublicKey123",
        COWORK_SENTRY_DSN: "https://example@sentry.invalid/1",
        COWORK_POSTHOG_KEY: "phc_test",
      },
      "v1.3.2",
    );
    expect(buildEnv.COWORK_APP_VERSION).toBe("1.3.2");
    expect(buildEnv.COWORK_UPDATER_PUBKEY).toBe("RWTestPublicKey123");
    expect(buildEnv.CARGO_PACKAGER_SIGN_PUBLIC_KEY).toBe("RWTestPublicKey123");
    expect(buildEnv.COWORK_SENTRY_DSN).toBe("https://example@sentry.invalid/1");
    expect(buildEnv.COWORK_POSTHOG_KEY).toBe("phc_test");
  });

  test("prepareMacSigningEnv writes temporary p8 key for PEM API key content and supports skipNotarize", async () => {
    const tempDir = await makeTempDir("cowork-mac-sign-");
    try {
      const creds = await prepareMacSigningEnv(
        {
          APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAM123)",
          APPLE_API_KEY_ID: "KEY1234567",
          APPLE_API_KEY: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
          APPLE_API_KEY_ISSUER: "issuer-uuid-123",
        },
        { tempDir },
      );
      expect(creds.hasCertificate).toBe(true);
      expect(creds.hasNotarizeCredentials).toBe(true);
      expect(creds.signingIdentity).toBe("Developer ID Application: Example (TEAM123)");
      expect(creds.env.APPLE_API_KEY).toBe("KEY1234567");
      expect(creds.env.APPLE_API_ISSUER).toBe("issuer-uuid-123");
      expect(creds.tempFilesToCleanup.length).toBe(1);
      const writtenP8 = await fs.readFile(creds.env.APPLE_API_KEY_PATH, "utf8");
      expect(writtenP8).toContain("-----BEGIN PRIVATE KEY-----");

      const noNotarize = await prepareMacSigningEnv(
        {
          APPLE_ID: "dev@example.com",
          APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh",
          APPLE_TEAM_ID: "TEAM123",
        },
        { tempDir, skipNotarize: true, platform: "darwin" },
      );
      expect(noNotarize.hasNotarizeCredentials).toBe(false);

      const strippedEnv = buildCargoPackagerEnv({
        buildEnv: {
          COWORK_APP_VERSION: "1.3.1",
          APPLE_API_KEY: "KEY123",
          APPLE_API_KEY_PATH: "/tmp/AuthKey.p8",
          APPLE_API_ISSUER: "issuer-1",
          APPLE_ID: "dev@example.com",
          APPLE_PASSWORD: "pw",
          APPLE_APP_SPECIFIC_PASSWORD: "app-pw",
          APPLE_TEAM_ID: "TEAM123",
          APPLE_KEYCHAIN_PROFILE: "notary-profile",
        },
        macSigningEnv: {
          APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
        },
        skipNotarize: true,
      });
      expect(strippedEnv.APPLE_SIGNING_IDENTITY).toBe("Developer ID Application: Example");
      expect(strippedEnv.APPLE_API_KEY).toBeUndefined();
      expect(strippedEnv.APPLE_API_KEY_PATH).toBeUndefined();
      expect(strippedEnv.APPLE_API_ISSUER).toBeUndefined();
      expect(strippedEnv.APPLE_ID).toBeUndefined();
      expect(strippedEnv.APPLE_PASSWORD).toBeUndefined();
      expect(strippedEnv.APPLE_APP_SPECIFIC_PASSWORD).toBeUndefined();
      expect(strippedEnv.APPLE_TEAM_ID).toBeUndefined();
      expect(strippedEnv.APPLE_KEYCHAIN_PROFILE).toBeUndefined();

      // GitHub Actions passes unset optional secrets as empty strings ("").
      // Ensure CSC_KEY_PASSWORD and APPLE_APP_SPECIFIC_PASSWORD fallbacks work
      // and empty Apple ID vars cannot shadow API key auth in cargo-packager.
      const ciFallbackCreds = await prepareMacSigningEnv(
        {
          APPLE_CERTIFICATE: "",
          APPLE_CERTIFICATE_PASSWORD: "",
          APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAM123)",
          CSC_LINK: Buffer.from("dummy-p12-bytes").toString("base64"),
          CSC_KEY_PASSWORD: "csc-secret-password",
          APPLE_ID: "",
          APPLE_PASSWORD: "",
          APPLE_APP_SPECIFIC_PASSWORD: "",
          APPLE_TEAM_ID: "",
          APPLE_API_KEY_ID: "KEY999",
          APPLE_API_KEY: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
          APPLE_API_ISSUER: "issuer-uuid-999",
        },
        { tempDir, platform: "linux" },
      );
      expect(ciFallbackCreds.env.APPLE_CERTIFICATE_PASSWORD).toBe("csc-secret-password");
      expect(ciFallbackCreds.hasNotarizeCredentials).toBe(true);
      expect(ciFallbackCreds.env.APPLE_API_KEY).toBe("KEY999");

      const packagerEnv = buildCargoPackagerEnv({
        buildEnv: {
          COWORK_APP_VERSION: "1.3.1",
          APPLE_ID: "",
          APPLE_PASSWORD: "",
          APPLE_TEAM_ID: "",
          APPLE_KEYCHAIN_PROFILE: "",
          APPLE_CERTIFICATE: "",
          APPLE_CERTIFICATE_PASSWORD: "",
        },
        macSigningEnv: ciFallbackCreds.env,
        skipNotarize: false,
      });
      expect(packagerEnv.APPLE_API_KEY).toBe("KEY999");
      expect(packagerEnv.APPLE_API_ISSUER).toBe("issuer-uuid-999");
      expect(packagerEnv.APPLE_API_KEY_PATH).toBe(ciFallbackCreds.env.APPLE_API_KEY_PATH);
      expect(packagerEnv.APPLE_CERTIFICATE_PASSWORD).toBe("csc-secret-password");
      expect(packagerEnv.APPLE_ID).toBeUndefined();
      expect(packagerEnv.APPLE_PASSWORD).toBeUndefined();
      expect(packagerEnv.APPLE_TEAM_ID).toBeUndefined();
      expect(packagerEnv.APPLE_KEYCHAIN_PROFILE).toBeUndefined();

      const appleIdFallback = await prepareMacSigningEnv(
        {
          APPLE_ID: "dev@example.com",
          APPLE_PASSWORD: "",
          APPLE_APP_SPECIFIC_PASSWORD: "app-specific-pw",
          APPLE_TEAM_ID: "TEAM123",
        },
        { tempDir, platform: "linux" },
      );
      expect(appleIdFallback.hasNotarizeCredentials).toBe(true);
      expect(appleIdFallback.env.APPLE_PASSWORD).toBe("app-specific-pw");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("validateUpdaterSignKeys enforces private and public Minisign keys when requireSign is true", () => {
    expect(() =>
      validateUpdaterSignKeys({
        requireSign: true,
        skipSign: false,
        minisignPrivateKey: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvW",
        updaterPublicKey: undefined,
      }),
    ).toThrow(/COWORK_UPDATER_PUBKEY/);

    expect(() =>
      validateUpdaterSignKeys({
        requireSign: true,
        skipSign: false,
        minisignPrivateKey: undefined,
        updaterPublicKey: "RWPublicKey",
      }),
    ).toThrow(/CARGO_PACKAGER_SIGN_PRIVATE_KEY/);

    expect(() =>
      validateUpdaterSignKeys({
        requireSign: true,
        skipSign: true,
      }),
    ).not.toThrow();

    expect(() =>
      validateUpdaterSignKeys({
        requireSign: true,
        skipSign: false,
        minisignPrivateKey: "RWPrivKey",
        updaterPublicKey: "RWPubKey",
      }),
    ).not.toThrow();
  });

  test("buildPackagerConfig toggles signing fields and windows-sandbox resource cleanly", async () => {
    const baseConfig = await loadPackagerBaseConfig(repoRoot);
    const unsigned = buildPackagerConfig({
      root: repoRoot,
      baseConfig,
      version: "1.3.1",
      outDir: "/tmp/out",
      binariesDir: "/tmp/bin",
      stagedDir: "/tmp/staged",
      targetTriple: "aarch64-apple-darwin",
      includeWindowsSandbox: false,
    });
    expect(unsigned.macos?.signingIdentity).toBeUndefined();
    expect(unsigned.windows?.certificateThumbprint).toBeUndefined();
    expect(unsigned.binaries).toEqual([{ path: "Cowork", main: true }]);
    expect(unsigned.identifier).toBe("com.cowork.desktop");
    expect(unsigned.productName).toBe("Cowork");
    expect(unsigned.resources.map((item) => item.target)).toEqual([
      "dist/prompts",
      "dist/config",
      "dist/skills",
      "dist/workflows",
      "binaries",
      "tray",
    ]);

    const winSigned = buildPackagerConfig({
      root: repoRoot,
      baseConfig,
      version: "1.3.1",
      outDir: "/tmp/out",
      binariesDir: "/tmp/bin",
      stagedDir: "/tmp/staged",
      targetTriple: "x86_64-pc-windows-msvc",
      includeWindowsSandbox: true,
      windowsCertificateThumbprint: "ABCDEF123456",
    });
    expect(winSigned.windows?.certificateThumbprint).toBe("ABCDEF123456");
    expect(winSigned.binaries).toEqual([{ path: "cowork-desktop", main: true }]);
    expect(winSigned.resources.map((item) => item.target)).toContain("windows-sandbox");
  });

  test("resolvePackageVersion reads Packager.toml without apps/desktop and honors overrides", async () => {
    const tempRoot = await makeTempDir("cowork-version-");
    try {
      const packagerDir = path.join(tempRoot, "crates", "cowork-desktop", "packaging");
      await fs.mkdir(packagerDir, { recursive: true });
      await fs.writeFile(
        path.join(packagerDir, "Packager.toml"),
        'name = "cowork-desktop"\nversion = "2.4.0"\n',
        "utf8",
      );
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({ name: "agent-coworker", version: "1.0.0" }),
        "utf8",
      );

      expect(await resolvePackageVersion(tempRoot, undefined, {})).toBe("2.4.0");
      expect(
        await resolvePackageVersion(tempRoot, undefined, { COWORK_APP_VERSION: "v2.5.0" }),
      ).toBe("2.5.0");
      expect(await resolvePackageVersion(tempRoot, "2.6.0", { COWORK_APP_VERSION: "2.5.0" })).toBe(
        "2.6.0",
      );

      // Even if a conflicting apps/desktop/package.json exists, Packager.toml stays authoritative.
      await fs.mkdir(path.join(tempRoot, "apps", "desktop"), { recursive: true });
      await fs.writeFile(
        path.join(tempRoot, "apps", "desktop", "package.json"),
        JSON.stringify({ name: "desktop", version: "9.9.9" }),
        "utf8",
      );
      expect(await resolvePackageVersion(tempRoot, undefined, {})).toBe("2.4.0");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("native packaging, staging, and release workflows have no apps/desktop inputs", async () => {
    const baseConfig = await loadPackagerBaseConfig(repoRoot);
    expect(await resolvePackageVersion(repoRoot, undefined, {})).toBe(
      normalizeSemverVersion(String(baseConfig.version)),
    );

    const independentFiles = [
      "scripts/desktop_rune_package.ts",
      "scripts/legacy_mac_updater.ts",
      "scripts/build_desktop_resources.ts",
      "scripts/build_cowork_server_binary.ts",
      "scripts/workspaceRustBinary.ts",
      ".github/workflows/desktop-rune-release.yml",
      ".github/workflows/cowork-server-release.yml",
    ];
    for (const relPath of independentFiles) {
      const content = await fs.readFile(path.join(repoRoot, relPath), "utf8");
      expect(content, `${relPath} must not depend on apps/desktop`).not.toContain("apps/desktop");
      expect(content, `${relPath} must not join apps/desktop paths`).not.toMatch(
        /path\.join\([^)]*"apps"[^)]*"desktop"/,
      );
    }

    const runeWorkflow = await fs.readFile(
      path.join(repoRoot, ".github", "workflows", "desktop-rune-release.yml"),
      "utf8",
    );
    expect(runeWorkflow).toContain("desktop_rune_package.ts --print-version");
  });

  test("stageRuntimeResources stages dist/sidecar/tray/windows-sandbox without apps/desktop and refreshes sandbox sha256 manifests", async () => {
    const tempRoot = await makeTempDir("cowork-stage-");
    try {
      for (const subdir of ["prompts", "config", "skills", "workflows"]) {
        const dir = path.join(tempRoot, "dist", subdir);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "sample.txt"), `hello-${subdir}\n`, "utf8");
        await fs.writeFile(path.join(dir, "ignored.js.map"), "sourcemap", "utf8");
      }

      const binSrcDir = resolveStagedBinariesDir(tempRoot);
      await fs.mkdir(binSrcDir, { recursive: true });
      await fs.writeFile(
        path.join(binSrcDir, "cowork-server-x86_64-pc-windows-msvc.exe"),
        "server-bin",
      );
      await fs.writeFile(
        path.join(binSrcDir, "cowork-server-manifest.json"),
        JSON.stringify(buildSidecarManifest("win32", "x64")),
      );
      await fs.writeFile(path.join(binSrcDir, "cowork-win-sandbox.exe"), "sandbox-v1");
      await fs.writeFile(path.join(binSrcDir, "codex-windows-sandbox-setup.exe"), "setup-v1");
      await fs.writeFile(path.join(binSrcDir, "codex-command-runner.exe"), "runner-v1");
      await fs.writeFile(
        path.join(binSrcDir, "cowork-win-sandbox.sha256.json"),
        JSON.stringify({
          schemaVersion: 1,
          rustTarget: "x86_64-pc-windows-msvc",
          files: {
            "cowork-win-sandbox.exe": "stale",
            "codex-windows-sandbox-setup.exe": "stale",
            "codex-command-runner.exe": "stale",
          },
        }),
      );

      const iconsDir = path.join(tempRoot, "crates", "cowork-desktop", "packaging", "icons");
      await fs.mkdir(iconsDir, { recursive: true });
      await fs.writeFile(path.join(iconsDir, "icon.png"), "png");
      await fs.writeFile(path.join(iconsDir, "icon.ico"), "ico");

      const stagedDir = path.join(tempRoot, "staged");
      const { hasWindowsSandbox } = await stageRuntimeResources({
        root: tempRoot,
        platform: "win32",
        rustTarget: "x86_64-pc-windows-msvc",
        stagedDir,
      });
      expect(hasWindowsSandbox).toBe(true);

      const ignoredMapExists = await fs
        .stat(path.join(stagedDir, "dist", "prompts", "ignored.js.map"))
        .then(() => true)
        .catch(() => false);
      expect(ignoredMapExists).toBe(false);

      // Simulate Authenticode signing mutating the staged sandbox executables.
      const resignedContent = Buffer.from("sandbox-signed-v2");
      await fs.writeFile(
        path.join(stagedDir, "binaries", "cowork-win-sandbox.exe"),
        resignedContent,
      );
      await fs.writeFile(
        path.join(stagedDir, "windows-sandbox", "cowork-win-sandbox.exe"),
        resignedContent,
      );

      await refreshWindowsSandboxHashManifests(stagedDir);

      const expectedHash = createHash("sha256").update(resignedContent).digest("hex");
      for (const folder of ["binaries", "windows-sandbox"]) {
        const manifest = JSON.parse(
          await fs.readFile(path.join(stagedDir, folder, "cowork-win-sandbox.sha256.json"), "utf8"),
        ) as { files: Record<string, string> };
        expect(manifest.files["cowork-win-sandbox.exe"]).toBe(expectedHash);
      }

      // Reject a mismatched sidecar manifest instead of packaging stale wrong-target artifacts.
      await fs.writeFile(
        path.join(binSrcDir, "cowork-server-manifest.json"),
        JSON.stringify(buildSidecarManifest("darwin", "arm64")),
      );
      await expect(
        stageRuntimeResources({
          root: tempRoot,
          platform: "win32",
          rustTarget: "x86_64-pc-windows-msvc",
          stagedDir,
        }),
      ).rejects.toThrow(/does not match target/);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("desktop_rune_release_manifest latest.json aggregation", () => {
  test("aggregates fragments from subdirectories and validates all 6 platforms", async () => {
    const tempDir = await makeTempDir("cowork-manifest-");
    try {
      const sampleFragments: UpdaterFragment[] = [
        {
          platformKey: "macos-aarch64",
          version: "1.3.1",
          format: "app",
          fileName: "Cowork_1.3.1_aarch64.app.tar.gz",
          signature: "sig-mac-arm",
        },
        {
          platformKey: "macos-x86_64",
          version: "1.3.1",
          format: "app",
          fileName: "Cowork_1.3.1_x64.app.tar.gz",
          signature: "sig-mac-x64",
        },
        {
          platformKey: "windows-x86_64",
          version: "1.3.1",
          format: "nsis",
          fileName: "Cowork_1.3.1_x64-setup.exe",
          signature: "sig-win-x64",
        },
        {
          platformKey: "windows-aarch64",
          version: "1.3.1",
          format: "nsis",
          fileName: "Cowork_1.3.1_arm64-setup.exe",
          signature: "sig-win-arm64",
        },
        {
          platformKey: "linux-x86_64",
          version: "1.3.1",
          format: "appimage",
          fileName: "Cowork_1.3.1_x86_64.AppImage",
          signature: "sig-linux-x64",
        },
        {
          platformKey: "linux-aarch64",
          version: "1.3.1",
          format: "appimage",
          fileName: "Cowork_1.3.1_aarch64.AppImage",
          signature: "sig-linux-arm64",
        },
      ];

      for (const fragment of sampleFragments) {
        const subDir = path.join(tempDir, `desktop-rune-${fragment.platformKey}`);
        await fs.mkdir(subDir, { recursive: true });
        await fs.writeFile(
          path.join(subDir, `updater-fragment-${fragment.platformKey}.json`),
          JSON.stringify(fragment),
        );
      }

      const loaded = await readFragmentsFromDirectory(tempDir);
      expect(loaded.length).toBe(6);

      const manifest = buildLatestJsonManifest({
        version: "v1.3.1",
        tag: "desktop-rune-v1.3.1",
        pubDate: "2026-11-15T12:00:00Z",
        notes: "Cowork Rune 1.3.1",
        fragments: loaded,
      });

      expect(manifest.version).toBe("1.3.1");
      expect(manifest.notes).toBe("Cowork Rune 1.3.1");
      expect(manifest.platforms["macos-aarch64"]).toEqual({
        url: "https://github.com/mweinbach/agent-coworker/releases/download/desktop-rune-v1.3.1/Cowork_1.3.1_aarch64.app.tar.gz",
        signature: "sig-mac-arm",
        format: "app",
      });
      expect(Object.keys(manifest.platforms)).toHaveLength(6);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects version mismatches, duplicate platforms, empty signatures, and invalid URLs", () => {
    expect(normalizeSemverVersion("v1.3.1")).toBe("1.3.1");
    expect(() =>
      buildLatestJsonManifest({
        version: "1.3.1",
        tag: "desktop-rune-v1.3.1",
        pubDate: "2026-11-15T12:00:00Z",
        fragments: [
          {
            platformKey: "macos-aarch64",
            version: "1.3.2",
            format: "app",
            fileName: "Cowork_1.3.2_aarch64.app.tar.gz",
            signature: "sig",
          },
        ],
      }),
    ).toThrow(/expected 1\.3\.1/);

    expect(() =>
      buildLatestJsonManifest({
        version: "1.3.1",
        tag: "desktop-rune-v1.3.1",
        pubDate: "2026-11-15T12:00:00Z",
        fragments: [
          {
            platformKey: "macos-aarch64",
            version: "1.3.1",
            format: "app",
            fileName: "a.tar.gz",
            signature: "   ",
          },
        ],
      }),
    ).toThrow(/Empty signature/);

    expect(() =>
      validateLatestJsonManifest({
        version: "1.3.1",
        pub_date: "2026-11-15T12:00:00Z",
        platforms: {
          "macos-aarch64": {
            url: "http://insecure.example/Cowork.app.tar.gz",
            signature: "sig",
            format: "app",
          },
        },
      }),
    ).toThrow(/https:\/\//);
  });
});

function makeMachOHeader(arch: "arm64" | "x64"): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  return buf;
}

function makeInfoPlistXml(fields: {
  bundleId: string;
  bundleName: string;
  displayName: string;
  executable: string;
  version: string;
  minSystemVersion: string;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>CFBundleIdentifier</key><string>${fields.bundleId}</string>`,
    `  <key>CFBundleName</key><string>${fields.bundleName}</string>`,
    `  <key>CFBundleDisplayName</key><string>${fields.displayName}</string>`,
    `  <key>CFBundleExecutable</key><string>${fields.executable}</string>`,
    `  <key>CFBundleShortVersionString</key><string>${fields.version}</string>`,
    `  <key>LSMinimumSystemVersion</key><string>${fields.minSystemVersion}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function createSyntheticMacAppBundle(params: {
  parentDir: string;
  version: string;
  arch: "arm64" | "x64";
  executableName?: string;
  bundleId?: string;
  binaryArch?: "arm64" | "x64";
}): Promise<string> {
  const appPath = path.join(params.parentDir, "Cowork.app");
  const contentsDir = path.join(appPath, "Contents");
  const macOsDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  const executableName = params.executableName ?? "Cowork";
  const binaryArch = params.binaryArch ?? params.arch;
  const rustTarget = params.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";

  await fs.mkdir(macOsDir, { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "binaries"), { recursive: true });
  await fs.mkdir(path.join(resourcesDir, "tray"), { recursive: true });
  for (const subdir of ["prompts", "config", "skills", "workflows"]) {
    await fs.mkdir(path.join(resourcesDir, "dist", subdir), { recursive: true });
    await fs.writeFile(path.join(resourcesDir, "dist", subdir, "marker.txt"), subdir, "utf8");
  }

  await fs.writeFile(
    path.join(contentsDir, "Info.plist"),
    makeInfoPlistXml({
      bundleId: params.bundleId ?? "com.cowork.desktop",
      bundleName: "Cowork",
      displayName: "Cowork",
      executable: executableName,
      version: params.version,
      minSystemVersion: "12.0",
    }),
    "utf8",
  );

  const mainExe = path.join(macOsDir, executableName);
  await fs.writeFile(mainExe, makeMachOHeader(binaryArch));
  await fs.chmod(mainExe, 0o755);

  const sidecarName = `cowork-server-${rustTarget}`;
  const sidecarPath = path.join(resourcesDir, "binaries", sidecarName);
  await fs.writeFile(sidecarPath, makeMachOHeader(binaryArch));
  await fs.chmod(sidecarPath, 0o755);
  await fs.writeFile(
    path.join(resourcesDir, "binaries", "cowork-server-manifest.json"),
    JSON.stringify(buildSidecarManifest("darwin", params.arch)),
    "utf8",
  );
  await fs.writeFile(path.join(resourcesDir, "tray", "icon.png"), "png");

  return appPath;
}

describe("legacy macOS updater handoff (latest-mac.yml & producer checks)", () => {
  test("classifies arm64 vs x64 macOS ZIP basenames and rejects aarch64 spelling", () => {
    expect(resolveLegacyMacZipName("arm64", "v1.4.0")).toBe("Cowork_1.4.0_arm64-mac.zip");
    expect(resolveLegacyMacZipName("aarch64", "1.4.0")).toBe("Cowork_1.4.0_arm64-mac.zip");
    expect(resolveLegacyMacZipName("x64", "1.4.0")).toBe("Cowork_1.4.0_x64-mac.zip");
    expect(classifyLegacyMacZipArch("Cowork_1.4.0_arm64-mac.zip")).toBe("arm64");
    expect(classifyLegacyMacZipArch("Cowork_1.4.0_x64-mac.zip")).toBe("x64");
    expect(() => classifyLegacyMacZipArch("Cowork_1.4.0_aarch64-mac.zip")).toThrow(
      /uses "aarch64" instead of "arm64"/,
    );
    expect(() => classifyLegacyMacZipArch("Cowork 1.4.0 arm64-mac.zip")).toThrow(
      /Invalid macOS ZIP basename/,
    );
    expect(() => classifyLegacyMacZipArch("Cowork_1.4.0_arm64.dmg")).toThrow(/\.zip/);
  });

  test("generates latest-mac.yml over final bytes and matches historical electron-updater selection for arm64, Rosetta, and x64", async () => {
    const tempDir = await makeTempDir("cowork-legacy-mac-yml-");
    try {
      const armBytes = Buffer.from("signed-arm64-cowork-zip-final-bytes-v1.4.0");
      const x64Bytes = Buffer.from("signed-x64-cowork-zip-final-bytes-v1.4.0-longer");
      const armZipPath = path.join(tempDir, "Cowork_1.4.0_arm64-mac.zip");
      const x64ZipPath = path.join(tempDir, "Cowork_1.4.0_x64-mac.zip");
      await fs.writeFile(armZipPath, armBytes);
      await fs.writeFile(x64ZipPath, x64Bytes);

      const outPath = path.join(tempDir, LEGACY_MAC_CHANNEL_FILENAME);
      const { metadata, yaml } = await writeLegacyMacChannelFile({
        version: "v1.4.0",
        zipPaths: [x64ZipPath, armZipPath],
        releaseDate: "2026-11-20T12:00:00.000Z",
        requiredArches: ["arm64", "x64"],
        outPath,
      });

      const expectedArmSha512 = createHash("sha512").update(armBytes).digest("base64");
      const expectedX64Sha512 = createHash("sha512").update(x64Bytes).digest("base64");

      expect(metadata.version).toBe("1.4.0");
      expect(metadata.path).toBe("Cowork_1.4.0_arm64-mac.zip");
      expect(metadata.sha512).toBe(expectedArmSha512);
      expect(metadata.files).toEqual([
        { url: "Cowork_1.4.0_arm64-mac.zip", sha512: expectedArmSha512, size: armBytes.length },
        { url: "Cowork_1.4.0_x64-mac.zip", sha512: expectedX64Sha512, size: x64Bytes.length },
      ]);

      const reparsed = parseLegacyMacChannelYaml(yaml);
      expect(typeof reparsed.releaseDate).toBe("string");
      expect(reparsed).toEqual(metadata);

      // Historical electron-updater@6.8.9 selection matrix:
      const armSelection = selectLegacyMacZipForClient(reparsed, {
        processArch: "arm64",
        isRosetta: false,
        tag: "v1.4.0",
      });
      expect(armSelection?.fileName).toBe("Cowork_1.4.0_arm64-mac.zip");
      expect(armSelection?.entry.sha512).toBe(expectedArmSha512);
      expect(armSelection?.entry.size).toBe(armBytes.length);
      expect(armSelection?.url).toBe(
        "https://github.com/mweinbach/agent-coworker/releases/download/v1.4.0/Cowork_1.4.0_arm64-mac.zip",
      );

      const rosettaSelection = selectLegacyMacZipForClient(reparsed, {
        processArch: "x64",
        isRosetta: true,
        tag: "v1.4.0",
      });
      expect(rosettaSelection?.fileName).toBe("Cowork_1.4.0_arm64-mac.zip");

      const x64Selection = selectLegacyMacZipForClient(reparsed, {
        processArch: "x64",
        isRosetta: false,
        tag: "v1.4.0",
      });
      expect(x64Selection?.fileName).toBe("Cowork_1.4.0_x64-mac.zip");
      expect(x64Selection?.entry.sha512).toBe(expectedX64Sha512);
      expect(x64Selection?.entry.size).toBe(x64Bytes.length);

      // Single-arch arm64 channel must never offer arm64 ZIP to an Intel x64 Mac.
      const armOnly = await buildLegacyMacChannelMetadata({
        version: "1.4.0",
        zipPaths: [armZipPath],
        releaseDate: "2026-11-20T12:00:00.000Z",
      });
      expect(
        selectLegacyMacZipForClient(armOnly, {
          processArch: "x64",
          isRosetta: false,
          tag: "v1.4.0",
        }),
      ).toBeNull();

      // Enforcing requiredArches fails closed when one arch is missing.
      await expect(
        buildLegacyMacChannelMetadata({
          version: "1.4.0",
          zipPaths: [armZipPath],
          requiredArches: ["arm64", "x64"],
        }),
      ).rejects.toThrow(/Missing required macOS "x64" ZIP/);

      // Version mismatch between ZIP filename and release version fails closed.
      await expect(
        buildLegacyMacChannelMetadata({
          version: "1.5.0",
          zipPaths: [armZipPath],
        }),
      ).rejects.toThrow(/does not match expected release version "1\.5\.0"/);

      // Verify serialized YAML matches round-trip.
      expect(serializeLegacyMacChannelYaml(reparsed)).toBe(yaml);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("verifies macOS bundle identity, executable name, Mach-O arch, ZIP extraction, tar.gz hygiene, and fails closed on drift", async () => {
    const tempDir = await makeTempDir("cowork-mac-producer-");
    try {
      const outDir = path.join(tempDir, "out");
      await fs.mkdir(outDir, { recursive: true });
      const version = "1.4.0";

      const appPath = await createSyntheticMacAppBundle({
        parentDir: outDir,
        version,
        arch: "arm64",
      });

      const machOArchs = await inspectMachOArchs(path.join(appPath, "Contents", "MacOS", "Cowork"));
      expect(machOArchs).toEqual(["arm64"]);

      const zipPath = path.join(outDir, "Cowork_1.4.0_arm64-mac.zip");
      const zipCmd =
        hostPlatform() === "darwin"
          ? ["ditto", "-c", "-k", "--keepParent", "--sequesterRsrc", appPath, zipPath]
          : ["zip", "-ry", zipPath, "Cowork.app"];
      const zipProc = Bun.spawn(zipCmd, { cwd: outDir, stdout: "pipe", stderr: "pipe" });
      expect(await zipProc.exited).toBe(0);

      const tarGzPath = path.join(outDir, "Cowork_1.4.0_aarch64.app.tar.gz");
      const tarProc = Bun.spawn(["tar", "-czf", tarGzPath, "-C", outDir, "Cowork.app"], {
        cwd: outDir,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await tarProc.exited).toBe(0);

      const latestMacPath = path.join(outDir, LEGACY_MAC_CHANNEL_FILENAME);
      await writeLegacyMacChannelFile({
        version,
        zipPaths: [zipPath],
        outPath: latestMacPath,
        releaseDate: "2026-11-20T12:00:00.000Z",
      });

      const verified = await verifyMacReleaseOutputs({
        outDir,
        version,
        arch: "arm64",
        requireDmg: false,
        verifyLatestMacYmlPath: latestMacPath,
      });
      expect(verified.appBundle.bundleId).toBe("com.cowork.desktop");
      expect(verified.appBundle.executableName).toBe("Cowork");
      expect(verified.appBundle.mainExecutableArchs).toEqual(["arm64"]);
      expect(verified.zipExtractedBundle.executableName).toBe("Cowork");

      // Negative check 1: mutating the final ZIP bytes breaks latest-mac.yml digest/size check.
      await fs.appendFile(zipPath, Buffer.from("tampered-trailing-byte"));
      await expect(
        verifyMacReleaseOutputs({
          outDir,
          version,
          arch: "arm64",
          requireDmg: false,
          verifyLatestMacYmlPath: latestMacPath,
        }),
      ).rejects.toThrow(/sha512 mismatch/);

      // Negative check 2: AppleDouble entry in .app.tar.gz is rejected.
      const dirtyTarDir = path.join(tempDir, "dirty-tar");
      await fs.mkdir(path.join(dirtyTarDir, "Cowork.app", "Contents", "MacOS"), {
        recursive: true,
      });
      await fs.writeFile(path.join(dirtyTarDir, "._Cowork.app"), "appledouble");
      await fs.writeFile(
        path.join(dirtyTarDir, "Cowork.app", "Contents", "MacOS", "Cowork"),
        makeMachOHeader("arm64"),
      );
      await fs.writeFile(
        path.join(dirtyTarDir, "Cowork.app", "Contents", "Info.plist"),
        "<plist/>",
      );
      const dirtyTarPath = path.join(tempDir, "dirty.app.tar.gz");
      const dirtyTarProc = Bun.spawn(
        ["tar", "-czf", dirtyTarPath, "-C", dirtyTarDir, "._Cowork.app", "Cowork.app"],
        { cwd: dirtyTarDir, env: { ...process.env, COPYFILE_DISABLE: "1" } },
      );
      expect(await dirtyTarProc.exited).toBe(0);
      await expect(verifyMacUpdaterTarGz(dirtyTarPath)).rejects.toThrow(/AppleDouble/);

      // Negative check 3: wrong CFBundleExecutable ("cowork-desktop") is rejected.
      const wrongExeDir = path.join(tempDir, "wrong-exe");
      const wrongExeApp = await createSyntheticMacAppBundle({
        parentDir: wrongExeDir,
        version,
        arch: "arm64",
        executableName: "cowork-desktop",
      });
      await expect(
        verifyMacAppBundle({
          appPath: wrongExeApp,
          expectedVersion: version,
          expectedArch: "arm64",
        }),
      ).rejects.toThrow(/Unexpected CFBundleExecutable/);

      // Negative check 4: x64 binary packaged under arm64 target is rejected.
      const wrongArchDir = path.join(tempDir, "wrong-arch");
      const wrongArchApp = await createSyntheticMacAppBundle({
        parentDir: wrongArchDir,
        version,
        arch: "arm64",
        binaryArch: "x64",
      });
      await expect(
        verifyMacAppBundle({
          appPath: wrongArchApp,
          expectedVersion: version,
          expectedArch: "arm64",
        }),
      ).rejects.toThrow(/Mach-O arch \[x64\], expected \[arm64\]/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("desktop-rune-release workflow enforces macOS signing/notarization gates and publishes both latest.json and latest-mac.yml", async () => {
    const workflow = await fs.readFile(
      path.join(repoRoot, ".github", "workflows", "desktop-rune-release.yml"),
      "utf8",
    );

    // Must not swallow macOS notarization or Gatekeeper failures.
    expect(workflow).not.toContain('xcrun stapler validate "$app_path" || true');
    expect(workflow).not.toContain('xcrun stapler validate "$dmg_path" || true');
    expect(workflow).not.toContain('spctl --assess --type exec --verbose=4 "$app_path" || true');

    // Must verify the arm64/x64 macOS ZIP (not aarch64-mac.zip) and enforce signing/notarization on required releases.
    expect(workflow).toContain(
      'zip_path="$out_dir/Cowork_${EXPECTED_VERSION}_${ZIP_ARCH}-mac.zip"',
    );
    expect(workflow).toContain("bun scripts/legacy_mac_updater.ts");
    expect(workflow).toContain('verify_args+=("--require-signed" "--require-notarized")');

    // Release job must publish BOTH Rune's native latest.json AND legacy latest-mac.yml over final bytes.
    expect(workflow).toContain("--out release-upload/latest.json");
    expect(workflow).toContain('"--out" "release-upload/latest-mac.yml"');
    expect(workflow).toContain('mac_args+=("--require-arches" "arm64,x64")');
  });
});
