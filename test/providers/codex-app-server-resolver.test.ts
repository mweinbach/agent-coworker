import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../src/platform/sandbox/policy";
import {
  __internal,
  CODEX_APP_SERVER_MANAGED_VERSION,
  getCodexAppServerInstallStatus,
  resolveCodexAppServerCommand,
  updateManagedCodexAppServer,
} from "../../src/providers/codexAppServerResolver";
import { execFileCompat } from "../../src/utils/execFileCompat";

function testTempRoot(): string {
  const root = scratchRoots()[0];
  if (!root) throw new Error("No platform scratch root is available for tests");
  return root;
}

// fakeReleaseFetch serves the literal bytes "managed app-server" for app-server
// downloads, "managed code-mode host" for codex-code-mode-host downloads, and
// "managed command runner" / "managed sandbox setup" for the Windows sandbox
// helper companions. The resolver now verifies downloaded assets against a
// pinned SHA-256, so the install plumbing tests inject the matching checksum
// via the expectedChecksums override (production verifies against the
// repo-pinned map instead).
const FAKE_ASSET_SHA256 = createHash("sha256").update("managed app-server").digest("hex");
const FAKE_HOST_ASSET_SHA256 = createHash("sha256").update("managed code-mode host").digest("hex");
const FAKE_RUNNER_ASSET_SHA256 = createHash("sha256")
  .update("managed command runner")
  .digest("hex");
const FAKE_SETUP_ASSET_SHA256 = createHash("sha256").update("managed sandbox setup").digest("hex");
const FAKE_ASSET_CHECKSUMS: Record<string, string> = {
  "codex-app-server-x86_64-pc-windows-msvc.exe": FAKE_ASSET_SHA256,
  "codex-app-server-aarch64-pc-windows-msvc.exe": FAKE_ASSET_SHA256,
  "codex-app-server-x86_64-apple-darwin.tar.gz": FAKE_ASSET_SHA256,
  "codex-app-server-aarch64-apple-darwin.tar.gz": FAKE_ASSET_SHA256,
  "codex-code-mode-host-x86_64-pc-windows-msvc.exe": FAKE_HOST_ASSET_SHA256,
  "codex-code-mode-host-aarch64-pc-windows-msvc.exe": FAKE_HOST_ASSET_SHA256,
  "codex-command-runner-x86_64-pc-windows-msvc.exe": FAKE_RUNNER_ASSET_SHA256,
  "codex-command-runner-aarch64-pc-windows-msvc.exe": FAKE_RUNNER_ASSET_SHA256,
  "codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe": FAKE_SETUP_ASSET_SHA256,
  "codex-windows-sandbox-setup-aarch64-pc-windows-msvc.exe": FAKE_SETUP_ASSET_SHA256,
};

const previousCommand = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
const previousArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;
const previousPathExt = process.env.PATHEXT;
const previousNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (previousCommand === undefined) delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
  else process.env.COWORK_CODEX_APP_SERVER_COMMAND = previousCommand;
  if (previousArgs === undefined) delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
  else process.env.COWORK_CODEX_APP_SERVER_ARGS = previousArgs;
  if (previousPathExt === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = previousPathExt;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

function fakeReleaseFetch(
  defaultVersion = CODEX_APP_SERVER_MANAGED_VERSION,
  requestedVersions?: string[],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/releases/")) {
      const tagPrefix = "/releases/tags/rust-v";
      const releaseVersion = url.includes(tagPrefix)
        ? decodeURIComponent(url.slice(url.lastIndexOf(tagPrefix) + tagPrefix.length))
        : defaultVersion;
      requestedVersions?.push(releaseVersion);
      return new Response(
        JSON.stringify({
          tag_name: `rust-v${releaseVersion}`,
          assets: [
            {
              name: "codex-app-server-x86_64-pc-windows-msvc.exe",
              browser_download_url: "https://example.test/codex-app-server.exe",
            },
            {
              name: "codex-app-server-aarch64-apple-darwin.tar.gz",
              browser_download_url: "https://example.test/codex-app-server.tar.gz",
            },
            {
              name: "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
              browser_download_url: "https://example.test/codex-code-mode-host.exe",
            },
            {
              name: "codex-command-runner-x86_64-pc-windows-msvc.exe",
              browser_download_url: "https://example.test/codex-command-runner.exe",
            },
            {
              name: "codex-windows-sandbox-setup-x86_64-pc-windows-msvc.exe",
              browser_download_url: "https://example.test/codex-windows-sandbox-setup.exe",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("code-mode-host")) {
      return new Response("managed code-mode host", { status: 200 });
    }
    if (url.includes("command-runner")) {
      return new Response("managed command runner", { status: 200 });
    }
    if (url.includes("sandbox-setup")) {
      return new Response("managed sandbox setup", { status: 200 });
    }
    return new Response("managed app-server", { status: 200 });
  }) as typeof fetch;
}

async function createFakeCodexBin(prefix: string, name = "codex"): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(testTempRoot(), prefix));
  const codexPath = path.join(binDir, name);
  await fs.writeFile(codexPath, "#!/bin/sh\n", "utf8");
  await fs.chmod(codexPath, 0o755);
  return binDir;
}

describe("codex app-server resolver", () => {
  test("pins the stable release and all supported asset digests", () => {
    expect(CODEX_APP_SERVER_MANAGED_VERSION).toBe("0.153.4");
    const expected = {
      "darwin-arm64": [
        "codex-app-server-aarch64-apple-darwin.tar.gz",
        "1c68b24d3191fb7d5f57e1c15472fd87a5aa06c18160dd0430b21f10c6abe7f6",
      ],
      "darwin-x64": [
        "codex-app-server-x86_64-apple-darwin.tar.gz",
        "1c7bcc3037d204305a81976227153250b58e546109b882649fee5420a14b7591",
      ],
      "linux-arm64": [
        "codex-app-server-aarch64-unknown-linux-musl.tar.gz",
        "d2a3d0882f6eb4ddb84dfe1c90c5113dfbe32301f718706da0acd276770d3c75",
      ],
      "linux-x64": [
        "codex-app-server-x86_64-unknown-linux-musl.tar.gz",
        "ace0e794c53d0c1abe2fdb9248684904d04b08aca5a7851bc4a7ce0887773cf0",
      ],
      "win32-arm64": [
        "codex-app-server-aarch64-pc-windows-msvc.exe",
        "72330131615da05d12e2c35eb9f25e9054255a1c8e0b7da2f9c106726b288c50",
      ],
      "win32-x64": [
        "codex-app-server-x86_64-pc-windows-msvc.exe",
        "b6c2be1fe2c6a5256cfb34fa07832b4c5bb06de11226074487961427401ccf51",
      ],
    } as const;

    for (const [targetKey, [assetName, digest]] of Object.entries(expected)) {
      const [platform, arch] = targetKey.split("-") as [NodeJS.Platform, string];
      expect(__internal.resolveCodexAppServerAssetName({ platform, arch })).toBe(assetName);
      expect(__internal.expectedCodexAssetChecksum("0.153.4", assetName, {})).toBe(digest);
    }

    const expectedHosts = {
      "darwin-arm64": [
        "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
        "45a9b0fdf53b98b85a6bb91e175dd90e961328a7a14fb50a40902205199df1df",
      ],
      "darwin-x64": [
        "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
        "2ffaebd0103d976232c358419a508859da862e128f3ca0bb071541346fbe3bf7",
      ],
      "linux-arm64": [
        "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
        "d8047b8d33370d6090e729d27eb76de60a2686baa1c143c138c9b05dc70d813b",
      ],
      "linux-x64": [
        "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
        "f95830a869590957664bbfc67bccb08773806b693670baf15908176f89b4cd31",
      ],
      "win32-arm64": [
        "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
        "5143bbc28a1cddbfc9d51327159e4df6f2f8ceff1faa20359ba7d83226033e0f",
      ],
      "win32-x64": [
        "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
        "deaebc21f354f151fcebeac46e12c6e8c4ef75ee448e25e3577502074e04b8d9",
      ],
    } as const;

    for (const [targetKey, [assetName, digest]] of Object.entries(expectedHosts)) {
      const [platform, arch] = targetKey.split("-") as [NodeJS.Platform, string];
      expect(__internal.resolveCodeModeHostAssetName({ platform, arch })).toBe(assetName);
      expect(__internal.expectedCodexAssetChecksum("0.153.4", assetName, {})).toBe(digest);
    }

    // The managed app-server must ship its Windows sandbox helpers (pinned,
    // version-matched) so it never resolves foreign helpers via PATH.
    expect(__internal.codexCompanionBinaries).toEqual([
      { basename: "codex-code-mode-host" },
      { basename: "codex-command-runner", platforms: ["win32"] },
      { basename: "codex-windows-sandbox-setup", platforms: ["win32"] },
    ]);
    const expectedWindowsSandboxHelpers = {
      "win32-arm64": {
        "codex-command-runner": "b099955cf2061c81b6a24269695f55a406a3e26c53ad93f72a4799e11b189bc5",
        "codex-windows-sandbox-setup":
          "a591077bbee7095158c2728618850e14572231267f463c04fcf29fd0735fade9",
      },
      "win32-x64": {
        "codex-command-runner": "3eb267dc1f0d1d80efeacc26a211f26ed0f414466d32a2aa7304a8a0beec170c",
        "codex-windows-sandbox-setup":
          "0c3eeb7cee8d2bc4c8644def3c818e8b06760979572dcedc919c38d0f38f64c4",
      },
    } as const;
    for (const [targetKey, companions] of Object.entries(expectedWindowsSandboxHelpers)) {
      const [platform, arch] = targetKey.split("-") as [NodeJS.Platform, string];
      const triple = `${arch === "x64" ? "x86_64" : "aarch64"}-pc-windows-msvc`;
      for (const [basename, digest] of Object.entries(companions)) {
        const assetName = __internal.resolveCompanionAssetName(basename, { platform, arch });
        expect(assetName).toBe(`${basename}-${triple}.exe`);
        expect(__internal.expectedCodexAssetChecksum("0.153.4", assetName, {})).toBe(digest);
      }
    }
  });

  test.serial(
    "uses explicit command overrides without adding implicit app-server args",
    async () => {
      process.env.NODE_ENV = "test";
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = "/tmp/custom-codex-app-server";
      process.env.COWORK_CODEX_APP_SERVER_ARGS = "";

      const command = await resolveCodexAppServerCommand({
        spawnForResult: async () => ({ ok: false, stdout: "", stderr: "" }),
      });

      expect(command).toEqual({
        command: "/tmp/custom-codex-app-server",
        args: [],
        source: "override",
      });
    },
  );

  test.serial("production resolution ignores explicit command overrides", async () => {
    process.env.NODE_ENV = "production";
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = "/tmp/custom-codex-app-server";
    process.env.COWORK_CODEX_APP_SERVER_ARGS = "";
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-prod-ignore-"));
    const requestedVersions: string[] = [];

    const command = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch("9.999.0", requestedVersions),
      expectedChecksums: FAKE_ASSET_CHECKSUMS,
      spawnForResult: async () => {
        throw new Error("system codex should not be probed for production app-server resolution");
      },
    });

    expect(command.source).toBe("managed");
    expect(command.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
    expect(command.args).toEqual([]);
    expect(command.command).toContain(path.join("versions", CODEX_APP_SERVER_MANAGED_VERSION));
    expect(requestedVersions).toEqual([CODEX_APP_SERVER_MANAGED_VERSION]);
  });

  test.serial("downloads the app-pinned managed app-server version", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-pinned-download-"));
    const requestedVersions: string[] = [];

    const command = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch("9.999.0", requestedVersions),
      expectedChecksums: FAKE_ASSET_CHECKSUMS,
      spawnForResult: async () => {
        throw new Error("system codex should not be probed for the app-pinned install");
      },
    });

    expect(command.source).toBe("managed");
    expect(command.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
    expect(command.command).toContain(path.join("versions", CODEX_APP_SERVER_MANAGED_VERSION));
    expect(requestedVersions).toEqual([CODEX_APP_SERVER_MANAGED_VERSION]);
  });

  test.serial("ignores other managed versions and downloads the app-pinned version", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-ignore-managed-"));
    for (const version of ["0.135.0", "0.999.0"]) {
      await __internal.installCodexAppServer(
        { version },
        {
          homeDir,
          platform: "win32",
          arch: "x64",
          fetchImpl: fakeReleaseFetch(version),
          expectedChecksums: FAKE_ASSET_CHECKSUMS,
        },
      );
    }

    const command = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch("9.999.0"),
      expectedChecksums: FAKE_ASSET_CHECKSUMS,
      spawnForResult: async () => {
        throw new Error("system codex should not be probed for the app-pinned install");
      },
    });

    expect(command.source).toBe("managed");
    expect(command.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
    expect(command.command).toContain(path.join("versions", CODEX_APP_SERVER_MANAGED_VERSION));
  });

  test.serial("does not fall back to system codex when managed download fails", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-no-system-fallback-"));
    const binDir = await createFakeCodexBin("cowork-codex-no-system-fallback-bin-");

    await expect(
      resolveCodexAppServerCommand({
        homeDir,
        pathEnv: binDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: async () => {
          throw new Error("managed install unavailable");
        },
        spawnForResult: async () => {
          throw new Error("system codex should not be probed when pinned download fails");
        },
      }),
    ).rejects.toThrow("managed install unavailable");
  });

  test.serial(
    "status reports the missing app-pinned version without probing system codex",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-status-pin-"));

      const status = await getCodexAppServerInstallStatus(
        { checkLatest: true },
        {
          homeDir,
          pathEnv: await createFakeCodexBin("cowork-codex-status-pin-bin-"),
          fetchImpl: async () => {
            throw new Error("latest release should not be checked for app-pinned status");
          },
          spawnForResult: async () => {
            throw new Error(
              "system codex should not be probed while app-pinned install is missing",
            );
          },
        },
      );

      expect(status).toEqual({
        available: false,
        source: "missing",
        pinnedVersion: CODEX_APP_SERVER_MANAGED_VERSION,
        pinMatchesCurrent: false,
        message: `Cowork-managed Codex runtime ${CODEX_APP_SERVER_MANAGED_VERSION} has not been downloaded yet. Account sign-in can still be connected; Cowork will download the runtime before first Codex turn.`,
      });
    },
  );

  test.serial(
    "status reports the installed app-pinned version without update metadata",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-status-installed-"));
      await updateManagedCodexAppServer(
        {},
        {
          homeDir,
          platform: "win32",
          arch: "x64",
          fetchImpl: fakeReleaseFetch("9.999.0"),
          expectedChecksums: FAKE_ASSET_CHECKSUMS,
        },
      );

      const status = await getCodexAppServerInstallStatus(
        { checkLatest: true },
        {
          homeDir,
          platform: "win32",
          arch: "x64",
          fetchImpl: async () => {
            throw new Error("latest release should not be checked for app-pinned status");
          },
        },
      );

      expect(status).toMatchObject({
        available: true,
        source: "managed",
        version: CODEX_APP_SERVER_MANAGED_VERSION,
        pinnedVersion: CODEX_APP_SERVER_MANAGED_VERSION,
        pinMatchesCurrent: true,
        message: `Using Cowork-managed Codex runtime ${CODEX_APP_SERVER_MANAGED_VERSION}.`,
      });
      expect("latestVersion" in status).toBe(false);
      expect("updateAvailable" in status).toBe(false);
    },
  );

  test.serial("update installs only the app-pinned managed app-server", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-update-pinned-"));
    const requestedVersions: string[] = [];

    const status = await updateManagedCodexAppServer(
      {},
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeReleaseFetch("9.999.0", requestedVersions),
        expectedChecksums: FAKE_ASSET_CHECKSUMS,
      },
    );

    expect(status).toMatchObject({
      source: "managed",
      version: CODEX_APP_SERVER_MANAGED_VERSION,
      pinnedVersion: CODEX_APP_SERVER_MANAGED_VERSION,
      pinMatchesCurrent: true,
      message: `Installed Cowork-managed Codex runtime ${CODEX_APP_SERVER_MANAGED_VERSION}.`,
    });
    expect(status.command).toContain(path.join(".cowork", "codex-app-server", "versions"));
    expect(requestedVersions).toEqual([CODEX_APP_SERVER_MANAGED_VERSION]);
  });

  test.serial(
    "returns the promoted current path for app-pinned managed installs on darwin",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-darwin-current-"));
      const target = { platform: "darwin" as const, arch: "arm64" };
      const versionedPath = __internal.managedExecutablePath(
        homeDir,
        CODEX_APP_SERVER_MANAGED_VERSION,
        target,
      );
      const currentPath = __internal.managedCurrentPath(homeDir, target);
      let promotedFrom: string | undefined;

      await fs.mkdir(path.dirname(versionedPath), { recursive: true });
      await fs.writeFile(versionedPath, "managed app-server", "utf8");
      await fs.writeFile(
        `${versionedPath}.version`,
        `${CODEX_APP_SERVER_MANAGED_VERSION}\n`,
        "utf8",
      );

      const status = await updateManagedCodexAppServer(
        {},
        {
          homeDir,
          platform: "darwin",
          arch: "arm64",
          fetchImpl: fakeReleaseFetch(CODEX_APP_SERVER_MANAGED_VERSION),
          promoteManagedInstall: async (executablePath, promotedPath, version) => {
            promotedFrom = executablePath;
            await fs.mkdir(path.dirname(promotedPath), { recursive: true });
            await fs.copyFile(executablePath, promotedPath);
            await fs.writeFile(`${promotedPath}.version`, `${version}\n`, "utf8");
          },
        },
      );

      expect(promotedFrom).toBe(versionedPath);
      expect(status).toMatchObject({
        source: "managed",
        version: CODEX_APP_SERVER_MANAGED_VERSION,
        command: currentPath,
        managedPath: currentPath,
      });
      expect(await fs.readFile(currentPath, "utf8")).toBe("managed app-server");

      const managed = await resolveCodexAppServerCommand({
        homeDir,
        platform: "darwin",
        arch: "arm64",
        // The install is missing its code-mode host, so resolution attempts a
        // best-effort repair; fail that fetch deterministically instead of
        // letting the test reach the real GitHub API.
        fetchImpl: async () => {
          throw new Error("code-mode host repair fetch is not under test");
        },
      });
      expect(managed).toEqual({
        command: currentPath,
        args: [],
        source: "managed",
        version: CODEX_APP_SERVER_MANAGED_VERSION,
      });
    },
  );

  test.serial("keeps Windows update usable when current promotion is locked", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-locked-current-"));
    let attemptedPromotion = false;

    const status = await updateManagedCodexAppServer(
      {},
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeReleaseFetch(CODEX_APP_SERVER_MANAGED_VERSION),
        expectedChecksums: FAKE_ASSET_CHECKSUMS,
        promoteManagedInstall: async () => {
          attemptedPromotion = true;
          const error = new Error("current executable is locked") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      },
    );

    const statusCommand = status.command ?? "";
    expect(attemptedPromotion).toBe(true);
    expect(status).toMatchObject({
      source: "managed",
      version: CODEX_APP_SERVER_MANAGED_VERSION,
      command: expect.stringContaining(path.join(".cowork", "codex-app-server", "versions")),
    });
    expect(await fs.readFile(statusCommand, "utf8")).toBe("managed app-server");

    const managed = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
    });
    expect(managed.command).toBe(statusCommand);
    expect(managed.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
  });

  test.each(["darwin", "linux", "win32"] as const)(
    "resolves an installed %s runtime concurrently without losing promotion files",
    async (platform) => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-promotion-race-"));
      const target = { platform, arch: "x64" };
      const version = CODEX_APP_SERVER_MANAGED_VERSION;
      const versionedPath = __internal.managedExecutablePath(homeDir, version, target);
      const currentPath = __internal.managedCurrentPath(homeDir, target);
      const companions = __internal.codexCompanionBinaries.filter(
        (companion) => !companion.platforms || companion.platforms.includes(platform),
      );
      try {
        await fs.mkdir(path.dirname(versionedPath), { recursive: true });
        await fs.writeFile(versionedPath, "installed app-server", "utf8");
        await fs.writeFile(`${versionedPath}.version`, `${version}\n`, "utf8");
        for (const companion of companions) {
          await fs.writeFile(
            __internal.companionSiblingPath(versionedPath, companion.basename, target),
            `installed ${companion.basename}`,
            "utf8",
          );
        }

        const resolutions = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            __internal.resolvePinnedManagedCommand(version, {
              homeDir,
              ...target,
              fetchImpl: async () => {
                throw new Error("An installed runtime must not require a download");
              },
            }),
          ),
        );

        expect(resolutions.filter((result) => result.status === "rejected")).toEqual([]);
        for (const result of resolutions) {
          if (result.status !== "fulfilled") continue;
          expect(result.value).toEqual({
            command: platform === "win32" ? versionedPath : currentPath,
            args: [],
            source: "managed",
            version,
          });
        }
        expect(await fs.readFile(currentPath, "utf8")).toBe("installed app-server");
        expect(await fs.readFile(`${currentPath}.version`, "utf8")).toBe(`${version}\n`);
        for (const companion of companions) {
          expect(
            await fs.readFile(
              __internal.companionSiblingPath(currentPath, companion.basename, target),
              "utf8",
            ),
          ).toBe(`installed ${companion.basename}`);
        }
      } finally {
        await fs.rm(homeDir, { recursive: true, force: true });
      }
    },
  );

  test.serial("system helper skips repo-local node_modules codex binaries", async () => {
    const rootDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-shadow-root-"));
    const localBinDir = path.join(rootDir, "node_modules", ".bin");
    const systemBinDir = path.join(rootDir, "system-bin");
    await fs.mkdir(localBinDir, { recursive: true });
    await fs.mkdir(systemBinDir, { recursive: true });
    const staleCodexPath = path.join(localBinDir, "codex");
    const systemCodexPath = path.join(systemBinDir, "codex");
    await fs.writeFile(staleCodexPath, "#!/bin/sh\n", "utf8");
    await fs.writeFile(systemCodexPath, "#!/bin/sh\n", "utf8");
    await fs.chmod(staleCodexPath, 0o755);
    await fs.chmod(systemCodexPath, 0o755);
    const probedCalls: string[] = [];

    const command = await __internal.resolveSystemCommand({
      pathEnv: [localBinDir, systemBinDir].join(path.delimiter),
      spawnForResult: async (cmd, args) => {
        probedCalls.push([cmd, ...args].join(" "));
        if (cmd === staleCodexPath) return { ok: true, stdout: "codex-cli 0.87.0\n", stderr: "" };
        if (cmd === systemCodexPath) return { ok: true, stdout: "codex-cli 0.128.0\n", stderr: "" };
        return { ok: false, stdout: "", stderr: "" };
      },
    });

    expect(probedCalls).toEqual([
      `${systemCodexPath} --version`,
      `${systemCodexPath} app-server --help`,
    ]);
    expect(command).toEqual({
      command: systemCodexPath,
      args: ["app-server"],
      source: "system",
      version: "0.128.0",
    });
  });

  test.serial("system helper discovers codex.cmd on Windows PATH", async () => {
    const binDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-win-path-bin-"));
    const codexCmdPath = path.join(binDir, "codex.cmd");
    const probedCalls: string[] = [];
    process.env.PATHEXT = ".CMD;.EXE";

    await fs.writeFile(codexCmdPath, "@echo off\n", "utf8");

    const command = await __internal.resolveSystemCommand({
      pathEnv: binDir,
      platform: "win32",
      arch: "x64",
      spawnForResult: async (cmd, args) => {
        probedCalls.push([cmd, ...args].join(" "));
        return { ok: true, stdout: "codex-cli 0.129.0\n", stderr: "" };
      },
    });

    expect(probedCalls).toEqual([`${codexCmdPath} --version`, `${codexCmdPath} app-server --help`]);
    expect(command).toEqual({
      command: codexCmdPath,
      args: ["app-server"],
      source: "system",
      version: "0.129.0",
    });
  });

  test.serial("parses Codex CLI version strings", () => {
    expect(__internal.parseCodexVersion("codex-cli 0.128.0")).toBe("0.128.0");
    expect(__internal.parseCodexVersion("0.129.1")).toBe("0.129.1");
  });

  test.serial("compares versions correctly including pre-releases", () => {
    expect(__internal.compareVersions("1.0.0", "1.0.0-beta")).toBe(1);
    expect(__internal.compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(__internal.compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(__internal.compareVersions("2.0.0", "1.0.0")).toBe(1);
  });

  test.serial("handles overridden quoted arguments containing spaces", async () => {
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = "/tmp/custom-codex-app-server";
    process.env.COWORK_CODEX_APP_SERVER_ARGS = `--config "/path/with spaces/config.json" --option value`;

    const command = await resolveCodexAppServerCommand({
      spawnForResult: async () => ({ ok: false, stdout: "", stderr: "" }),
    });

    expect(command).toEqual({
      command: "/tmp/custom-codex-app-server",
      args: ["--config", "/path/with spaces/config.json", "--option", "value"],
      source: "override",
    });
  });

  test.serial("handles overridden JSON array arguments", async () => {
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = "/tmp/custom-codex-app-server";
    process.env.COWORK_CODEX_APP_SERVER_ARGS = `["--config", "/path/with spaces/config.json"]`;

    const command = await resolveCodexAppServerCommand({
      spawnForResult: async () => ({ ok: false, stdout: "", stderr: "" }),
    });

    expect(command).toEqual({
      command: "/tmp/custom-codex-app-server",
      args: ["--config", "/path/with spaces/config.json"],
      source: "override",
    });
  });

  test.serial("installs the code-mode host companion next to the app-server", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-host-install-"));
    const target = { platform: "win32" as const, arch: "x64" };

    const command = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch(CODEX_APP_SERVER_MANAGED_VERSION),
      expectedChecksums: FAKE_ASSET_CHECKSUMS,
    });

    const versionedHostPath = __internal.codeModeHostSiblingPath(command.command, target);
    expect(path.basename(versionedHostPath)).toBe("codex-code-mode-host.exe");
    expect(await fs.readFile(versionedHostPath, "utf8")).toBe("managed code-mode host");

    // The promoted current install must carry the host too: non-Windows
    // platforms spawn the app-server from the current path.
    const currentHostPath = __internal.codeModeHostSiblingPath(
      __internal.managedCurrentPath(homeDir, target),
      target,
    );
    expect(await fs.readFile(currentHostPath, "utf8")).toBe("managed code-mode host");
  });

  test.serial("installs the Windows sandbox helper companions next to the app-server", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-sbx-helpers-"));
    const target = { platform: "win32" as const, arch: "x64" };

    const command = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch(CODEX_APP_SERVER_MANAGED_VERSION),
      expectedChecksums: FAKE_ASSET_CHECKSUMS,
    });

    // The app-server resolves helpers sibling-first; the versioned spawn path
    // must carry both, so no PATH fallback can pick up a foreign helper.
    for (const [basename, bytes] of [
      ["codex-command-runner", "managed command runner"],
      ["codex-windows-sandbox-setup", "managed sandbox setup"],
    ] as const) {
      const versionedPath = __internal.companionSiblingPath(command.command, basename, target);
      expect(path.basename(versionedPath)).toBe(`${basename}.exe`);
      expect(await fs.readFile(versionedPath, "utf8")).toBe(bytes);

      const currentPath = __internal.companionSiblingPath(
        __internal.managedCurrentPath(homeDir, target),
        basename,
        target,
      );
      expect(await fs.readFile(currentPath, "utf8")).toBe(bytes);
    }
  });

  test.serial("skips Windows-only sandbox helpers on non-Windows installs", async () => {
    // Platform gating is table-driven: non-win32 targets only ever resolve the
    // code-mode host companion, so no Windows helper asset is ever downloaded.
    const { codexCompanionBinaries } = __internal;
    const nonWindowsTargets = [
      { platform: "darwin" as const, arch: "arm64" },
      { platform: "linux" as const, arch: "x64" },
    ];
    for (const target of nonWindowsTargets) {
      const applicable = codexCompanionBinaries.filter(
        (companion) => !companion.platforms || companion.platforms.includes(target.platform),
      );
      expect(applicable).toEqual([{ basename: "codex-code-mode-host" }]);
    }
  });

  test.serial(
    "repairs an existing managed install that is missing the code-mode host",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-host-repair-"));
      const target = { platform: "win32" as const, arch: "x64" };
      const versionedPath = __internal.managedExecutablePath(
        homeDir,
        CODEX_APP_SERVER_MANAGED_VERSION,
        target,
      );
      await fs.mkdir(path.dirname(versionedPath), { recursive: true });
      await fs.writeFile(versionedPath, "managed app-server", "utf8");
      await fs.writeFile(
        `${versionedPath}.version`,
        `${CODEX_APP_SERVER_MANAGED_VERSION}\n`,
        "utf8",
      );

      const command = await resolveCodexAppServerCommand({
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeReleaseFetch(CODEX_APP_SERVER_MANAGED_VERSION),
        expectedChecksums: FAKE_ASSET_CHECKSUMS,
      });

      expect(command.command).toBe(versionedPath);
      const hostPath = __internal.codeModeHostSiblingPath(versionedPath, target);
      expect(await fs.readFile(hostPath, "utf8")).toBe("managed code-mode host");
      // The same repair backfills the Windows sandbox helper companions the
      // app-server needs next to itself for sandboxed execution.
      for (const [basename, bytes] of [
        ["codex-command-runner", "managed command runner"],
        ["codex-windows-sandbox-setup", "managed sandbox setup"],
      ] as const) {
        expect(
          await fs.readFile(
            __internal.companionSiblingPath(versionedPath, basename, target),
            "utf8",
          ),
        ).toBe(bytes);
      }
    },
  );

  test.serial(
    "falls back to the installed app-server when the code-mode host repair fails",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-host-fallback-"));
      const target = { platform: "win32" as const, arch: "x64" };
      const versionedPath = __internal.managedExecutablePath(
        homeDir,
        CODEX_APP_SERVER_MANAGED_VERSION,
        target,
      );
      await fs.mkdir(path.dirname(versionedPath), { recursive: true });
      await fs.writeFile(versionedPath, "managed app-server", "utf8");
      await fs.writeFile(
        `${versionedPath}.version`,
        `${CODEX_APP_SERVER_MANAGED_VERSION}\n`,
        "utf8",
      );

      const command = await resolveCodexAppServerCommand({
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: async () => {
          throw new Error("release metadata unavailable");
        },
      });

      expect(command.command).toBe(versionedPath);
      expect(command.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
      const hostPath = __internal.codeModeHostSiblingPath(versionedPath, target);
      await expect(fs.access(hostPath)).rejects.toThrow();
    },
  );

  test.serial(
    "rejects an install whose code-mode host bytes fail checksum verification",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-host-bad-sum-"));
      const target = { platform: "win32" as const, arch: "x64" };

      await expect(
        __internal.installCodexAppServer(
          { version: CODEX_APP_SERVER_MANAGED_VERSION },
          {
            homeDir,
            platform: "win32",
            arch: "x64",
            fetchImpl: fakeReleaseFetch(CODEX_APP_SERVER_MANAGED_VERSION),
            expectedChecksums: {
              ...FAKE_ASSET_CHECKSUMS,
              "codex-code-mode-host-x86_64-pc-windows-msvc.exe": "0".repeat(64),
            },
          },
        ),
      ).rejects.toThrow(/checksum verification/i);

      // Neither binary may land: the host installs first so a failed install
      // never leaves a resolvable app-server without its companion.
      const executablePath = __internal.managedExecutablePath(
        homeDir,
        CODEX_APP_SERVER_MANAGED_VERSION,
        target,
      );
      await expect(fs.access(executablePath)).rejects.toThrow();
      await expect(
        fs.access(__internal.codeModeHostSiblingPath(executablePath, target)),
      ).rejects.toThrow();
    },
  );

  test.serial(
    "rejects a managed install whose downloaded bytes fail checksum verification",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-bad-checksum-"));
      const target = { platform: "win32" as const, arch: "x64" };

      // No expectedChecksums override -> verified against the real repo-pinned
      // checksum for the managed version, which the fake "managed app-server" bytes
      // do not match, so the install must fail closed.
      await expect(
        __internal.installCodexAppServer(
          { version: CODEX_APP_SERVER_MANAGED_VERSION },
          {
            homeDir,
            platform: "win32",
            arch: "x64",
            fetchImpl: fakeReleaseFetch(CODEX_APP_SERVER_MANAGED_VERSION),
          },
        ),
      ).rejects.toThrow(/checksum verification/i);

      // The unverified binary must never be promoted to the managed executable path.
      const executablePath = __internal.managedExecutablePath(
        homeDir,
        CODEX_APP_SERVER_MANAGED_VERSION,
        target,
      );
      await expect(fs.access(executablePath)).rejects.toThrow();
    },
  );

  test.serial("refuses to install a managed version with no pinned checksum", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-unpinned-version-"));

    await expect(
      __internal.installCodexAppServer(
        { version: "0.135.0" },
        {
          homeDir,
          platform: "win32",
          arch: "x64",
          fetchImpl: fakeReleaseFetch("0.135.0"),
        },
      ),
    ).rejects.toThrow(/no pinned SHA-256 checksum/i);

    const executablePath = __internal.managedExecutablePath(homeDir, "0.135.0", {
      platform: "win32",
      arch: "x64",
    });
    await expect(fs.access(executablePath)).rejects.toThrow();
  });
});

describe("bounded Codex artifact downloads", () => {
  test("streams with backpressure, accepts the exact byte limit, and sends no auth", async () => {
    const root = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-stream-"));
    const dest = path.join(root, "asset");
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (pulls > 0) expect(await fs.readFile(dest, "utf8")).toBe("ab".repeat(pulls));
            if (pulls++ === 3) controller.close();
            else controller.enqueue(new TextEncoder().encode("ab"));
          },
        },
        { highWaterMark: 0 },
      ),
    );
    response.arrayBuffer = async () => {
      throw new Error("Must not buffer the whole asset");
    };
    try {
      await __internal.downloadFile("https://example.test/asset", dest, {
        maxDownloadBytes: 6,
        fetchImpl: (async (_input, init) => {
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return response;
        }) as typeof fetch,
      });
      expect(await fs.readFile(dest, "utf8")).toBe("ababab");
      expect(pulls).toBe(4);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.each(["declared", "chunked", "underreported"] as const)(
    "rejects %s oversized artifacts and removes partial files",
    async (kind) => {
      const root = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-size-"));
      const dest = path.join(root, "asset");
      let cancelled = false;
      let pulls = 0;
      let requestSignal: AbortSignal | null | undefined;
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(3));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers:
            kind === "chunked" ? {} : { "content-length": kind === "declared" ? "100" : "1" },
        },
      );
      try {
        await expect(
          __internal.downloadFile("https://example.test/asset", dest, {
            maxDownloadBytes: 4,
            fetchImpl: (async (_input, init) => {
              requestSignal = init?.signal;
              return response;
            }) as typeof fetch,
          }),
        ).rejects.toThrow("4-byte limit");
        expect(cancelled).toBe(true);
        expect(requestSignal?.aborted).toBe(true);
        expect(pulls).toBe(kind === "declared" ? 0 : 2);
        await expect(fs.access(dest)).rejects.toThrow();
        expect(response.body?.locked).toBe(false);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["headers", "body"] as const)(
    "times out stalled %s even when the transport ignores abort",
    async (phase) => {
      const root = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-timeout-"));
      const dest = path.join(root, "asset");
      let cancelled = false;
      let requestSignal: AbortSignal | null | undefined;
      let resolveHeaders!: (response: Response) => void;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
            // A misbehaving cancel promise cannot extend the deadline either.
            return new Promise<void>(() => {});
          },
        }),
      );
      try {
        await expect(
          __internal.downloadFile("https://example.test/asset", dest, {
            downloadTimeoutMs: 25,
            fetchImpl: (async (_input, init) => {
              requestSignal = init?.signal;
              return phase === "body"
                ? response
                : new Promise<Response>((resolve) => {
                    resolveHeaders = resolve;
                  });
            }) as typeof fetch,
          }),
        ).rejects.toThrow("timed out");
        expect(requestSignal?.aborted).toBe(true);
        if (phase === "headers") {
          resolveHeaders(response);
          // Flush the late transport continuation (there must be no late writes).
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(cancelled).toBe(true);
        await expect(fs.access(dest)).rejects.toThrow();
        expect(response.body?.locked).toBe(false);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test("caller cancellation stops a stalled body and removes partial bytes", async () => {
    const root = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-cancel-"));
    const dest = path.join(root, "asset");
    const controller = new AbortController();
    let pulls = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(stream) {
            if (pulls++ === 0) stream.enqueue(new Uint8Array([1, 2]));
            else {
              expect(await fs.readFile(dest)).toEqual(Buffer.from([1, 2]));
              controller.abort(new Error("User cancelled Codex repair"));
            }
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
    try {
      await expect(
        __internal.downloadFile("https://example.test/asset", dest, {
          signal: controller.signal,
          fetchImpl: (async () => response) as typeof fetch,
        }),
      ).rejects.toThrow("User cancelled Codex repair");
      expect(cancelled).toBe(true);
      await expect(fs.access(dest)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("cancels HTTP error bodies without reading or writing them", async () => {
    const root = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-http-error-"));
    const dest = path.join(root, "asset");
    let cancelled = false;
    const response = new Response(
      new ReadableStream(
        {
          pull() {
            throw new Error("HTTP error body must not be read");
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 503 },
    );
    try {
      await expect(
        __internal.downloadFile("https://example.test/asset", dest, {
          fetchImpl: (async () => response) as typeof fetch,
        }),
      ).rejects.toThrow("503");
      expect(cancelled).toBe(true);
      await expect(fs.access(dest)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("forced Codex companion repair", () => {
  test.each(["same home", "aliased home"] as const)(
    "serializes real process activation for %s without sharing temporary files",
    async (homeKind) => {
      const root = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-process-race-"));
      const homeDir = path.join(root, "home");
      const alias = path.join(root, "alias");
      await fs.mkdir(homeDir);
      if (homeKind === "aliased home") await fs.symlink(homeDir, alias, "junction");
      type Message = { type: string; temporaryPath?: string; error?: string };
      const workers: ReturnType<typeof startWorker>[] = [];
      function startWorker(home: string) {
        const messages: Message[] = [];
        let deliver: ((message: Message) => void) | undefined;
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            path.join(import.meta.dir, "../fixtures/codex-install-worker.ts"),
            home,
          ],
          stdout: "pipe",
          stderr: "pipe",
          ipc(message: Message) {
            if (deliver) {
              const receive = deliver;
              deliver = undefined;
              receive(message);
            } else messages.push(message);
          },
        });
        const next = async (): Promise<Message> => {
          const queued = messages.shift();
          if (queued) return queued;
          return await new Promise<Message>((resolve, reject) => {
            const timer = setTimeout(() => {
              deliver = undefined;
              reject(new Error("Codex install worker did not reach its next barrier"));
            }, 2_000);
            deliver = (message) => {
              clearTimeout(timer);
              resolve(message);
            };
          });
        };
        const worker = { child, next };
        workers.push(worker);
        return worker;
      }
      try {
        const first = startWorker(homeDir);
        const firstCopy = await first.next();
        expect(firstCopy.type).toBe("copied");
        // The first worker is paused after copying its companion, before
        // renaming it. A second OS process must contend, not touch that set.
        const second = startWorker(homeKind === "aliased home" ? alias : homeDir);
        expect(await second.next()).toEqual({ type: "contended" });
        first.child.send("release");
        expect(await first.next()).toEqual({ type: "activated" });
        expect(await first.next()).toEqual({ type: "done" });
        const secondCopy = await second.next();
        expect(secondCopy.type).toBe("copied");
        expect(path.basename(secondCopy.temporaryPath!)).not.toBe(
          path.basename(firstCopy.temporaryPath!),
        );
        second.child.send("release");
        expect(await second.next()).toEqual({ type: "activated" });
        expect(await second.next()).toEqual({ type: "done" });
        for (const worker of workers) {
          const code = await worker.child.exited;
          const stderr = await new Response(worker.child.stderr).text();
          expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        }
        const target = { platform: "win32" as const, arch: "x64" };
        for (const executable of [
          __internal.managedExecutablePath(homeDir, CODEX_APP_SERVER_MANAGED_VERSION, target),
          __internal.managedCurrentPath(homeDir, target),
        ]) {
          expect(await fs.readFile(executable, "utf8")).toBe("managed app-server");
          expect(await fs.readFile(`${executable}.version`, "utf8")).toBe(
            `${CODEX_APP_SERVER_MANAGED_VERSION}\n`,
          );
          for (const [basename, content] of [
            ["codex-code-mode-host", "managed code-mode host"],
            ["codex-command-runner", "managed command runner"],
            ["codex-windows-sandbox-setup", "managed sandbox setup"],
          ] as const) {
            expect(
              await fs.readFile(
                __internal.companionSiblingPath(executable, basename, target),
                "utf8",
              ),
            ).toBe(content);
          }
          expect(
            (await fs.readdir(path.dirname(executable))).some((name) => name.includes(".tmp")),
          ).toBe(false);
        }
      } finally {
        for (const worker of workers) {
          if (worker.child.exitCode === null) worker.child.kill();
        }
        await Promise.all(workers.map((worker) => worker.child.exited));
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test("repairs the extracted Unix code-mode host before promoting current", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-unix-repair-"));
    const target = { platform: "linux" as const, arch: "x64" };
    const expectedChecksums: Record<string, string> = {};
    const archives = new Map<string, Uint8Array<ArrayBuffer>>();
    const sourceDir = path.join(homeDir, "fixtures");
    try {
      await fs.mkdir(sourceDir);
      for (const basename of ["codex-app-server", "codex-code-mode-host"]) {
        await fs.writeFile(path.join(sourceDir, basename), `verified ${basename}`);
        const assetName = `${basename}-x86_64-unknown-linux-musl.tar.gz`;
        const archive = path.join(homeDir, assetName);
        const result = await execFileCompat("tar", ["-czf", archive, "-C", sourceDir, basename]);
        expect(result.exitCode).toBe(0);
        const bytes = new Uint8Array(await fs.readFile(archive));
        archives.set(assetName, bytes);
        expectedChecksums[assetName] = createHash("sha256").update(bytes).digest("hex");
      }
      const overrides = {
        homeDir,
        ...target,
        expectedChecksums,
        fetchImpl: (async (input) => {
          const url = String(input);
          if (url.includes("/releases/"))
            return Response.json({
              tag_name: `rust-v${CODEX_APP_SERVER_MANAGED_VERSION}`,
              assets: [...archives.keys()].map((name) => ({
                name,
                browser_download_url: `https://example.test/${name}`,
              })),
            });
          return new Response(archives.get(new URL(url).pathname.slice(1)));
        }) as typeof fetch,
      };
      const installed = await updateManagedCodexAppServer({}, overrides);
      const versioned = __internal.managedExecutablePath(
        homeDir,
        CODEX_APP_SERVER_MANAGED_VERSION,
        target,
      );
      const current = __internal.managedCurrentPath(homeDir, target);
      expect(installed.command).toBe(current);
      await fs.rm(__internal.codeModeHostSiblingPath(versioned, target));
      await fs.writeFile(__internal.codeModeHostSiblingPath(current, target), "corrupt host");
      await updateManagedCodexAppServer({ force: true }, overrides);
      for (const executable of [versioned, current]) {
        expect(await fs.readFile(executable, "utf8")).toBe("verified codex-app-server");
        expect(
          await fs.readFile(__internal.codeModeHostSiblingPath(executable, target), "utf8"),
        ).toBe("verified codex-code-mode-host");
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("cancellation during the last artifact leaves installed bytes untouched", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-cancel-install-"));
    const target = { platform: "win32" as const, arch: "x64" };
    const overrides = {
      homeDir,
      ...target,
      fetchImpl: fakeReleaseFetch(),
      expectedChecksums: FAKE_ASSET_CHECKSUMS,
    };
    const controller = new AbortController();
    const versioned = __internal.managedExecutablePath(
      homeDir,
      CODEX_APP_SERVER_MANAGED_VERSION,
      target,
    );
    const current = __internal.managedCurrentPath(homeDir, target);
    try {
      await updateManagedCodexAppServer({}, overrides);
      for (const executable of [versioned, current]) {
        await fs.writeFile(executable, "previous app-server");
        await fs.writeFile(__internal.codeModeHostSiblingPath(executable, target), "previous host");
      }
      await expect(
        updateManagedCodexAppServer(
          { force: true, signal: controller.signal },
          {
            ...overrides,
            fetchImpl: (async (input, init) => {
              if (!String(input).endsWith("/codex-app-server.exe"))
                return overrides.fetchImpl(input, init);
              return new Response(
                new ReadableStream(
                  {
                    pull() {
                      controller.abort(new Error("Cancelled forced repair"));
                    },
                  },
                  { highWaterMark: 0 },
                ),
              );
            }) as typeof fetch,
          },
        ),
      ).rejects.toThrow("Cancelled forced repair");
      for (const executable of [versioned, current]) {
        expect(await fs.readFile(executable, "utf8")).toBe("previous app-server");
        expect(
          await fs.readFile(__internal.codeModeHostSiblingPath(executable, target), "utf8"),
        ).toBe("previous host");
        expect(
          (await fs.readdir(path.dirname(executable))).some((name) => name.includes(".tmp")),
        ).toBe(false);
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("replaces corrupt companions and restores missing helpers in both managed locations", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-force-repair-"));
    const target = { platform: "win32" as const, arch: "x64" };
    const overrides = {
      homeDir,
      ...target,
      fetchImpl: fakeReleaseFetch(),
      expectedChecksums: FAKE_ASSET_CHECKSUMS,
    };
    const versioned = __internal.managedExecutablePath(
      homeDir,
      CODEX_APP_SERVER_MANAGED_VERSION,
      target,
    );
    const current = __internal.managedCurrentPath(homeDir, target);
    try {
      await updateManagedCodexAppServer({}, overrides);
      for (const executable of [versioned, current]) {
        await fs.writeFile(__internal.codeModeHostSiblingPath(executable, target), "corrupt host");
        await fs.rm(__internal.companionSiblingPath(executable, "codex-command-runner", target));
        await fs.writeFile(
          __internal.companionSiblingPath(executable, "codex-windows-sandbox-setup", target),
          "corrupt setup",
        );
      }
      const downloads: string[] = [];
      const status = await updateManagedCodexAppServer(
        { force: true },
        {
          ...overrides,
          fetchImpl: (async (input, init) => {
            if (!String(input).includes("/releases/")) downloads.push(String(input));
            return overrides.fetchImpl(input, init);
          }) as typeof fetch,
        },
      );
      expect(status.pinMatchesCurrent).toBe(true);
      expect(downloads).toHaveLength(4);
      for (const executable of [versioned, current]) {
        expect(await fs.readFile(executable, "utf8")).toBe("managed app-server");
        for (const [basename, bytes] of [
          ["codex-code-mode-host", "managed code-mode host"],
          ["codex-command-runner", "managed command runner"],
          ["codex-windows-sandbox-setup", "managed sandbox setup"],
        ] as const) {
          expect(
            await fs.readFile(
              __internal.companionSiblingPath(executable, basename, target),
              "utf8",
            ),
          ).toBe(bytes);
        }
        expect(
          (await fs.readdir(path.dirname(executable))).some((name) => name.includes(".tmp")),
        ).toBe(false);
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test.each(["app-server", "windows-sandbox-setup"] as const)(
    "failed %s verification leaves the entire existing install untouched",
    async (failedAsset) => {
      const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-force-fail-"));
      const target = { platform: "win32" as const, arch: "x64" };
      const overrides = {
        homeDir,
        ...target,
        fetchImpl: fakeReleaseFetch(),
        expectedChecksums: FAKE_ASSET_CHECKSUMS,
      };
      const versioned = __internal.managedExecutablePath(
        homeDir,
        CODEX_APP_SERVER_MANAGED_VERSION,
        target,
      );
      const current = __internal.managedCurrentPath(homeDir, target);
      try {
        await updateManagedCodexAppServer({}, overrides);
        // Different preexisting bytes make premature replacement observable.
        for (const executable of [versioned, current]) {
          await fs.writeFile(executable, "previous app-server");
          for (const companion of __internal.codexCompanionBinaries) {
            await fs.writeFile(
              __internal.companionSiblingPath(executable, companion.basename, target),
              `previous ${companion.basename}`,
            );
          }
        }
        await expect(
          updateManagedCodexAppServer(
            { force: true },
            {
              ...overrides,
              expectedChecksums: {
                ...FAKE_ASSET_CHECKSUMS,
                [`codex-${failedAsset}-x86_64-pc-windows-msvc.exe`]: "0".repeat(64),
              },
            },
          ),
        ).rejects.toThrow("checksum verification");
        for (const executable of [versioned, current]) {
          expect(await fs.readFile(executable, "utf8")).toBe("previous app-server");
          for (const companion of __internal.codexCompanionBinaries) {
            expect(
              await fs.readFile(
                __internal.companionSiblingPath(executable, companion.basename, target),
                "utf8",
              ),
            ).toBe(`previous ${companion.basename}`);
          }
        }
      } finally {
        await fs.rm(homeDir, { recursive: true, force: true });
      }
    },
  );

  test("rejects release metadata that does not match the requested pin before downloading", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-wrong-pin-"));
    let requests = 0;
    try {
      await expect(
        updateManagedCodexAppServer(
          { force: true },
          {
            homeDir,
            platform: "win32",
            arch: "x64",
            fetchImpl: (async () => {
              requests++;
              return Response.json({ tag_name: "rust-v0.152.1", assets: [] });
            }) as typeof fetch,
          },
        ),
      ).rejects.toThrow("did not match requested version");
      expect(requests).toBe(1);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test("pre-cancelled forced updates do not fetch or modify the installation", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-pre-cancel-"));
    try {
      await expect(
        updateManagedCodexAppServer(
          {
            force: true,
            signal: AbortSignal.abort(new Error("Cancelled repair")),
          },
          {
            homeDir,
            fetchImpl: (async () => {
              throw new Error("Must not fetch");
            }) as typeof fetch,
          },
        ),
      ).rejects.toThrow("Cancelled repair");
      expect(await fs.readdir(homeDir)).toEqual([]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
