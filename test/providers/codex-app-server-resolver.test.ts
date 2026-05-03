import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getCodexAppServerInstallStatus,
  resolveCodexAppServerCommand,
  updateManagedCodexAppServer,
  __internal,
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

describe("codex app-server resolver", () => {
  test("uses explicit command overrides without adding implicit app-server args", async () => {
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

  test("uses system codex when it is available and no managed install exists", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-system-"));
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-system-bin-"));
    const codexPath = path.join(binDir, "codex");
    await fs.writeFile(codexPath, "#!/bin/sh\n", "utf8");
    await fs.chmod(codexPath, 0o755);

    const command = await resolveCodexAppServerCommand({
      homeDir,
      pathEnv: binDir,
      spawnForResult: async (cmd, args) => {
        expect([cmd, ...args]).toEqual([codexPath, "--version"]);
        return { ok: true, stdout: "codex-cli 0.128.0\n", stderr: "" };
      },
    });

    expect(command).toEqual({
      command: codexPath,
      args: ["app-server"],
      source: "system",
      version: "0.128.0",
    });
  });

  test("skips repo-local node_modules codex binaries when resolving system codex", async () => {
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
    const probedCommands: string[] = [];

    const command = await resolveCodexAppServerCommand({
      homeDir,
      pathEnv: [localBinDir, systemBinDir].join(path.delimiter),
      spawnForResult: async (cmd) => {
        probedCommands.push(cmd);
        if (cmd === staleCodexPath) return { ok: true, stdout: "codex-cli 0.87.0\n", stderr: "" };
        if (cmd === systemCodexPath) return { ok: true, stdout: "codex-cli 0.128.0\n", stderr: "" };
        return { ok: false, stdout: "", stderr: "" };
      },
    });

    expect(probedCommands).toEqual([systemCodexPath]);
    expect(command).toEqual({
      command: systemCodexPath,
      args: ["app-server"],
      source: "system",
      version: "0.128.0",
    });
  });

  test("downloads and promotes a managed app-server when codex is missing", async () => {
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

    const resolved = await resolveCodexAppServerCommand({
      homeDir,
      platform: "win32",
      arch: "x64",
      spawnForResult: async () => ({ ok: true, stdout: "codex-cli 0.128.0\n", stderr: "" }),
    });
    expect(resolved.source).toBe("managed");
    expect(resolved.version).toBe("0.129.0");
  });

  test("reports update availability for older system codex", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-status-"));
    const status = await getCodexAppServerInstallStatus(
      { checkLatest: true },
      {
        homeDir,
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

  test("parses Codex CLI version strings", () => {
    expect(__internal.parseCodexVersion("codex-cli 0.128.0")).toBe("0.128.0");
    expect(__internal.parseCodexVersion("0.129.1")).toBe("0.129.1");
  });
});
