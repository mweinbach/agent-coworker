import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isTrustedDesktopSenderUrl,
  resolveAllowedDirectoryPath,
  resolveAllowedPath,
  resolveAllowedRevealPath,
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
      expect(await fs.realpath(resolved)).toBe(await fs.realpath(nested));

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

  test("resolveAllowedPath keeps openPath inside workspace roots", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-ws-"));
    const workspaceRoot = await fs.realpath(tempWorkspace);
    const home = os.homedir();
    try {
      const coworkSkill = path.join(home, ".cowork", "skills", "some-skill", "SKILL.md");
      expect(() => resolveAllowedPath([workspaceRoot], coworkSkill)).toThrow("outside allowed workspace roots");
      expect(() => resolveAllowedRevealPath([workspaceRoot], coworkSkill)).not.toThrow();
    } finally {
      await fs.rm(tempWorkspace, { recursive: true, force: true });
    }
  });

  test("resolveAllowedRevealPath allows ~/.cowork and ~/.agent paths for skill folders", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-ws-"));
    const workspaceRoot = await fs.realpath(tempWorkspace);
    const home = os.homedir();
    try {
      const coworkSkill = path.join(home, ".cowork", "skills", "some-skill", "SKILL.md");
      const agentSkill = path.join(home, ".agent", "skills", "other", "SKILL.md");
      expect(() => resolveAllowedRevealPath([workspaceRoot], coworkSkill)).not.toThrow();
      expect(() => resolveAllowedRevealPath([workspaceRoot], agentSkill)).not.toThrow();

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-nope-"));
      try {
        expect(() => resolveAllowedRevealPath([workspaceRoot], path.join(outside, "secret"))).toThrow(
          "outside allowed workspace roots",
        );
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
    const agentSkillFile = path.join(home, ".agent", "skills", "other", "SKILL.md");
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
