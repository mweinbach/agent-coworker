import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __internal,
  CODEX_APP_SERVER_MANAGED_VERSION,
  getCodexAppServerInstallStatus,
  resolveCodexAppServerCommand,
  updateManagedCodexAppServer,
} from "../../src/providers/codexAppServerResolver";

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
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("managed app-server", { status: 200 });
  }) as typeof fetch;
}

async function createFakeCodexBin(prefix: string, name = "codex"): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const codexPath = path.join(binDir, name);
  await fs.writeFile(codexPath, "#!/bin/sh\n", "utf8");
  await fs.chmod(codexPath, 0o755);
  return binDir;
}

describe("codex app-server resolver", () => {
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
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-prod-ignore-"));
    const requestedVersions: string[] = [];

    const command = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch("9.999.0", requestedVersions),
      spawnForResult: async () => {
        throw new Error("system codex should not be probed for production app-server resolution");
      },
    });

    expect(command.source).toBe("managed");
    expect(command.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
    expect(command.command).toContain(path.join("versions", CODEX_APP_SERVER_MANAGED_VERSION));
    expect(requestedVersions).toEqual([CODEX_APP_SERVER_MANAGED_VERSION]);
  });

  test.serial("downloads the app-pinned managed app-server version", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-pinned-download-"));
    const requestedVersions: string[] = [];

    const command = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch("9.999.0", requestedVersions),
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
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-ignore-managed-"));
    for (const version of ["0.135.0", "0.999.0"]) {
      await __internal.installCodexAppServer(
        { version },
        {
          homeDir,
          platform: "win32",
          arch: "x64",
          fetchImpl: fakeReleaseFetch(version),
        },
      );
    }

    const command = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch("9.999.0"),
      spawnForResult: async () => {
        throw new Error("system codex should not be probed for the app-pinned install");
      },
    });

    expect(command.source).toBe("managed");
    expect(command.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
    expect(command.command).toContain(path.join("versions", CODEX_APP_SERVER_MANAGED_VERSION));
  });

  test.serial("does not fall back to system codex when managed download fails", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-no-system-fallback-"));
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
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-status-pin-"));

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
        message: `Cowork-managed Codex app-server ${CODEX_APP_SERVER_MANAGED_VERSION} is not installed. Cowork will download it before first use.`,
      });
    },
  );

  test.serial(
    "status reports the installed app-pinned version without update metadata",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-status-installed-"));
      await updateManagedCodexAppServer(
        {},
        {
          homeDir,
          platform: "win32",
          arch: "x64",
          fetchImpl: fakeReleaseFetch("9.999.0"),
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
        message: `Using Cowork-managed Codex app-server ${CODEX_APP_SERVER_MANAGED_VERSION}.`,
      });
      expect("latestVersion" in status).toBe(false);
      expect("updateAvailable" in status).toBe(false);
    },
  );

  test.serial("update installs only the app-pinned managed app-server", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-update-pinned-"));
    const requestedVersions: string[] = [];

    const status = await updateManagedCodexAppServer(
      {},
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeReleaseFetch("9.999.0", requestedVersions),
      },
    );

    expect(status).toMatchObject({
      source: "managed",
      version: CODEX_APP_SERVER_MANAGED_VERSION,
      pinnedVersion: CODEX_APP_SERVER_MANAGED_VERSION,
      pinMatchesCurrent: true,
      message: `Installed Cowork-managed Codex app-server ${CODEX_APP_SERVER_MANAGED_VERSION}.`,
    });
    expect(status.command).toContain(path.join(".cowork", "codex-app-server", "versions"));
    expect(requestedVersions).toEqual([CODEX_APP_SERVER_MANAGED_VERSION]);
  });

  test.serial(
    "returns the promoted current path for app-pinned managed installs on darwin",
    async () => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-darwin-current-"));
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
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-locked-current-"));
    let attemptedPromotion = false;

    const status = await updateManagedCodexAppServer(
      {},
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeReleaseFetch(CODEX_APP_SERVER_MANAGED_VERSION),
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
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-shadow-root-"));
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
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-win-path-bin-"));
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
});
