import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  isTrustedDesktopSenderUrl,
  resolveAllowedDirectoryPath,
  resolveAllowedPath,
  resolveAllowedRevealPath,
  resolveAllowedSaveExportSourcePath,
} from "../electron/services/ipcSecurity";
import { isPathEqualOrInside } from "../electron/services/pathBoundary";

describe("desktop IPC security helpers", () => {
  test("accepts trusted dev renderer URLs and rejects untrusted URLs", () => {
    expect(
      isTrustedDesktopSenderUrl("http://localhost:1420/index.html", {
        isPackaged: false,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
      }),
    ).toBe(true);

    expect(
      isTrustedDesktopSenderUrl("https://evil.example", {
        isPackaged: false,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
      }),
    ).toBe(false);
  });

  test("accepts only file:// senders within renderer dir when packaged", () => {
    const appRoot = path.join(os.tmpdir(), "Cowork.app", "Contents", "Resources");
    const rendererDir = path.join(appRoot, "renderer");

    expect(
      isTrustedDesktopSenderUrl(pathToFileURL(path.join(rendererDir, "index.html")).href, {
        isPackaged: true,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
        packagedRendererDir: rendererDir,
      }),
    ).toBe(true);

    expect(
      isTrustedDesktopSenderUrl(pathToFileURL(path.join(rendererDir, "nested", "page.html")).href, {
        isPackaged: true,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
        packagedRendererDir: rendererDir,
      }),
    ).toBe(true);

    expect(
      isTrustedDesktopSenderUrl(pathToFileURL(path.join(os.tmpdir(), "anything.html")).href, {
        isPackaged: true,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
        packagedRendererDir: rendererDir,
      }),
    ).toBe(false);

    expect(
      isTrustedDesktopSenderUrl(pathToFileURL(path.join(appRoot, "index.html")).href, {
        isPackaged: true,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
        packagedRendererDir: rendererDir,
      }),
    ).toBe(false);

    expect(
      isTrustedDesktopSenderUrl("https://example.com", {
        isPackaged: true,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
        packagedRendererDir: rendererDir,
      }),
    ).toBe(false);

    expect(
      isTrustedDesktopSenderUrl(pathToFileURL(path.join(rendererDir, "index.html")).href, {
        isPackaged: true,
        electronRendererUrl: undefined,
        desktopRendererPort: undefined,
      }),
    ).toBe(false);
  });

  test("enforces workspace-root directory allowlist", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-root-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-outside-"));
    try {
      const nested = path.join(workspaceRoot, "src");
      await fs.mkdir(nested, { recursive: true });

      const resolved = resolveAllowedDirectoryPath([workspaceRoot], nested);
      expect(await fs.realpath(resolved)).toBe(await fs.realpath(nested));

      expect(() =>
        resolveAllowedDirectoryPath([workspaceRoot], path.dirname(workspaceRoot)),
      ).toThrow("outside allowed workspace roots");

      if (process.platform !== "win32") {
        const escapeLink = path.join(workspaceRoot, "escape");
        await fs.symlink(outsideRoot, escapeLink);
        expect(() => resolveAllowedDirectoryPath([workspaceRoot], escapeLink)).toThrow(
          "outside allowed workspace roots",
        );
      } else {
        const escapeJunction = path.join(workspaceRoot, "escape-junction");
        await fs.symlink(outsideRoot, escapeJunction, "junction");
        expect(() => resolveAllowedDirectoryPath([workspaceRoot], escapeJunction)).toThrow(
          "outside allowed workspace roots",
        );
      }
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("resolveAllowedPath treats Windows drive paths case-insensitively", () => {
    if (process.platform !== "win32") {
      return;
    }

    expect(
      resolveAllowedPath(["C:\\Users\\Max\\Workspace"], "c:\\users\\max\\workspace\\file.txt"),
    ).toBe("c:\\users\\max\\workspace\\file.txt");
    expect(() =>
      resolveAllowedPath(
        ["C:\\Users\\Max\\Workspace"],
        "c:\\users\\max\\workspace-other\\file.txt",
      ),
    ).toThrow("outside allowed workspace roots");
  });

  test("path boundary helper handles Windows case and drive boundaries", () => {
    if (process.platform !== "win32") {
      return;
    }

    expect(
      isPathEqualOrInside("C:\\Users\\Max\\Workspace", "c:\\users\\max\\workspace\\file.txt"),
    ).toBe(true);
    expect(
      isPathEqualOrInside("C:\\Users\\Max\\Workspace", "c:\\users\\max\\workspace2\\file.txt"),
    ).toBe(false);
    expect(isPathEqualOrInside("C:\\Users\\Max\\Workspace", "D:\\data\\file.txt")).toBe(false);
  });

  test("path boundary helper handles UNC roots on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    expect(
      isPathEqualOrInside("\\\\server\\share\\workspace", "\\\\SERVER\\SHARE\\workspace\\file.txt"),
    ).toBe(true);
    expect(isPathEqualOrInside("C:\\Users\\Max\\Workspace", "\\\\server\\share\\file.txt")).toBe(
      false,
    );
  });

  test("resolveAllowedPath enforces boundary for new or non-existent files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-root-"));
    const workspaceRoot = await fs.realpath(tempRoot);
    try {
      const newFile = path.join(workspaceRoot, "new_file.txt");
      const resolved = resolveAllowedPath([workspaceRoot], newFile);
      expect(resolved).toBe(newFile); // Since it doesn't exist, realpathSync fails and it returns resolve() which is within root

      const outsideFile = path.join(workspaceRoot, "..", "new_file.txt");
      expect(() => resolveAllowedPath([workspaceRoot], outsideFile)).toThrow(
        "outside allowed workspace roots",
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("resolveAllowedPath keeps openPath inside workspace roots", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-ws-"));
    const workspaceRoot = await fs.realpath(tempWorkspace);
    const home = os.homedir();
    try {
      const coworkSkill = path.join(home, ".cowork", "skills", "some-skill", "SKILL.md");
      expect(() => resolveAllowedPath([workspaceRoot], coworkSkill)).toThrow(
        "outside allowed workspace roots",
      );
      expect(() => resolveAllowedRevealPath([workspaceRoot], coworkSkill)).not.toThrow();
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("resolveAllowedSaveExportSourcePath allows ~/.cowork/research exports and rejects other home paths", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-ws-"));
    const workspaceRoot = await fs.realpath(tempWorkspace);
    const home = os.homedir();
    try {
      const researchExport = path.join(home, ".cowork", "research", "research-1", "report.pdf");
      const unrelatedHomePath = path.join(home, ".cowork", "auth", "codex-cli", "auth.json");

      expect(resolveAllowedSaveExportSourcePath([workspaceRoot], researchExport)).toBe(
        researchExport,
      );
      expect(() => resolveAllowedSaveExportSourcePath([workspaceRoot], unrelatedHomePath)).toThrow(
        "outside allowed workspace roots",
      );
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("resolveAllowedRevealPath allows ~/.cowork and ~/.cowork paths for skill folders", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-ws-"));
    const workspaceRoot = await fs.realpath(tempWorkspace);
    const home = os.homedir();
    try {
      const coworkSkill = path.join(home, ".cowork", "skills", "some-skill", "SKILL.md");
      const agentSkill = path.join(home, ".cowork", "skills", "other", "SKILL.md");
      expect(() => resolveAllowedRevealPath([workspaceRoot], coworkSkill)).not.toThrow();
      expect(() => resolveAllowedRevealPath([workspaceRoot], agentSkill)).not.toThrow();

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-nope-"));
      try {
        expect(() =>
          resolveAllowedRevealPath([workspaceRoot], path.join(outside, "secret")),
        ).toThrow("outside allowed workspace roots");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("resolveAllowedRevealPath allows workspace and skill-home paths used by reveal IPC", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-ws-"));
    const workspaceRoot = await fs.realpath(tempWorkspace);
    const home = os.homedir();
    const workspaceFile = path.join(workspaceRoot, "inside.txt");
    const coworkSkillDir = path.join(home, ".cowork", "skills", "some-skill");
    const agentSkillFile = path.join(home, ".cowork", "skills", "other", "SKILL.md");
    try {
      await fs.writeFile(workspaceFile, "inside workspace\n");

      expect(resolveAllowedRevealPath([workspaceRoot], workspaceFile)).toBe(workspaceFile);
      expect(() => resolveAllowedRevealPath([workspaceRoot], coworkSkillDir)).not.toThrow();
      expect(() => resolveAllowedRevealPath([workspaceRoot], agentSkillFile)).not.toThrow();

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-open-nope-"));
      try {
        expect(() =>
          resolveAllowedRevealPath([workspaceRoot], path.join(outside, "secret")),
        ).toThrow("outside allowed workspace roots");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("resolveAllowedRevealPath allows paths under configurable built-in skill roots", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-ws-"));
    const workspaceRoot = await fs.realpath(tempWorkspace);
    const builtinRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-builtin-"));
    try {
      const skillFile = path.join(builtinRoot, "skills", "bundled-skill", "SKILL.md");
      await fs.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.writeFile(skillFile, "---\nname: x\n---\n", "utf-8");

      expect(() =>
        resolveAllowedRevealPath([workspaceRoot], skillFile, [builtinRoot]),
      ).not.toThrow();
    } finally {
      await fs.rm(builtinRoot, { recursive: true, force: true });
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });
});
