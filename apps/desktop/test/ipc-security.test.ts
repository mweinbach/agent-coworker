import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isTrustedDesktopSenderUrl,
  resolveAllowedDirectoryPath,
} from "../electron/services/ipcSecurity";

describe("desktop IPC security helpers", () => {
  test("accepts trusted dev renderer URLs and rejects untrusted URLs", () => {
    expect(
      isTrustedDesktopSenderUrl("http://127.0.0.1:1420/index.html", {
        isPackaged: false,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
      })
    ).toBe(true);

    expect(
      isTrustedDesktopSenderUrl("https://evil.example", {
        isPackaged: false,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
      })
    ).toBe(false);
  });

  test("accepts only file:// senders when packaged", () => {
    expect(
      isTrustedDesktopSenderUrl("file:///Applications/Cowork.app/Contents/Resources/index.html", {
        isPackaged: true,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
      })
    ).toBe(true);

    expect(
      isTrustedDesktopSenderUrl("https://example.com", {
        isPackaged: true,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
      })
    ).toBe(false);
  });

  test("enforces workspace-root directory allowlist", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-root-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-outside-"));
    try {
      const nested = path.join(workspaceRoot, "src");
      await fs.mkdir(nested, { recursive: true });

      const resolved = resolveAllowedDirectoryPath([workspaceRoot], nested);
      expect(resolved).toBe(await fs.realpath(nested));

      expect(() => resolveAllowedDirectoryPath([workspaceRoot], path.dirname(workspaceRoot))).toThrow(
        "outside allowed workspace roots"
      );

      if (process.platform !== "win32") {
        const escapeLink = path.join(workspaceRoot, "escape");
        await fs.symlink(outsideRoot, escapeLink);
        expect(() => resolveAllowedDirectoryPath([workspaceRoot], escapeLink)).toThrow(
          "outside allowed workspace roots"
        );
      }
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
