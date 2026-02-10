import { describe, expect, test } from "bun:test";
import path from "node:path";

import type { AgentConfig } from "../src/types";
import { isWritePathAllowed } from "../src/utils/permissions";

function makeConfig(dir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-2.0-flash",
    subAgentModel: "gemini-2.0-flash",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  };
}

describe("isWritePathAllowed", () => {
  const PROJECT = process.platform === "win32" ? "C:\\home\\user\\project" : "/home/user/project";

  // ---- Writes inside workingDirectory ---------------------------------------

  describe("allows writes inside workingDirectory", () => {
    test("file directly in workingDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "file.ts"), cfg)).toBe(true);
    });

    test("file in subdirectory of workingDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "src", "index.ts"), cfg)).toBe(true);
    });

    test("deeply nested file in workingDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "a", "b", "c", "d.ts"), cfg)).toBe(true);
    });

    test("workingDirectory root itself", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(PROJECT, cfg)).toBe(true);
    });
  });

  // ---- Writes inside outputDirectory ----------------------------------------

  describe("allows writes inside outputDirectory", () => {
    test("file directly in outputDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "output", "result.json"), cfg)).toBe(true);
    });

    test("file in subdirectory of outputDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "output", "sub", "file.txt"), cfg)).toBe(true);
    });

    test("outputDirectory root itself", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "output"), cfg)).toBe(true);
    });
  });

  // ---- Writes inside projectAgentDir parent (project root) ------------------

  describe("allows writes via projectAgentDir parent (project root)", () => {
    test("file in .agent directory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, ".agent", "config.json"), cfg)).toBe(true);
    });

    test("projectAgentDir parent matches workingDirectory", () => {
      const cfg = makeConfig(PROJECT);
      const projectRoot = path.dirname(cfg.projectAgentDir);
      expect(projectRoot).toBe(PROJECT);
      expect(isWritePathAllowed(path.join(projectRoot, "anything.ts"), cfg)).toBe(true);
    });

    test("custom projectAgentDir allows writes in its parent", () => {
      const cfg = makeConfig(PROJECT);
      cfg.projectAgentDir = "/other/root/.agent";
      expect(isWritePathAllowed("/other/root/file.ts", cfg)).toBe(true);
    });

    test("custom projectAgentDir: file inside parent subdirectory", () => {
      const cfg = makeConfig(PROJECT);
      cfg.projectAgentDir = "/other/root/.agent";
      expect(isWritePathAllowed("/other/root/src/app.ts", cfg)).toBe(true);
    });
  });

  // ---- Denies writes outside allowed directories ----------------------------

  describe("denies writes outside all allowed directories", () => {
    test("denies /etc/passwd", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/etc/passwd", cfg)).toBe(false);
    });

    test("denies /tmp/random-file", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/tmp/random-file", cfg)).toBe(false);
    });

    test("denies /usr/local/bin/evil", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/usr/local/bin/evil", cfg)).toBe(false);
    });

    test("denies root level file", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/malicious.sh", cfg)).toBe(false);
    });

    test("denies file in sibling directory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/home/user/other-project/file.ts", cfg)).toBe(false);
    });

    test("denies file in parent directory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/home/user/file.ts", cfg)).toBe(false);
    });
  });

  // ---- Path traversal with .. -----------------------------------------------

  describe("handles paths with .. components", () => {
    test("resolves .. that stays inside workingDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "src", "..", "file.ts"), cfg)).toBe(true);
    });

    test("denies .. that escapes workingDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "..", "..", "..", "etc", "passwd"), cfg)).toBe(false);
    });

    test("denies single parent traversal that leaves project", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "..", "sibling", "file.ts"), cfg)).toBe(false);
    });

    test(".. that resolves back into project is allowed", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "a", "b", "..", "..", "c"), cfg)).toBe(true);
    });
  });

  // ---- Trailing slashes -----------------------------------------------------

  describe("handles trailing slashes", () => {
    test("workingDirectory with trailing slash in file path", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(PROJECT + "/", cfg)).toBe(true);
    });

    test("subdirectory path with trailing slash", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "src") + "/", cfg)).toBe(true);
    });
  });

  // ---- Similar path prefixes ------------------------------------------------

  describe("similar path prefixes do not grant access", () => {
    test("/home/user/project vs /home/user/projects (suffix s)", () => {
      const cfg = makeConfig("/home/user/project");
      expect(isWritePathAllowed("/home/user/projects/file.ts", cfg)).toBe(false);
    });

    test("/home/user/project vs /home/user/project-fork", () => {
      const cfg = makeConfig("/home/user/project");
      expect(isWritePathAllowed("/home/user/project-fork/file.ts", cfg)).toBe(false);
    });

    test("/app vs /application", () => {
      const cfg = makeConfig("/app");
      expect(isWritePathAllowed("/application/file.ts", cfg)).toBe(false);
    });

    test("/home/user/project vs /home/user/projectX", () => {
      const cfg = makeConfig("/home/user/project");
      expect(isWritePathAllowed("/home/user/projectX/secret.ts", cfg)).toBe(false);
    });
  });

  // ---- Boundary: exact directory level --------------------------------------

  describe("boundary cases at exact directory level", () => {
    test("file at exact workingDirectory level is allowed", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "package.json"), cfg)).toBe(true);
    });

    test("the workingDirectory path itself is allowed", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(PROJECT, cfg)).toBe(true);
    });

    test("outputDirectory path itself is allowed", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(cfg.outputDirectory, cfg)).toBe(true);
    });

    test("projectAgentDir itself is inside its parent and allowed", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(cfg.projectAgentDir, cfg)).toBe(true);
    });
  });

  // ---- Security edge cases --------------------------------------------------

  describe("security edge cases", () => {
    test("denies absolute path /etc/shadow", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/etc/shadow", cfg)).toBe(false);
    });

    test("denies /var/log/syslog", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/var/log/syslog", cfg)).toBe(false);
    });

    test("denies home directory of another user", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed("/home/other-user/.ssh/authorized_keys", cfg)).toBe(false);
    });

    test("workingDirectory set to / would allow everything (root is permissive)", () => {
      const root = process.platform === "win32" ? path.parse(PROJECT).root : "/";
      const cfg = makeConfig(root);
      expect(isWritePathAllowed(path.join(root, "etc", "passwd"), cfg)).toBe(true);
      expect(isWritePathAllowed(path.join(root, "any", "path", "at", "all"), cfg)).toBe(true);
    });
  });
});
