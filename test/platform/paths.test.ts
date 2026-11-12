import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hostPlatform } from "../../src/platform/host";
import {
  canonicalize,
  canonicalizeSync,
  coworkHome,
  coworkPaths,
  crossesProtectedMetadata,
  findGitRootSync,
  fsCaseSensitivity,
  home,
  isInside,
  normalizeGlobPattern,
  PROTECTED_METADATA_DIR_NAMES,
  toPosixRelative,
  validateFileName,
} from "../../src/platform/paths";
import { PROTECTED_METADATA_DIR_NAMES as UTILS_PROTECTED_METADATA_DIR_NAMES } from "../../src/utils/paths";

const PLATFORMS: NodeJS.Platform[] = ["win32", "darwin", "linux"];
const identity = (p: string) => p;
const NUL = String.fromCharCode(0);
const UNIT_SEPARATOR = String.fromCharCode(31);

let tmpDir: string;
let realTmp: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-paths-test-"));
  realTmp = fs.realpathSync.native(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function symlinkOrJunction(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, hostPlatform() === "win32" ? "junction" : "dir");
}

function hostFsIsCaseInsensitive(): boolean {
  const probe = path.join(realTmp, "CaseProbeDir");
  fs.mkdirSync(probe);
  return fs.existsSync(path.join(realTmp, "caseprobedir"));
}

describe("fsCaseSensitivity", () => {
  test("win32 is insensitive", () => {
    expect(fsCaseSensitivity("win32")).toBe("insensitive");
  });
  test("darwin is insensitive (default APFS)", () => {
    expect(fsCaseSensitivity("darwin")).toBe("insensitive");
  });
  test("linux is sensitive", () => {
    expect(fsCaseSensitivity("linux")).toBe("sensitive");
  });
  test("other platforms are sensitive", () => {
    expect(fsCaseSensitivity("freebsd")).toBe("sensitive");
  });
  test("defaults to the host platform", () => {
    expect(fsCaseSensitivity()).toBe(fsCaseSensitivity(hostPlatform()));
  });
});

describe("canonicalizeSync / canonicalize", () => {
  test("resolves an existing path via the native realpath engine", () => {
    expect(canonicalizeSync(tmpDir)).toBe(fs.realpathSync.native(tmpDir));
  });

  test("re-appends a not-yet-existing suffix onto the canonical existing prefix", () => {
    const target = path.join(tmpDir, "missing", "deeper", "file.txt");
    expect(canonicalizeSync(target)).toBe(path.join(realTmp, "missing", "deeper", "file.txt"));
  });

  test("preserves the given casing of a not-yet-existing suffix", () => {
    const target = path.join(tmpDir, "MixedCase", "File.TXT");
    expect(canonicalizeSync(target)).toBe(path.join(realTmp, "MixedCase", "File.TXT"));
  });

  test("resolves symlinks/junctions in the existing prefix", () => {
    const targetDir = path.join(realTmp, "target");
    fs.mkdirSync(targetDir);
    const link = path.join(realTmp, "link");
    symlinkOrJunction(targetDir, link);
    expect(canonicalizeSync(link)).toBe(targetDir);
    expect(canonicalizeSync(path.join(link, "missing.txt"))).toBe(
      path.join(targetDir, "missing.txt"),
    );
  });

  test("async canonicalize wraps the sync engine and string-matches it exactly", async () => {
    const existing = tmpDir;
    const missing = path.join(tmpDir, "no", "such", "Path.txt");
    expect(await canonicalize(existing)).toBe(canonicalizeSync(existing));
    expect(await canonicalize(missing)).toBe(canonicalizeSync(missing));
  });
});

describe("isInside (lexical branches, injected canonicalizer)", () => {
  test("posix basics", () => {
    const opts = { platform: "linux" as const, canonicalize: identity };
    expect(isInside("/a", "/a/b", opts)).toBe(true);
    expect(isInside("/a", "/a/b/c", opts)).toBe(true);
    expect(isInside("/a", "/ab", opts)).toBe(false);
    expect(isInside("/a", "/b", opts)).toBe(false);
    expect(isInside("/a/b", "/a", opts)).toBe(false);
    expect(isInside("/a", "/a/..foo", opts)).toBe(true);
  });

  test("equality honors allowEqual (default true)", () => {
    for (const platform of PLATFORMS) {
      expect(isInside("/a", "/a", { platform, canonicalize: identity })).toBe(true);
      expect(isInside("/a", "/a", { platform, canonicalize: identity, allowEqual: false })).toBe(
        false,
      );
    }
  });

  test("win32 folds case (always case-insensitive)", () => {
    const opts = { platform: "win32" as const, canonicalize: identity };
    expect(isInside("C:\\a", "C:\\A\\b", opts)).toBe(true);
    expect(isInside("C:\\A", "c:\\a\\B\\c", opts)).toBe(true);
    expect(isInside("C:\\a", "C:\\ab", opts)).toBe(false);
  });

  test("win32 drive and UNC crossings are always outside", () => {
    const opts = { platform: "win32" as const, canonicalize: identity };
    expect(isInside("C:\\a", "D:\\a\\b", opts)).toBe(false);
    expect(isInside("\\\\srv\\share", "\\\\srv\\share\\x", opts)).toBe(true);
    expect(isInside("\\\\srv\\share", "\\\\other\\share\\x", opts)).toBe(false);
  });

  test("darwin does NOT case-fold (accept-side fail direction)", () => {
    const opts = { platform: "darwin" as const, canonicalize: identity };
    expect(isInside("/a", "/A/b", opts)).toBe(false);
    expect(isInside("/a", "/a/b", opts)).toBe(true);
  });

  test("linux does not case-fold", () => {
    const opts = { platform: "linux" as const, canonicalize: identity };
    expect(isInside("/a", "/A/b", opts)).toBe(false);
  });
});

describe("isInside (real filesystem canonicalization)", () => {
  test("case difference in a not-yet-existing suffix folds only on win32", () => {
    const parent = path.join(tmpDir, "missing");
    const child = path.join(tmpDir, "MISSING", "x");
    expect(isInside(parent, child, { platform: "win32" })).toBe(true);
    expect(isInside(parent, child, { platform: "darwin" })).toBe(false);
    expect(isInside(parent, child, { platform: "linux" })).toBe(false);
  });

  test("a symlink/junction escaping the root is detected as outside", () => {
    const rootDir = path.join(realTmp, "root");
    const outside = path.join(realTmp, "outside");
    fs.mkdirSync(rootDir);
    fs.mkdirSync(outside);
    symlinkOrJunction(outside, path.join(rootDir, "link"));
    const escapee = path.join(rootDir, "link", "escape.txt");
    expect(isInside(rootDir, escapee)).toBe(false);
    expect(isInside(realTmp, escapee)).toBe(true);
  });
});

describe("crossesProtectedMetadata", () => {
  test("exact-case .git/.cowork segments are caught on every platform", () => {
    expect(crossesProtectedMetadata("/repo", "/repo/.git/hooks/pre-commit", "linux")).toBe(true);
    expect(crossesProtectedMetadata("/repo", "/repo/.cowork/config.json", "darwin")).toBe(true);
    expect(crossesProtectedMetadata("C:\\repo", "C:\\repo\\.git\\hooks", "win32")).toBe(true);
    expect(crossesProtectedMetadata("C:\\repo", "C:\\repo\\.cowork\\skills\\x", "win32")).toBe(
      true,
    );
  });

  test("case variants fold on win32 AND darwin (deny-side), not on linux", () => {
    expect(crossesProtectedMetadata("C:\\repo", "C:\\repo\\.GIT\\hooks", "win32")).toBe(true);
    expect(crossesProtectedMetadata("/repo", "/repo/.GIT/hooks", "darwin")).toBe(true);
    expect(crossesProtectedMetadata("/repo", "/repo/.Cowork/config.json", "darwin")).toBe(true);
    expect(crossesProtectedMetadata("/repo", "/repo/.GIT/hooks", "linux")).toBe(false);
    expect(crossesProtectedMetadata("/repo", "/repo/.Cowork/x", "linux")).toBe(false);
  });

  test("nested metadata segments are caught", () => {
    for (const platform of PLATFORMS) {
      expect(crossesProtectedMetadata("/repo", "/repo/sub/dir/.git/config", platform)).toBe(true);
    }
  });

  test("similar-but-different names never match", () => {
    for (const platform of PLATFORMS) {
      expect(crossesProtectedMetadata("/repo", "/repo/.gitignore", platform)).toBe(false);
      expect(crossesProtectedMetadata("/repo", "/repo/.github/workflows/ci.yml", platform)).toBe(
        false,
      );
      expect(crossesProtectedMetadata("/repo", "/repo/.coworkspace/x", platform)).toBe(false);
    }
  });

  test("the base itself, and targets outside the base, do not cross", () => {
    for (const platform of PLATFORMS) {
      expect(crossesProtectedMetadata("/repo", "/repo", platform)).toBe(false);
      expect(crossesProtectedMetadata("/repo", "/elsewhere/.git/x", platform)).toBe(false);
      expect(crossesProtectedMetadata("/repo/sub", "/repo/.git/x", platform)).toBe(false);
    }
  });

  test("a workspace living UNDER a .cowork ancestor is not flagged", () => {
    const base = "/home/u/.cowork/chats/abc";
    expect(crossesProtectedMetadata(base, `${base}/notes.md`, "darwin")).toBe(false);
    expect(
      crossesProtectedMetadata(
        "C:\\Users\\u\\.cowork\\chats\\abc",
        "C:\\Users\\u\\.cowork\\chats\\abc\\notes.md",
        "win32",
      ),
    ).toBe(false);
  });

  test("mixed separators on win32 are handled", () => {
    expect(crossesProtectedMetadata("C:/repo", "C:/repo/.git/hooks", "win32")).toBe(true);
  });

  test("PROTECTED_METADATA_DIR_NAMES is re-exported from the single source", () => {
    expect(PROTECTED_METADATA_DIR_NAMES).toEqual([".git", ".cowork"]);
    expect(PROTECTED_METADATA_DIR_NAMES).toBe(UTILS_PROTECTED_METADATA_DIR_NAMES);
  });
});

describe("home / coworkHome / coworkPaths", () => {
  test("defaults to os.homedir() when no override is present", () => {
    expect(home({})).toBe(os.homedir());
    expect(home({ HOME: "/somewhere/else" }, "linux")).toBe("/somewhere/else");
    expect(home({ HOME: "/somewhere/else" }, "darwin")).toBe("/somewhere/else");
    expect(home({ HOME: "C:\\git-bash-home" }, "win32")).toBe(os.homedir());
  });

  test("COWORK_HOME_OVERRIDE is the only lever and is resolved", () => {
    expect(home({ COWORK_HOME_OVERRIDE: realTmp })).toBe(path.resolve(realTmp));
    expect(home({ COWORK_HOME_OVERRIDE: "/srv/cowork/../agent" }, "linux")).toBe("/srv/agent");
    expect(home({ COWORK_HOME_OVERRIDE: "C:/cowork/../agent" }, "win32")).toBe("C:\\agent");
    expect(home({ COWORK_HOME_OVERRIDE: "   " })).toBe(os.homedir());
    expect(home({ COWORK_HOME_OVERRIDE: "" })).toBe(os.homedir());
  });

  test("coworkHome joins .cowork under home", () => {
    expect(coworkHome({ COWORK_HOME_OVERRIDE: realTmp })).toBe(path.join(realTmp, ".cowork"));
    expect(coworkHome({})).toBe(path.join(os.homedir(), ".cowork"));
  });

  test("coworkPaths lays out the canonical ~/.cowork tree", () => {
    const paths = coworkPaths({ COWORK_HOME_OVERRIDE: realTmp });
    const root = path.join(realTmp, ".cowork");
    expect(paths).toEqual({
      root,
      authDir: path.join(root, "auth"),
      codexAuthDir: path.join(root, "auth", "codex-cli"),
      runtimeDir: path.join(root, "runtime"),
      binDir: path.join(root, "bin"),
      skillsDir: path.join(root, "skills"),
      chatsDir: path.join(root, "chats"),
      configDir: path.join(root, "config"),
    });
  });
});

describe("validateFileName", () => {
  test("accepts ordinary portable names", () => {
    for (const name of [
      "report.pdf",
      "a",
      ".gitignore",
      ".git",
      "com0",
      "com10",
      "console.log",
      "nullable.ts",
      "lpt",
      "Ünïcode näme",
      "a".repeat(255),
    ]) {
      expect(validateFileName(name)).toEqual({ ok: true });
    }
  });

  test("rejects empty and dot-segment names", () => {
    expect(validateFileName("").ok).toBe(false);
    expect(validateFileName(".").ok).toBe(false);
    expect(validateFileName("..").ok).toBe(false);
  });

  test("rejects both separator families and NUL/control chars on ALL platforms", () => {
    for (const name of ["a/b", "a\\b", `a${NUL}b`, `a${UNIT_SEPARATOR}b`]) {
      expect(validateFileName(name).ok).toBe(false);
    }
  });

  test('rejects the win32-invalid set <>:"|?* everywhere (":" also blocks NTFS ADS)', () => {
    for (const name of ["a:b", "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b"]) {
      expect(validateFileName(name).ok).toBe(false);
    }
  });

  test("rejects trailing dots and spaces", () => {
    for (const name of ["name.", "name ", "name.. ", "name . "]) {
      expect(validateFileName(name).ok).toBe(false);
    }
  });

  test("rejects reserved device names, case-insensitively, with or without extension", () => {
    for (const name of [
      "CON",
      "con",
      "Con.txt",
      "PRN",
      "aux",
      "NUL.log",
      "com1",
      "COM9.tar.gz",
      "lpt5",
      "LPT9",
    ]) {
      expect(validateFileName(name)).toEqual({ ok: false, reason: "reserved device name" });
    }
  });

  test("rejects names over 255 characters", () => {
    expect(validateFileName("a".repeat(256)).ok).toBe(false);
  });
});

describe("normalizeGlobPattern", () => {
  test("win32: backslashes are separators and always become slashes", () => {
    expect(normalizeGlobPattern("src\\*.ts", "win32")).toBe("src/*.ts");
    expect(normalizeGlobPattern("C:\\a\\**", "win32")).toBe("C:/a/**");
    expect(normalizeGlobPattern("src/*.ts", "win32")).toBe("src/*.ts");
    expect(normalizeGlobPattern("\\*", "win32")).toBe("/*");
  });

  test("posix platforms: plain patterns keep fast-glob escapes intact", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      expect(normalizeGlobPattern("src\\*.ts", platform)).toBe("src\\*.ts");
      expect(normalizeGlobPattern("\\*", platform)).toBe("\\*");
      expect(normalizeGlobPattern("a\\{b,c\\}", platform)).toBe("a\\{b,c\\}");
      expect(normalizeGlobPattern("src/**/*.ts", platform)).toBe("src/**/*.ts");
    }
  });

  test("posix platforms: win32-SHAPED patterns are still converted", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      expect(normalizeGlobPattern("C:\\a\\**", platform)).toBe("C:/a/**");
      expect(normalizeGlobPattern("c:/a\\b\\*.ts", platform)).toBe("c:/a/b/*.ts");
      expect(normalizeGlobPattern("\\\\srv\\share\\**", platform)).toBe("//srv/share/**");
      expect(normalizeGlobPattern("!C:\\a\\*", platform)).toBe("!C:/a/*");
    }
  });
});
