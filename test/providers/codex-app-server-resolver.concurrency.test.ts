import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../src/platform/sandbox/policy";
import {
  __internal,
  CODEX_APP_SERVER_MANAGED_VERSION,
} from "../../src/providers/codexAppServerResolver";

function testTempRoot(): string {
  const root = scratchRoots()[0];
  if (!root) throw new Error("No platform scratch root is available for tests");
  return root;
}

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

afterEach(() => {
  if (previousCommand === undefined) delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
  else process.env.COWORK_CODEX_APP_SERVER_COMMAND = previousCommand;
  if (previousArgs === undefined) delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
  else process.env.COWORK_CODEX_APP_SERVER_ARGS = previousArgs;
});

function gatedReleaseFetch(opts: {
  version?: string;
  assetHold?: Promise<void>;
  releaseStarts: { count: number };
  assetDownloads: { count: number };
  failAssetOnce?: { remaining: number };
}): typeof fetch {
  const version = opts.version ?? CODEX_APP_SERVER_MANAGED_VERSION;
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/releases/")) {
      opts.releaseStarts.count += 1;
      return new Response(
        JSON.stringify({
          tag_name: `rust-v${version}`,
          assets: [
            {
              name: "codex-app-server-x86_64-pc-windows-msvc.exe",
              browser_download_url: "https://example.test/codex-app-server.exe",
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
    if (opts.assetHold) await opts.assetHold;
    opts.assetDownloads.count += 1;
    if (opts.failAssetOnce && opts.failAssetOnce.remaining > 0) {
      opts.failAssetOnce.remaining -= 1;
      return new Response("boom", { status: 500 });
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

describe("codex app-server install concurrency", () => {
  test.serial("coalesces concurrent installs for the same managed version", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-install-coalesce-"));
    let assetContinue!: () => void;
    const assetHold = new Promise<void>((resolve) => {
      assetContinue = resolve;
    });
    const releaseStarts = { count: 0 };
    const assetDownloads = { count: 0 };
    const fetchImpl = gatedReleaseFetch({ assetHold, releaseStarts, assetDownloads });

    const first = __internal.installCodexAppServer(
      { version: CODEX_APP_SERVER_MANAGED_VERSION },
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl,
        expectedChecksums: FAKE_ASSET_CHECKSUMS,
      },
    );
    // Let the first install enter the download critical section before joining.
    await Bun.sleep(20);
    const second = __internal.installCodexAppServer(
      { version: CODEX_APP_SERVER_MANAGED_VERSION },
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl,
        expectedChecksums: FAKE_ASSET_CHECKSUMS,
      },
    );

    await Bun.sleep(20);
    expect(assetDownloads.count).toBe(0);
    assetContinue();

    const [a, b] = await Promise.all([first, second]);
    expect(a.command).toBe(b.command);
    expect(a.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
    // Release metadata may be fetched by both callers; asset download must run once.
    expect(assetDownloads.count).toBe(4);
  });

  test.serial("clears a failed in-flight install so a later retry can succeed", async () => {
    const homeDir = await fs.mkdtemp(path.join(testTempRoot(), "cowork-codex-install-retry-"));
    const failAssetOnce = { remaining: 1 };
    const fetchImpl = gatedReleaseFetch({
      releaseStarts: { count: 0 },
      assetDownloads: { count: 0 },
      failAssetOnce,
    });

    await expect(
      __internal.installCodexAppServer(
        { version: CODEX_APP_SERVER_MANAGED_VERSION },
        {
          homeDir,
          platform: "win32",
          arch: "x64",
          fetchImpl,
          expectedChecksums: FAKE_ASSET_CHECKSUMS,
        },
      ),
    ).rejects.toThrow();

    const command = await __internal.installCodexAppServer(
      { version: CODEX_APP_SERVER_MANAGED_VERSION },
      {
        homeDir,
        platform: "win32",
        arch: "x64",
        fetchImpl,
        expectedChecksums: FAKE_ASSET_CHECKSUMS,
      },
    );
    expect(command.version).toBe(CODEX_APP_SERVER_MANAGED_VERSION);
    const executablePath = __internal.managedExecutablePath(
      homeDir,
      CODEX_APP_SERVER_MANAGED_VERSION,
      { platform: "win32", arch: "x64" },
    );
    await fs.access(executablePath);
  });
});
