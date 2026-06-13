import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CHATS_FOLDER, resolveMemoryFolderName } from "../src/advancedMemory/store";
import type { AgentConfig } from "../src/types";
import {
  assertReadPathAllowed,
  assertWritePathAllowed,
  isReadPathAllowed,
  isWritePathAllowed,
} from "../src/utils/permissions";

function makeConfig(dir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir: path.join(dir, ".agent-user"),
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

  // ---- Writes inside uploadsDirectory ---------------------------------------

  describe("allows writes inside uploadsDirectory", () => {
    test("file directly in uploadsDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "uploads", "image.png"), cfg)).toBe(true);
    });

    test("file in subdirectory of uploadsDirectory", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "uploads", "images", "photo.jpg"), cfg)).toBe(
        true,
      );
    });

    test("uploadsDirectory root itself", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, "uploads"), cfg)).toBe(true);
    });

    test("uploadsDirectory outside workingDirectory is allowed", () => {
      const cfg = makeConfig(PROJECT);
      cfg.uploadsDirectory = "/var/uploads";
      expect(isWritePathAllowed("/var/uploads/file.png", cfg)).toBe(true);
    });

    test("uploadsDirectory outside workingDirectory — nested file", () => {
      const cfg = makeConfig(PROJECT);
      cfg.uploadsDirectory = "/var/uploads";
      expect(isWritePathAllowed("/var/uploads/sub/deep/image.png", cfg)).toBe(true);
    });

    test("denies path outside uploadsDirectory when uploadsDirectory is set externally", () => {
      const cfg = makeConfig(PROJECT);
      cfg.uploadsDirectory = "/var/uploads";
      // /var/other is not inside /var/uploads
      expect(isWritePathAllowed("/var/other/file.png", cfg)).toBe(false);
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

  // ---- Writes inside projectCoworkDir parent (project root) ------------------

  describe("allows writes via projectCoworkDir parent (project root)", () => {
    test("project .cowork metadata is protected even under the project root", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(path.join(PROJECT, ".cowork", "config.json"), cfg)).toBe(false);
    });

    test("projectCoworkDir parent matches workingDirectory", () => {
      const cfg = makeConfig(PROJECT);
      const projectRoot = path.dirname(cfg.projectCoworkDir);
      expect(projectRoot).toBe(PROJECT);
      expect(isWritePathAllowed(path.join(projectRoot, "anything.ts"), cfg)).toBe(true);
    });

    test("custom projectCoworkDir allows writes in its parent", () => {
      const cfg = makeConfig(PROJECT);
      cfg.projectCoworkDir = "/other/root/.cowork";
      expect(isWritePathAllowed("/other/root/file.ts", cfg)).toBe(true);
    });

    test("custom projectCoworkDir: file inside parent subdirectory", () => {
      const cfg = makeConfig(PROJECT);
      cfg.projectCoworkDir = "/other/root/.cowork";
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
      expect(isWritePathAllowed(path.join(PROJECT, "..", "..", "..", "etc", "passwd"), cfg)).toBe(
        false,
      );
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

    test("projectCoworkDir itself is protected metadata and blocked", () => {
      const cfg = makeConfig(PROJECT);
      expect(isWritePathAllowed(cfg.projectCoworkDir, cfg)).toBe(false);
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

    test("denies symlink escapes in the sync helper", async () => {
      if (process.platform === "win32") return;

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-write-symlink-"));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-write-outside-"));
      const cfg = makeConfig(dir);

      const link = path.join(dir, "linked-outside");
      await fs.symlink(outside, link);

      expect(isWritePathAllowed(path.join(link, "pwned.txt"), cfg)).toBe(false);
    });
  });
});

describe("assertWritePathAllowed", () => {
  test("allows a regular path inside workingDirectory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-allow-"));
    const cfg = makeConfig(dir);
    const target = path.join(dir, "src", "file.txt");
    await expect(assertWritePathAllowed(target, cfg, "write")).resolves.toBe(path.resolve(target));
  });

  test("allows advanced-memory writes only inside the active folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adv-mem-write-"));
    const memoryHome = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adv-mem-home-"));
    const memoriesDir = path.join(memoryHome, "memories");
    const cfg = makeConfig(dir);
    cfg.advancedMemory = true;
    cfg.memoriesDir = memoriesDir;
    const activeFolder = resolveMemoryFolderName(cfg);
    const activeFile = path.join(memoriesDir, activeFolder, "memory.md");
    const chatsFile = path.join(memoriesDir, CHATS_FOLDER, "memory.md");
    const siblingFile = path.join(memoriesDir, "other-project", "memory.md");

    expect(isWritePathAllowed(activeFile, cfg)).toBe(true);
    expect(isWritePathAllowed(chatsFile, cfg)).toBe(false);
    expect(isWritePathAllowed(siblingFile, cfg)).toBe(false);
    await expect(assertWritePathAllowed(activeFile, cfg, "write")).resolves.toBe(
      path.resolve(activeFile),
    );
    await expect(assertWritePathAllowed(chatsFile, cfg, "write")).rejects.toThrow(/blocked/i);
    await expect(assertWritePathAllowed(siblingFile, cfg, "write")).rejects.toThrow(/blocked/i);
  });

  describe("protected project metadata carve-out (.git/.cowork)", () => {
    test("blocks writing a .git hook even though it is under the project root", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-carveout-git-"));
      const cfg = makeConfig(dir);
      await fs.mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
      const hook = path.join(dir, ".git", "hooks", "pre-commit");

      expect(isWritePathAllowed(hook, cfg)).toBe(false);
      await expect(assertWritePathAllowed(hook, cfg, "write")).rejects.toThrow(/read-only/i);
    });

    test("blocks editing project .cowork config metadata", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-carveout-cowork-"));
      const cfg = makeConfig(dir);
      const configPath = path.join(dir, ".cowork", "config.json");

      expect(isWritePathAllowed(configPath, cfg)).toBe(false);
      await expect(assertWritePathAllowed(configPath, cfg, "edit")).rejects.toThrow(/read-only/i);
    });

    test("blocks a symlink whose canonical target lands in .git", async () => {
      if (process.platform === "win32") return;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-carveout-symlink-"));
      const cfg = makeConfig(dir);
      await fs.mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
      // An innocuously named in-project dir that actually points at .git.
      await fs.symlink(path.join(dir, ".git"), path.join(dir, "tools-link"));
      const sneaky = path.join(dir, "tools-link", "hooks", "post-checkout");

      expect(isWritePathAllowed(sneaky, cfg)).toBe(false);
      await expect(assertWritePathAllowed(sneaky, cfg, "write")).rejects.toThrow(
        /blocked|read-only/i,
      );
    });

    test("still allows ordinary files next to protected metadata", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-carveout-allow-"));
      const cfg = makeConfig(dir);
      const ordinary = path.join(dir, "src", "index.ts");

      expect(isWritePathAllowed(ordinary, cfg)).toBe(true);
      await expect(assertWritePathAllowed(ordinary, cfg, "write")).resolves.toBe(
        path.resolve(ordinary),
      );
    });
  });

  test("targetPath-scoped children cannot write the active memory folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adv-mem-scoped-"));
    const memoryHome = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adv-mem-scoped-home-"));
    const memoriesDir = path.join(memoryHome, "memories");
    const cfg = makeConfig(dir);
    cfg.advancedMemory = true;
    cfg.memoriesDir = memoriesDir;
    const activeFile = path.join(memoriesDir, resolveMemoryFolderName(cfg), "memory.md");
    const targetPaths = [path.join(dir, "src")];

    await expect(assertWritePathAllowed(activeFile, cfg, "write", targetPaths)).rejects.toThrow(
      /targetPaths/,
    );
  });

  test("rejects symlink segment escapes", async () => {
    if (process.platform === "win32") return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "perm-outside-"));
    const cfg = makeConfig(dir);

    const link = path.join(dir, "linked-outside");
    await fs.symlink(outside, link);

    await expect(
      assertWritePathAllowed(path.join(link, "pwned.txt"), cfg, "write"),
    ).rejects.toThrow(/blocked/i);
  });

  test("allows a regular path inside uploadsDirectory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-uploads-allow-"));
    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-uploads-ext-"));
    const cfg = makeConfig(dir);
    cfg.uploadsDirectory = uploadsDir;

    const target = path.join(uploadsDir, "image.png");
    await expect(assertWritePathAllowed(target, cfg, "write")).resolves.toBe(path.resolve(target));
  });

  test("rejects symlink escape through uploadsDirectory", async () => {
    if (process.platform === "win32") return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-uploads-sym-"));
    const uploadsDir = path.join(dir, "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "perm-uploads-outside-"));

    const cfg = makeConfig(dir);
    cfg.uploadsDirectory = uploadsDir;

    const link = path.join(uploadsDir, "escape");
    await fs.symlink(outside, link);

    await expect(
      assertWritePathAllowed(path.join(link, "pwned.txt"), cfg, "write"),
    ).rejects.toThrow(/blocked/i);
  });
});

describe("isReadPathAllowed", () => {
  const PROJECT = process.platform === "win32" ? "C:\\home\\user\\project" : "/home/user/project";

  test("allows reads inside project roots", () => {
    const cfg = makeConfig(PROJECT);
    expect(isReadPathAllowed(path.join(PROJECT, "src", "index.ts"), cfg)).toBe(true);
    expect(isReadPathAllowed(path.join(PROJECT, "output", "result.json"), cfg)).toBe(true);
  });

  test("reads inside uploadsDirectory are allowed", () => {
    const cfg = makeConfig(PROJECT);
    expect(isReadPathAllowed(path.join(PROJECT, "uploads", "file.png"), cfg)).toBe(true);
  });

  test("reads inside external uploadsDirectory are allowed", () => {
    const cfg = makeConfig(PROJECT);
    cfg.uploadsDirectory = "/var/uploads";
    expect(isReadPathAllowed("/var/uploads/file.png", cfg)).toBe(true);
  });

  test("reads inside configured global skills directory are allowed", () => {
    const cfg = makeConfig(PROJECT);
    cfg.skillsDirs = [path.join(PROJECT, ".cowork", "skills")];
    expect(
      isReadPathAllowed(path.join(PROJECT, ".cowork", "skills", "pdf", "assets", "pdf.png"), cfg),
    ).toBe(true);
  });

  test("advanced-memory reads include active and chats folders", () => {
    const cfg = makeConfig(PROJECT);
    const memoriesDir =
      process.platform === "win32" ? "C:\\cowork-memory-home" : "/cowork-memory-home";
    cfg.advancedMemory = true;
    cfg.memoriesDir = memoriesDir;
    const activeFolder = resolveMemoryFolderName(cfg);

    expect(isReadPathAllowed(path.join(memoriesDir, activeFolder, "memory.md"), cfg)).toBe(true);
    expect(isReadPathAllowed(path.join(memoriesDir, CHATS_FOLDER, "memory.md"), cfg)).toBe(true);
    expect(isReadPathAllowed(path.join(memoriesDir, "other", "memory.md"), cfg)).toBe(false);
  });

  test("denies reads outside allowed roots", () => {
    const cfg = makeConfig(PROJECT);
    expect(isReadPathAllowed("/etc/passwd", cfg)).toBe(false);
  });

  test("denies reads of the project credential directory (.cowork/auth)", () => {
    const cfg = makeConfig(PROJECT);
    expect(
      isReadPathAllowed(path.join(PROJECT, ".cowork", "auth", "mcp-credentials.json"), cfg),
    ).toBe(false);
    // A non-credential file elsewhere in the workspace is still readable.
    expect(isReadPathAllowed(path.join(PROJECT, "src", "index.ts"), cfg)).toBe(true);
  });

  test("denies symlink escapes in the sync helper", async () => {
    if (process.platform === "win32") return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-read-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-read-outside-"));
    const cfg = makeConfig(dir);

    const link = path.join(dir, "linked-outside");
    await fs.symlink(outside, link);

    expect(isReadPathAllowed(path.join(link, "pwned.txt"), cfg)).toBe(false);
  });

  test("denies credential files reached through a workspace symlink in the sync helper", async () => {
    if (process.platform === "win32") return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-read-cred-symlink-"));
    const cfg = makeConfig(dir);
    const authDir = path.join(dir, ".cowork", "auth");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "token.json"), '{"token":"secret"}', "utf-8");

    const link = path.join(dir, "sneaky");
    await fs.symlink(authDir, link);

    expect(isReadPathAllowed(path.join(link, "token.json"), cfg)).toBe(false);
  });
});

describe("assertReadPathAllowed", () => {
  test("allows a regular path inside workingDirectory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-allow-"));
    const cfg = makeConfig(dir);
    const target = path.join(dir, "src", "file.txt");
    await expect(assertReadPathAllowed(target, cfg, "read")).resolves.toBe(path.resolve(target));
  });

  test("rejects reading a project credential file even though it sits in the workspace", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-cred-read-"));
    const cfg = makeConfig(dir);
    const credFile = path.join(dir, ".cowork", "auth", "mcp-credentials.json");
    await fs.mkdir(path.dirname(credFile), { recursive: true });
    await fs.writeFile(credFile, JSON.stringify({ token: "secret" }), "utf-8");
    await expect(assertReadPathAllowed(credFile, cfg, "read")).rejects.toThrow(
      /credential directory is not readable/i,
    );
  });

  test("rejects reading a credential file through a workspace symlink", async () => {
    if (process.platform === "win32") return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-cred-symlink-"));
    const cfg = makeConfig(dir);
    const authDir = path.join(dir, ".cowork", "auth");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "mcp-credentials.json"), '{"token":"secret"}', "utf-8");

    // A symlink inside the workspace pointing at the credential dir must not be a
    // way around the deny list — even when the workspace path itself is symlinked
    // (e.g. macOS /var -> /private/var), where the logical deny dir would not
    // prefix-match the canonical target.
    const link = path.join(dir, "sneaky");
    await fs.symlink(authDir, link);

    await expect(
      assertReadPathAllowed(path.join(link, "mcp-credentials.json"), cfg, "read"),
    ).rejects.toThrow(/credential directory is not readable/i);
  });

  test("allows advanced-memory reads from active and chats folders only", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adv-mem-read-"));
    const memoryHome = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adv-mem-read-home-"));
    const memoriesDir = path.join(memoryHome, "memories");
    const cfg = makeConfig(dir);
    cfg.advancedMemory = true;
    cfg.memoriesDir = memoriesDir;
    const activeFolder = resolveMemoryFolderName(cfg);
    const activeFile = path.join(memoriesDir, activeFolder, "memory.md");
    const chatsFile = path.join(memoriesDir, CHATS_FOLDER, "memory.md");
    const siblingFile = path.join(memoriesDir, "other-project", "memory.md");

    await expect(assertReadPathAllowed(activeFile, cfg, "read")).resolves.toBe(
      path.resolve(activeFile),
    );
    await expect(assertReadPathAllowed(chatsFile, cfg, "read")).resolves.toBe(
      path.resolve(chatsFile),
    );
    await expect(assertReadPathAllowed(siblingFile, cfg, "read")).rejects.toThrow(/blocked/i);
  });

  test("rejects symlink segment escapes", async () => {
    if (process.platform === "win32") return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-outside-"));
    const cfg = makeConfig(dir);

    const link = path.join(dir, "linked-outside");
    await fs.symlink(outside, link);

    await expect(assertReadPathAllowed(path.join(link, "pwned.txt"), cfg, "read")).rejects.toThrow(
      /blocked/i,
    );
  });

  test("allows a path inside configured skillsDirs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-skills-"));
    const cfg = makeConfig(dir);
    const skillsDir = path.join(dir, ".cowork", "skills");
    cfg.skillsDirs = [skillsDir];
    const target = path.join(skillsDir, "slides", "references", "example.md");

    await expect(assertReadPathAllowed(target, cfg, "read")).resolves.toBe(path.resolve(target));
  });

  test("a scoped child can still read global skills outside its targetPaths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-scoped-skills-"));
    // Global skills live under ~/.cowork/skills — a separate home, OUTSIDE the
    // project write roots (not nested under the workspace).
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-scoped-home-"));
    const cfg = makeConfig(dir);
    const globalSkillsDir = path.join(home, ".cowork", "skills");
    cfg.skillsDirs = [path.join(dir, ".cowork", "skills"), globalSkillsDir];
    const skillFile = path.join(globalSkillsDir, "pdf", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, "skill-body", "utf-8");
    // The child is scoped to a single subdir of the project.
    const targetPaths = [path.join(dir, "src", "auth")];

    // Reads outside the project write roots (e.g. global skills) are not
    // constrained by targetPaths, so a scoped child can still load them.
    await expect(assertReadPathAllowed(skillFile, cfg, "read", targetPaths)).resolves.toBe(
      path.resolve(skillFile),
    );

    // But a project file outside the child's targetPaths stays blocked.
    await expect(
      assertReadPathAllowed(path.join(dir, "src", "other", "secret.ts"), cfg, "read", targetPaths),
    ).rejects.toThrow(/targetPaths/);
  });

  test("allows reads inside the user plugins dir (~/.cowork/plugins)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-user-plugins-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-user-plugins-home-"));
    const cfg = makeConfig(dir);
    // ~/.cowork/plugins is an explicit read root (config.userPluginsDir).
    cfg.userPluginsDir = path.join(home, ".cowork", "plugins");
    const target = path.join(cfg.userPluginsDir, "figma-toolkit", "README.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "plugin readme", "utf-8");

    await expect(assertReadPathAllowed(target, cfg, "read")).resolves.toBe(path.resolve(target));
  });

  test("a scoped child can still read the user plugins dir outside its targetPaths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-scoped-plugins-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-scoped-plugins-home-"));
    const cfg = makeConfig(dir);
    cfg.userPluginsDir = path.join(home, ".cowork", "plugins");
    const target = path.join(cfg.userPluginsDir, "figma-toolkit", "README.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "plugin readme", "utf-8");
    const targetPaths = [path.join(dir, "src", "auth")];

    await expect(assertReadPathAllowed(target, cfg, "read", targetPaths)).resolves.toBe(
      path.resolve(target),
    );
  });

  test("allows reads from bundled plugin skill directories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-read-plugin-roots-"));
    const cfg = makeConfig(dir);
    const pluginRoot = path.join(dir, ".agents", "plugins", "figma-toolkit");
    const bundledSkillsDir = path.join(pluginRoot, "skills");
    const target = path.join(bundledSkillsDir, "import-frame", "SKILL.md");

    cfg.workspacePluginsDir = path.join(dir, ".agents", "plugins");

    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: "figma-toolkit",
          description: "Figma plugin",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      target,
      "---\nname: import-frame\ndescription: Import a frame\n---\n",
      "utf-8",
    );

    await expect(assertReadPathAllowed(target, cfg, "read")).resolves.toBe(path.resolve(target));
  });
});
