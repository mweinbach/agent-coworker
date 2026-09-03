import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHATS_FOLDER, resolveMemoryFolderName } from "../src/advancedMemory/store";
import { hostPlatform } from "../src/platform/host";
import type { AgentConfig } from "../src/types";
import {
  assertReadPathAllowed,
  assertWritePathAllowed,
  createReadPathChecker,
} from "../src/utils/permissions";

let fixtureRoot: string;
let PROJECT: string;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(import.meta.dir, "permissions-fixture-"));
  PROJECT = path.join(fixtureRoot, "home", "user", "project");
  await fs.mkdir(PROJECT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

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

describe("credential deny casing (real filesystem)", () => {
  test("deny holds for a differently-cased spelling of an existing auth dir", async () => {
    // On case-insensitive filesystems (win32/darwin) `.COWORK/AUTH` opens the
    // same directory as `.cowork/auth`; native-realpath canonicalization must
    // resolve the true on-disk casing so the deny compare matches. On linux
    // the mixed-case spelling is a different (nonexistent) path — assert only
    // the exact-case deny there.
    // Base under the test dir (not os.tmpdir) to avoid the boundary ratchet.
    const base = await fs.mkdtemp(path.join(import.meta.dir, "perm-case-"));
    try {
      const cfg = makeConfig(base);
      const authDir = path.join(base, ".cowork", "auth");
      await fs.mkdir(authDir, { recursive: true });
      const secret = path.join(authDir, "tokens.json");
      await fs.writeFile(secret, "{}", "utf-8");

      await expect(assertReadPathAllowed(secret, cfg, "read")).rejects.toThrow(/blocked/i);
      if (hostPlatform() !== "linux") {
        const mixedCase = path.join(base, ".COWORK", "AUTH", "tokens.json");
        await expect(assertReadPathAllowed(mixedCase, cfg, "read")).rejects.toThrow(/blocked/i);
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe("assertWritePathAllowed boundaries", () => {
  // ---- Writes inside workingDirectory ---------------------------------------

  describe("allows writes inside workingDirectory", () => {
    test("file directly in workingDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "file.ts"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "file.ts")));
    });

    test("file in subdirectory of workingDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "src", "index.ts"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "src", "index.ts")));
    });

    test("deeply nested file in workingDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "a", "b", "c", "d.ts"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "a", "b", "c", "d.ts")));
    });

    test("workingDirectory root itself", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed(PROJECT, cfg, "write")).resolves.toBe(
        path.resolve(PROJECT),
      );
    });
  });

  // ---- Writes inside uploadsDirectory ---------------------------------------

  describe("allows writes inside uploadsDirectory", () => {
    test("file directly in uploadsDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "uploads", "image.png"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "uploads", "image.png")));
    });

    test("file in subdirectory of uploadsDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "uploads", "images", "photo.jpg"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "uploads", "images", "photo.jpg")));
    });

    test("uploadsDirectory root itself", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "uploads"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "uploads")));
    });

    test("uploadsDirectory outside workingDirectory is allowed", async () => {
      const cfg = makeConfig(PROJECT);
      cfg.uploadsDirectory = path.join(fixtureRoot, "uploads");
      await expect(
        assertWritePathAllowed(path.join(cfg.uploadsDirectory, "file.png"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(cfg.uploadsDirectory, "file.png")));
    });

    test("uploadsDirectory outside workingDirectory — nested file", async () => {
      const cfg = makeConfig(PROJECT);
      cfg.uploadsDirectory = path.join(fixtureRoot, "uploads");
      await expect(
        assertWritePathAllowed(
          path.join(cfg.uploadsDirectory, "sub", "deep", "image.png"),
          cfg,
          "write",
        ),
      ).resolves.toBe(path.resolve(path.join(cfg.uploadsDirectory, "sub", "deep", "image.png")));
    });

    test("denies path outside uploadsDirectory when uploadsDirectory is set externally", async () => {
      const cfg = makeConfig(PROJECT);
      cfg.uploadsDirectory = path.join(fixtureRoot, "uploads");
      await expect(
        assertWritePathAllowed(path.join(fixtureRoot, "other", "file.png"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });
  });

  // ---- Writes inside outputDirectory ----------------------------------------

  describe("allows writes inside outputDirectory", () => {
    test("file directly in outputDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "output", "result.json"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "output", "result.json")));
    });

    test("file in subdirectory of outputDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "output", "sub", "file.txt"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "output", "sub", "file.txt")));
    });

    test("outputDirectory root itself", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "output"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "output")));
    });
  });

  // ---- Writes inside projectCoworkDir parent (project root) ------------------

  describe("allows writes via projectCoworkDir parent (project root)", () => {
    test("project .cowork metadata is protected even under the project root", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, ".cowork", "config.json"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });

    test("projectCoworkDir parent matches workingDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      const projectRoot = path.dirname(cfg.projectCoworkDir);
      expect(projectRoot).toBe(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(projectRoot, "anything.ts"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(projectRoot, "anything.ts")));
    });

    test("custom projectCoworkDir allows writes in its parent", async () => {
      const cfg = makeConfig(PROJECT);
      const projectRoot = path.join(fixtureRoot, "other", "root");
      cfg.projectCoworkDir = path.join(projectRoot, ".cowork");
      await expect(
        assertWritePathAllowed(path.join(projectRoot, "file.ts"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(projectRoot, "file.ts")));
    });

    test("custom projectCoworkDir: file inside parent subdirectory", async () => {
      const cfg = makeConfig(PROJECT);
      const projectRoot = path.join(fixtureRoot, "other", "root");
      cfg.projectCoworkDir = path.join(projectRoot, ".cowork");
      await expect(
        assertWritePathAllowed(path.join(projectRoot, "src", "app.ts"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(projectRoot, "src", "app.ts")));
    });
  });

  // ---- Denies writes outside allowed directories ----------------------------

  describe("denies writes outside all allowed directories", () => {
    test("denies /etc/passwd", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed("/etc/passwd", cfg, "write")).rejects.toThrow(/blocked/i);
    });

    test("denies /tmp/random-file", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed("/tmp/random-file", cfg, "write")).rejects.toThrow(
        /blocked/i,
      );
    });

    test("denies /usr/local/bin/evil", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed("/usr/local/bin/evil", cfg, "write")).rejects.toThrow(
        /blocked/i,
      );
    });

    test("denies root level file", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed("/malicious.sh", cfg, "write")).rejects.toThrow(
        /blocked/i,
      );
    });

    test("denies file in sibling directory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "..", "other-project", "file.ts"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });

    test("denies file in parent directory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "..", "file.ts"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });
  });

  // ---- Path traversal with .. -----------------------------------------------

  describe("handles paths with .. components", () => {
    test("resolves .. that stays inside workingDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "src", "..", "file.ts"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "src", "..", "file.ts")));
    });

    test("denies .. that escapes workingDirectory", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "..", "..", "..", "etc", "passwd"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });

    test("denies single parent traversal that leaves project", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "..", "sibling", "file.ts"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });

    test(".. that resolves back into project is allowed", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "a", "b", "..", "..", "c"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "a", "b", "..", "..", "c")));
    });
  });

  // ---- Trailing slashes -----------------------------------------------------

  describe("handles trailing slashes", () => {
    test("workingDirectory with trailing slash in file path", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed(PROJECT + "/", cfg, "write")).resolves.toBe(
        path.resolve(PROJECT + "/"),
      );
    });

    test("subdirectory path with trailing slash", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "src") + "/", cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "src") + "/"));
    });
  });

  // ---- Similar path prefixes ------------------------------------------------

  describe("similar path prefixes do not grant access", () => {
    test("project vs projects (suffix s)", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(`${PROJECT}s`, "file.ts"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });

    test("project vs project-fork", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(`${PROJECT}-fork`, "file.ts"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });

    test("app vs application", async () => {
      const cfg = makeConfig(path.join(fixtureRoot, "app"));
      await expect(
        assertWritePathAllowed(path.join(fixtureRoot, "application", "file.ts"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });

    test("project vs projectX", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(`${PROJECT}X`, "secret.ts"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
    });
  });

  // ---- Boundary: exact directory level --------------------------------------

  describe("boundary cases at exact directory level", () => {
    test("file at exact workingDirectory level is allowed", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(path.join(PROJECT, "package.json"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(PROJECT, "package.json")));
    });

    test("the workingDirectory path itself is allowed", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed(PROJECT, cfg, "write")).resolves.toBe(
        path.resolve(PROJECT),
      );
    });

    test("outputDirectory path itself is allowed", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed(cfg.outputDirectory, cfg, "write")).resolves.toBe(
        path.resolve(cfg.outputDirectory),
      );
    });

    test("projectCoworkDir itself is protected metadata and blocked", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed(cfg.projectCoworkDir, cfg, "write")).rejects.toThrow(
        /blocked/i,
      );
    });
  });

  // ---- Security edge cases --------------------------------------------------

  describe("security edge cases", () => {
    test("denies absolute path /etc/shadow", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed("/etc/shadow", cfg, "write")).rejects.toThrow(/blocked/i);
    });

    test("denies /var/log/syslog", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(assertWritePathAllowed("/var/log/syslog", cfg, "write")).rejects.toThrow(
        /blocked/i,
      );
    });

    test("denies home directory of another user", async () => {
      const cfg = makeConfig(PROJECT);
      await expect(
        assertWritePathAllowed(
          path.join(fixtureRoot, "home", "other-user", ".ssh", "authorized_keys"),
          cfg,
          "write",
        ),
      ).rejects.toThrow(/blocked/i);
    });

    test("workingDirectory set to / would allow everything (root is permissive)", async () => {
      const root = path.parse(PROJECT).root;
      const cfg = makeConfig(root);
      await expect(
        assertWritePathAllowed(path.join(root, "etc", "passwd"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(root, "etc", "passwd")));
      await expect(
        assertWritePathAllowed(path.join(root, "any", "path", "at", "all"), cfg, "write"),
      ).resolves.toBe(path.resolve(path.join(root, "any", "path", "at", "all")));
    });

    test("denies symlink escapes through the assertion API", async () => {
      if (process.platform === "win32") return;

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-write-symlink-"));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-write-outside-"));
      const cfg = makeConfig(dir);

      const link = path.join(dir, "linked-outside");
      await fs.symlink(outside, link);

      await expect(
        assertWritePathAllowed(path.join(link, "pwned.txt"), cfg, "write"),
      ).rejects.toThrow(/blocked/i);
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

      await expect(assertWritePathAllowed(hook, cfg, "write")).rejects.toThrow(/read-only/i);
    });

    test("blocks editing project .cowork config metadata", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-carveout-cowork-"));
      const cfg = makeConfig(dir);
      const configPath = path.join(dir, ".cowork", "config.json");

      await expect(assertWritePathAllowed(configPath, cfg, "write")).rejects.toThrow(/blocked/i);
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

      await expect(assertWritePathAllowed(sneaky, cfg, "write")).rejects.toThrow(
        /blocked|read-only/i,
      );
    });

    test("still allows ordinary files next to protected metadata", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-carveout-allow-"));
      const cfg = makeConfig(dir);
      const ordinary = path.join(dir, "src", "index.ts");

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

describe("assertReadPathAllowed boundaries", () => {
  test("allows reads inside project roots", async () => {
    const cfg = makeConfig(PROJECT);
    await expect(
      assertReadPathAllowed(path.join(PROJECT, "src", "index.ts"), cfg, "read"),
    ).resolves.toBe(path.resolve(path.join(PROJECT, "src", "index.ts")));
    await expect(
      assertReadPathAllowed(path.join(PROJECT, "output", "result.json"), cfg, "read"),
    ).resolves.toBe(path.resolve(path.join(PROJECT, "output", "result.json")));
  });

  test("reads inside uploadsDirectory are allowed", async () => {
    const cfg = makeConfig(PROJECT);
    await expect(
      assertReadPathAllowed(path.join(PROJECT, "uploads", "file.png"), cfg, "read"),
    ).resolves.toBe(path.resolve(path.join(PROJECT, "uploads", "file.png")));
  });

  test("reads inside external uploadsDirectory are allowed", async () => {
    const cfg = makeConfig(PROJECT);
    cfg.uploadsDirectory = path.join(fixtureRoot, "uploads");
    await expect(
      assertReadPathAllowed(path.join(cfg.uploadsDirectory, "file.png"), cfg, "read"),
    ).resolves.toBe(path.resolve(path.join(cfg.uploadsDirectory, "file.png")));
  });

  test("reads inside configured global skills directory are allowed", async () => {
    const cfg = makeConfig(PROJECT);
    cfg.skillsDirs = [path.join(PROJECT, ".cowork", "skills")];
    await expect(
      assertReadPathAllowed(
        path.join(PROJECT, ".cowork", "skills", "pdf", "assets", "pdf.png"),
        cfg,
        "read",
      ),
    ).resolves.toBe(
      path.resolve(path.join(PROJECT, ".cowork", "skills", "pdf", "assets", "pdf.png")),
    );
  });

  test("advanced-memory reads include active and chats folders", async () => {
    const cfg = makeConfig(PROJECT);
    const memoriesDir = path.join(fixtureRoot, "memories");
    cfg.advancedMemory = true;
    cfg.memoriesDir = memoriesDir;
    const activeFolder = resolveMemoryFolderName(cfg);

    await expect(
      assertReadPathAllowed(path.join(memoriesDir, activeFolder, "memory.md"), cfg, "read"),
    ).resolves.toBe(path.resolve(path.join(memoriesDir, activeFolder, "memory.md")));
    await expect(
      assertReadPathAllowed(path.join(memoriesDir, CHATS_FOLDER, "memory.md"), cfg, "read"),
    ).resolves.toBe(path.resolve(path.join(memoriesDir, CHATS_FOLDER, "memory.md")));
    await expect(
      assertReadPathAllowed(path.join(memoriesDir, "other", "memory.md"), cfg, "read"),
    ).rejects.toThrow(/blocked/i);
  });

  test("denies reads outside allowed roots", async () => {
    const cfg = makeConfig(PROJECT);
    await expect(assertReadPathAllowed("/etc/passwd", cfg, "read")).rejects.toThrow(/blocked/i);
  });

  test("denies reads of the project credential directory (.cowork/auth)", async () => {
    const cfg = makeConfig(PROJECT);
    await expect(
      assertReadPathAllowed(
        path.join(PROJECT, ".cowork", "auth", "mcp-credentials.json"),
        cfg,
        "read",
      ),
    ).rejects.toThrow(/blocked/i);
    // A non-credential file elsewhere in the workspace is still readable.
    await expect(
      assertReadPathAllowed(path.join(PROJECT, "src", "index.ts"), cfg, "read"),
    ).resolves.toBe(path.resolve(path.join(PROJECT, "src", "index.ts")));
  });

  test("denies symlink escapes through the assertion API", async () => {
    if (process.platform === "win32") return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-read-symlink-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-read-outside-"));
    const cfg = makeConfig(dir);

    const link = path.join(dir, "linked-outside");
    await fs.symlink(outside, link);

    await expect(assertReadPathAllowed(path.join(link, "pwned.txt"), cfg, "read")).rejects.toThrow(
      /blocked/i,
    );
  });

  test("denies credential files reached through a workspace symlink", async () => {
    if (process.platform === "win32") return;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-sync-read-cred-symlink-"));
    const cfg = makeConfig(dir);
    const authDir = path.join(dir, ".cowork", "auth");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "token.json"), '{"token":"secret"}', "utf-8");

    const link = path.join(dir, "sneaky");
    await fs.symlink(authDir, link);

    await expect(assertReadPathAllowed(path.join(link, "token.json"), cfg, "read")).rejects.toThrow(
      /blocked/i,
    );
  });
});

describe("read permission snapshots", () => {
  test("rechecks a target when its symlink changes during an operation", async () => {
    const root = await fs.mkdtemp(path.join(fixtureRoot, "read-snapshot-target-"));
    const project = path.join(root, "project");
    const allowed = path.join(project, "allowed");
    const outside = path.join(root, "outside");
    await fs.mkdir(allowed, { recursive: true });
    await fs.mkdir(outside);
    const link = path.join(project, "link");
    const symlinkType = hostPlatform() === "win32" ? "junction" : "dir";
    await fs.symlink(allowed, link, symlinkType);
    const target = path.join(link, "file.txt");
    const assertAllowed = await createReadPathChecker(makeConfig(project), "glob");

    await expect(assertAllowed(target)).resolves.toBe(target);
    await fs.unlink(link);
    await fs.symlink(outside, link, symlinkType);
    await expect(assertAllowed(target)).rejects.toThrow(/canonical target resolves outside/i);
  });

  test("rechecks credential directories when their symlinks change during an operation", async () => {
    const project = await fs.mkdtemp(path.join(fixtureRoot, "read-snapshot-auth-"));
    const config = makeConfig(project);
    const initialAuth = path.join(project, "initial-auth");
    const replacementAuth = path.join(project, "replacement-auth");
    await fs.mkdir(config.projectCoworkDir);
    await fs.mkdir(initialAuth);
    await fs.mkdir(replacementAuth);
    const authLink = path.join(config.projectCoworkDir, "auth");
    const symlinkType = hostPlatform() === "win32" ? "junction" : "dir";
    await fs.symlink(initialAuth, authLink, symlinkType);
    const target = path.join(replacementAuth, "credentials.json");
    const assertAllowed = await createReadPathChecker(config, "read");

    await expect(assertAllowed(target)).resolves.toBe(target);
    await fs.unlink(authLink);
    await fs.symlink(replacementAuth, authLink, symlinkType);
    await expect(assertAllowed(target)).rejects.toThrow(/credential directory is not readable/i);
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
