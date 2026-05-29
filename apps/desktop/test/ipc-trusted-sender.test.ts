import { afterEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createElectronMock } from "./helpers/mockElectron";

let trustedSenderModuleImportNonce = 0;

async function loadTrustedSender(appOverrides: Record<string, unknown>) {
  mock.restore();
  mock.module("electron", () =>
    createElectronMock({
      app: appOverrides,
    }),
  );

  const module = await import(
    `../electron/ipc/trustedSender?ipc-trusted-sender-test=${trustedSenderModuleImportNonce++}`
  );
  mock.restore();
  return module;
}

afterEach(() => {
  mock.restore();
});

describe("trusted sender IPC helpers", () => {
  test("resolves packaged renderer path under ESM without CommonJS globals", async () => {
    const { isTrustedSender } = await loadTrustedSender({
      isPackaged: true,
    });
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const rendererDir = path.resolve(testDir, "../electron/renderer");
    const senderUrl = pathToFileURL(path.join(rendererDir, "index.html")).href;

    expect(
      isTrustedSender({
        senderFrame: {
          url: senderUrl,
        },
        sender: {
          getURL: () => "https://evil.example",
        },
      } as never),
    ).toBe(true);
  });

  test("does not trust blank frame URLs instead of falling back to the top-level sender URL", async () => {
    const { isTrustedSender } = await loadTrustedSender({
      isPackaged: false,
    });

    expect(
      isTrustedSender({
        senderFrame: {
          url: "   ",
        },
        sender: {
          getURL: () => "http://localhost:1420/index.html",
        },
      } as never),
    ).toBe(false);
  });
});
