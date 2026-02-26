import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isTrustedDesktopSenderUrl,
  resolveAllowedDirectoryPath,
  resolveAllowedPath,
} from "../electron/services/ipcSecurity";

describe("desktop IPC security helpers", () => {
  test("accepts trusted dev renderer URLs and rejects untrusted URLs", () => {
    expect(
      isTrustedDesktopSenderUrl("http://localhost:1420/index.html", {
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

  test("resolveAllowedPath enforces boundary for new or non-existent files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-root-"));
    const workspaceRoot = await fs.realpath(tempRoot);
    try {
      const newFile = path.join(workspaceRoot, "new_file.txt");
      const resolved = resolveAllowedPath([workspaceRoot], newFile);
      expect(resolved).toBe(newFile); // Since it doesn't exist, realpathSync fails and it returns resolve() which is within root

      const outsideFile = path.join(workspaceRoot, "..", "new_file.txt");
      expect(() => resolveAllowedPath([workspaceRoot], outsideFile)).toThrow("outside allowed workspace roots");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
