import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __internal,
  getCodexAppServerInstallStatus,
  resolveCodexAppServerCommand,
  updateManagedCodexAppServer,
} from "../../src/providers/codexAppServerResolver";

const previousCommand = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
const previousArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;

afterEach(() => {
  if (previousCommand === undefined) delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
  else process.env.COWORK_CODEX_APP_SERVER_COMMAND = previousCommand;
  if (previousArgs === undefined) delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
  else process.env.COWORK_CODEX_APP_SERVER_ARGS = previousArgs;
});

function fakeReleaseFetch(version = "0.129.0"): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/releases/")) {
      return new Response(
        JSON.stringify({
          tag_name: `rust-v${version}`,
          assets: [
            {
              name: "codex-app-server-x86_64-pc-windows-msvc.exe",
              browser_download_url: "https://example.test/codex-app-server.exe",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("managed app-server", { status: 200 });
  }) as typeof fetch;
}

async function createFakeCodexBin(prefix: string): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const codexPath = path.join(binDir, "codex");
  await fs.writeFile(codexPath, "#!/bin/sh\n", "utf8");
  await fs.chmod(codexPath, 0o755);
  return binDir;
}

describe("codex app-server resolver", () => {
  test.serial("uses explicit command overrides without adding implicit app-server args", async () => {
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
  });

  test.serial("downloads a managed app-server before using system codex", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-system-"));
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-system-bin-"));
    const codexPath = path.join(binDir, "codex");
    await fs.writeFile(codexPath, "#!/bin/sh\n", "utf8");
    await fs.chmod(codexPath, 0o755);
    const probedCommands: string[] = [];

    const command = await resolveCodexAppServerCommand({
      homeDir,
      pathEnv: binDir,
      platform: "win32",
      arch: "x64",
      fetchImpl: fakeReleaseFetch("0.129.0"),
      spawnForResult: async (cmd, args) => {
        probedCommands.push([cmd, ...args].join(" "));
        return { ok: true, stdout: "Usage: codex app-server\n", stderr: "" };
      },
    });

    expect(command.source).toBe("managed");
    expect(command.version).toBe("0.129.0");
    expect(await fs.readFile(command.command, "utf8")).toBe("managed app-server");
    expect(probedCommands).toEqual([]);
  });

  test.serial("skips repo-local node_modules codex binaries when resolving system codex", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-shadow-home-"));
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

    const command = await resolveCodexAppServerCommand({
      homeDir,
      pathEnv: [localBinDir, systemBinDir].join(path.delimiter),
      fetchImpl: async () => {
        throw new Error("managed install unavailable");
      },
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

  test.serial("downloads and promotes a managed app-server when codex is missing", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-managed-"));
    const status = await updateManagedCodexAppServer(
      {},
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeReleaseFetch("0.129.0"),
        spawnForResult: async () => ({ ok: false, stdout: "", stderr: "" }),
      },
    );

    expect(status.source).toBe("managed");
    expect(status.version).toBe("0.129.0");
    expect(status.command).toContain(path.join(".cowork", "codex-app-server", "current"));
    expect(await fs.readFile(status.command!, "utf8")).toBe("managed app-server");

    const managed = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      spawnForResult: async () => ({ ok: false, stdout: "", stderr: "" }),
    });
    expect(managed.source).toBe("managed");
    expect(managed.version).toBe("0.129.0");
  });

  test.serial("skips system codex binaries that do not support app-server", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-stale-system-"));
    await updateManagedCodexAppServer(
      {},
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeReleaseFetch("0.129.0"),
        spawnForResult: async () => ({ ok: false, stdout: "", stderr: "" }),
      },
    );
    const binDir = await createFakeCodexBin("cowork-codex-stale-system-bin-");

    const command = await resolveCodexAppServerCommand({
      homeDir,
      pathEnv: binDir,
      platform: "win32",
      arch: "x64",
      spawnForResult: async (_cmd, args) => {
        if (args[0] === "--version") {
          return { ok: true, stdout: "codex-cli 0.87.0\n", stderr: "" };
        }
        expect(args).toEqual(["app-server", "--help"]);
        return {
          ok: false,
          stdout: "",
          stderr: "error: unrecognized subcommand 'app-server'\n",
        };
      },
    });

    expect(command.source).toBe("managed");
    expect(command.version).toBe("0.129.0");
  });

  test.serial("prefers an existing managed app-server over system codex", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-system-managed-"));
    await updateManagedCodexAppServer(
      {},
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl: fakeReleaseFetch("0.129.0"),
        spawnForResult: async () => ({ ok: false, stdout: "", stderr: "" }),
      },
    );

    const resolved = await resolveCodexAppServerCommand({
      homeDir,
      pathEnv: await createFakeCodexBin("cowork-codex-system-managed-bin-"),
      platform: "win32",
      arch: "x64",
      spawnForResult: async () => {
        throw new Error("system codex should not be probed when managed install exists");
      },
    });
    expect(resolved.source).toBe("managed");
    expect(resolved.version).toBe("0.129.0");
  });

  test.serial("reports update availability for older system codex", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-status-"));
    const binDir = await createFakeCodexBin("cowork-codex-status-bin-");
    const status = await getCodexAppServerInstallStatus(
      { checkLatest: true },
      {
        homeDir,
        pathEnv: binDir,
        fetchImpl: fakeReleaseFetch("0.129.0"),
        spawnForResult: async () => ({ ok: true, stdout: "codex-cli 0.128.0\n", stderr: "" }),
      },
    );

    expect(status).toMatchObject({
      available: true,
      source: "system",
      version: "0.128.0",
      latestVersion: "0.129.0",
      updateAvailable: true,
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
