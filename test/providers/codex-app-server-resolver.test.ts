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

function testTempRoot(): string {
  const root = scratchRoots()[0];
  if (!root) throw new Error("No platform scratch root is available for tests");
  return root;
}

// fakeReleaseFetch serves the literal bytes "managed app-server" for app-server
// downloads and "managed code-mode host" for codex-code-mode-host downloads.
// The resolver now verifies downloaded assets against a pinned SHA-256, so the
// install plumbing tests inject the matching checksum via the expectedChecksums
// override (production verifies against the repo-pinned map instead).
const FAKE_ASSET_SHA256 = createHash("sha256").update("managed app-server").digest("hex");
const FAKE_HOST_ASSET_SHA256 = createHash("sha256").update("managed code-mode host").digest("hex");
const FAKE_ASSET_CHECKSUMS: Record<string, string> = {
  "codex-app-server-x86_64-pc-windows-msvc.exe": FAKE_ASSET_SHA256,
  "codex-app-server-aarch64-pc-windows-msvc.exe": FAKE_ASSET_SHA256,
  "codex-app-server-x86_64-apple-darwin.tar.gz": FAKE_ASSET_SHA256,
  "codex-app-server-aarch64-apple-darwin.tar.gz": FAKE_ASSET_SHA256,
  "codex-code-mode-host-x86_64-pc-windows-msvc.exe": FAKE_HOST_ASSET_SHA256,
  "codex-code-mode-host-aarch64-pc-windows-msvc.exe": FAKE_HOST_ASSET_SHA256,
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
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("code-mode-host")) {
      return new Response("managed code-mode host", { status: 200 });
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
  test("pins the GPT-5.6-capable stable release and all supported asset digests", () => {
    expect(CODEX_APP_SERVER_MANAGED_VERSION).toBe("0.144.0");
    const expected = {
      "darwin-arm64": [
        "codex-app-server-aarch64-apple-darwin.tar.gz",
        "982f3a687dc8266580770da68dfe661d7a4825773737f23a7e74e15ab0866da9",
      ],
      "darwin-x64": [
        "codex-app-server-x86_64-apple-darwin.tar.gz",
        "e358b666be9f0d9dd2b0c1678ec0b9b0ef621df68ba0a4f91e7879a4da400561",
      ],
      "linux-arm64": [
        "codex-app-server-aarch64-unknown-linux-musl.tar.gz",
        "eebfa18d883c76874dd3c16ecc2cf914ba22c89418e97a6a5ef81c3b9786ac92",
      ],
      "linux-x64": [
        "codex-app-server-x86_64-unknown-linux-musl.tar.gz",
        "3ea7c729d7c5107ba53fef17ba1f74ed19078b79f7bafd16eafc4a3576362187",
      ],
      "win32-arm64": [
        "codex-app-server-aarch64-pc-windows-msvc.exe",
        "3eee2fbd3b9ec94709a84699dc86d39b2ba6d895882f42b3809aaabb9530b3a2",
      ],
      "win32-x64": [
        "codex-app-server-x86_64-pc-windows-msvc.exe",
        "197f96d25723726cfc060a7accdba3708d3fc38dbbb11c46c96fd217b8595fb3",
      ],
    } as const;

    for (const [targetKey, [assetName, digest]] of Object.entries(expected)) {
      const [platform, arch] = targetKey.split("-") as [NodeJS.Platform, string];
      expect(__internal.resolveCodexAppServerAssetName({ platform, arch })).toBe(assetName);
      expect(__internal.expectedCodexAssetChecksum("0.144.0", assetName, {})).toBe(digest);
    }

    const expectedHosts = {
      "darwin-arm64": [
        "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
        "6cf9282430befe541369c7cb2804604a7f0dd9416f3a3241e3676db22022a246",
      ],
      "darwin-x64": [
        "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
        "6fd2b21d9737f90d9cd047da717d378e58009c0c069b5ecd4fb86ebcfef52d1f",
      ],
      "linux-arm64": [
        "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
        "2ab25695f61ac23a71e467425322a1f197ea52e9da9aa8e0cbc339d661c6d16a",
      ],
      "linux-x64": [
        "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
        "26d9c65c5a947c2bf489513ef7f81e027b0c96dc15e2781de6eed5e02a18993d",
      ],
      "win32-arm64": [
        "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
        "21d78b37b846ef2557bd4eb2e73ee48daf9fdea71cf2a7c41c048ff2064631a7",
      ],
      "win32-x64": [
        "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
        "66c351f09fb6a28d71c3186252293e2e410820f07d38bfbdc9e6bf6e2c47c510",
      ],
    } as const;

    for (const [targetKey, [assetName, digest]] of Object.entries(expectedHosts)) {
      const [platform, arch] = targetKey.split("-") as [NodeJS.Platform, string];
      expect(__internal.resolveCodeModeHostAssetName({ platform, arch })).toBe(assetName);
      expect(__internal.expectedCodexAssetChecksum("0.144.0", assetName, {})).toBe(digest);
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
