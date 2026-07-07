import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hostPlatform } from "../../src/platform/host";
import {
  assertWithinRoots,
  canonicalize,
  canonicalizeSync,
  canonicalKey,
  coworkHome,
  coworkPaths,
  crossesProtectedMetadata,
  displayPath,
  expandHome,
  findGitRoot,
  findGitRootSync,
  fromPosixRelative,
  fsCaseSensitivity,
  home,
  isAbsoluteAnyPlatform,
  isFullyQualified,
  isInside,
  normalizeGlobPattern,
  PROTECTED_METADATA_DIR_NAMES,
  samePath,
  sanitizeFileName,
  splitAbsoluteGlob,
  timestampSegment,
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

describe("canonicalKey", () => {
  test("case-folds on win32 and darwin, preserves case on linux", () => {
    const p = path.join(tmpDir, "Missing", "Child.TXT");
    const canonical = path.join(realTmp, "Missing", "Child.TXT");
    expect(canonicalKey(p, "win32")).toBe(canonical.toLowerCase());
    expect(canonicalKey(p, "darwin")).toBe(canonical.toLowerCase());
    expect(canonicalKey(p, "linux")).toBe(canonical);
  });

  test("strips trailing separators so spellings collide onto one key", () => {
    for (const platform of PLATFORMS) {
      expect(canonicalKey(tmpDir + path.sep, platform)).toBe(canonicalKey(tmpDir, platform));
      expect(canonicalKey(tmpDir + path.sep + path.sep, platform)).toBe(
        canonicalKey(tmpDir, platform),
      );
    }
  });

  test("never strips a filesystem root down to a drive-relative spelling", () => {
    const rootPath = path.parse(realTmp).root;
    const canonicalRoot = fs.realpathSync.native(rootPath);
    const expected =
      fsCaseSensitivity(hostPlatform()) === "insensitive"
        ? canonicalRoot.toLowerCase()
        : canonicalRoot;
    expect(canonicalKey(rootPath)).toBe(expected);
  });

  test("defaults to the host platform", () => {
    expect(canonicalKey(tmpDir)).toBe(canonicalKey(tmpDir, hostPlatform()));
  });
});

describe("samePath", () => {
  test("trailing separators do not break equality on any platform", () => {
    for (const platform of PLATFORMS) {
      expect(samePath(tmpDir, tmpDir + path.sep, platform)).toBe(true);
    }
  });

  test("case difference in a not-yet-existing suffix: folds ONLY on win32", () => {
    const a = path.join(tmpDir, "missing", "file.txt");
    const b = path.join(tmpDir, "MISSING", "FILE.TXT");
    expect(samePath(a, b, "win32")).toBe(true);
    expect(samePath(a, b, "darwin")).toBe(false);
    expect(samePath(a, b, "linux")).toBe(false);
  });

  test("distinct paths are never equal", () => {
    for (const platform of PLATFORMS) {
      expect(samePath(path.join(tmpDir, "a"), path.join(tmpDir, "b"), platform)).toBe(false);
    }
  });

  test("on a case-insensitive host volume, existing paths match via on-disk casing (darwin rule)", () => {
    if (!hostFsIsCaseInsensitive()) {
      // Genuinely host-bound: the volume itself decides whether both spellings resolve.
      return;
    }
    const mixed = path.join(realTmp, "CaseProbeDir");
    const lower = path.join(realTmp, "caseprobedir");
    // Canonicalization restores the on-disk spelling, so even the non-folding darwin
    // comparison sees the two spellings as the same existing directory.
    expect(samePath(mixed, lower, "darwin")).toBe(true);
    expect(samePath(mixed, lower, "linux")).toBe(true);
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

describe("assertWithinRoots", () => {
  test("returns the canonical target when inside a root", () => {
    const target = path.join(tmpDir, "newfile.txt");
    expect(assertWithinRoots([tmpDir], target)).toBe(path.join(realTmp, "newfile.txt"));
  });

  test("accepts when any of several roots matches", () => {
    const other = path.join(realTmp, "other");
    const target = path.join(tmpDir, "sub", "f.txt");
    expect(assertWithinRoots([other, tmpDir], target)).toBe(path.join(realTmp, "sub", "f.txt"));
  });

  test("throws when the target is outside every root", () => {
    const rootA = path.join(realTmp, "a");
    const rootB = path.join(realTmp, "b");
    expect(() => assertWithinRoots([rootA, rootB], path.join(realTmp, "c", "x"))).toThrow(
      "outside the permitted roots",
    );
  });

  test("symlink/junction escapes are canonicalized before the containment check", () => {
    const rootDir = path.join(realTmp, "root");
    const outside = path.join(realTmp, "outside");
    fs.mkdirSync(rootDir);
    fs.mkdirSync(outside);
    symlinkOrJunction(outside, path.join(rootDir, "link"));
    const viaLink = path.join(rootDir, "link", "x.txt");
    expect(() => assertWithinRoots([rootDir], viaLink)).toThrow();
    expect(assertWithinRoots([outside], viaLink)).toBe(path.join(outside, "x.txt"));
  });

  test("case-folds only on win32, exact on darwin (fail direction)", () => {
    const winInside = assertWithinRoots(["C:\\Root"], "c:\\root\\Sub\\f.txt", {
      platform: "win32",
      canonicalize: identity,
    });
    expect(winInside).toBe("c:\\root\\Sub\\f.txt");
    expect(() =>
      assertWithinRoots(["/root"], "/Root/sub/f.txt", {
        platform: "darwin",
        canonicalize: identity,
      }),
    ).toThrow();
    expect(() =>
      assertWithinRoots(["/root"], "/Root/sub/f.txt", {
        platform: "linux",
        canonicalize: identity,
      }),
    ).toThrow();
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

describe("isAbsoluteAnyPlatform", () => {
  test("recognizes absolute paths from every platform vocabulary", () => {
    expect(isAbsoluteAnyPlatform("/usr/local")).toBe(true);
    expect(isAbsoluteAnyPlatform("C:\\Users\\x")).toBe(true);
    expect(isAbsoluteAnyPlatform("C:/Users/x")).toBe(true);
    expect(isAbsoluteAnyPlatform("\\\\srv\\share\\x")).toBe(true);
    expect(isAbsoluteAnyPlatform("\\rooted")).toBe(true);
  });

  test("rejects relative and drive-relative paths", () => {
    expect(isAbsoluteAnyPlatform("a/b")).toBe(false);
    expect(isAbsoluteAnyPlatform("./x")).toBe(false);
    expect(isAbsoluteAnyPlatform("C:foo")).toBe(false);
    expect(isAbsoluteAnyPlatform("")).toBe(false);
  });
});

describe("isFullyQualified", () => {
  test("win32 accepts only drive-qualified, UNC, and verbatim forms", () => {
    expect(isFullyQualified("C:\\x", "win32")).toBe(true);
    expect(isFullyQualified("c:/x", "win32")).toBe(true);
    expect(isFullyQualified("C:\\", "win32")).toBe(true);
    expect(isFullyQualified("\\\\srv\\share\\x", "win32")).toBe(true);
    expect(isFullyQualified("//srv/share/x", "win32")).toBe(true);
    expect(isFullyQualified("\\\\?\\C:\\x", "win32")).toBe(true);
  });

  test("win32 rejects drive-relative and rootless spellings", () => {
    expect(isFullyQualified("C:foo", "win32")).toBe(false);
    expect(isFullyQualified("\\foo", "win32")).toBe(false);
    expect(isFullyQualified("/foo", "win32")).toBe(false);
    expect(isFullyQualified("foo\\bar", "win32")).toBe(false);
    expect(isFullyQualified("\\\\", "win32")).toBe(false);
  });

  test("posix platforms use plain isAbsolute", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      expect(isFullyQualified("/x/y", platform)).toBe(true);
      expect(isFullyQualified("x/y", platform)).toBe(false);
      expect(isFullyQualified("C:\\x", platform)).toBe(false);
      expect(isFullyQualified("~/x", platform)).toBe(false);
    }
  });
});

describe("toPosixRelative / fromPosixRelative", () => {
  test("win32 relative paths are emitted with forward slashes", () => {
    expect(toPosixRelative("C:\\a", "C:\\a\\b\\c", "win32")).toBe("b/c");
    expect(toPosixRelative("C:\\a\\b", "C:\\a\\x", "win32")).toBe("../x");
  });

  test("posix relative paths pass through", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      expect(toPosixRelative("/a", "/a/b/c", platform)).toBe("b/c");
      expect(toPosixRelative("/a/b", "/a/x", platform)).toBe("../x");
    }
  });

  test("fromPosixRelative rejoins with native separators", () => {
    expect(fromPosixRelative("C:\\a", "b/c", "win32")).toBe("C:\\a\\b\\c");
    expect(fromPosixRelative("/a", "b/c", "linux")).toBe("/a/b/c");
    expect(fromPosixRelative("/a", "", "darwin")).toBe("/a");
  });

  test("round-trips on every platform", () => {
    const cases: Array<[NodeJS.Platform, string, string]> = [
      ["win32", "C:\\root", "C:\\root\\sub\\file.txt"],
      ["darwin", "/root", "/root/sub/file.txt"],
      ["linux", "/root", "/root/sub/file.txt"],
    ];
    for (const [platform, root, target] of cases) {
      const rel = toPosixRelative(root, target, platform);
      expect(fromPosixRelative(root, rel, platform)).toBe(target);
    }
  });

  test("host default matches node's own relative", () => {
    const from = path.join(realTmp, "a");
    const to = path.join(realTmp, "a", "b", "c");
    expect(toPosixRelative(from, to)).toBe("b/c");
  });
});

describe("home / coworkHome / coworkPaths", () => {
  test("defaults to os.homedir() when no override is present", () => {
    expect(home({})).toBe(os.homedir());
    expect(home({ HOME: "/somewhere/else" })).toBe(os.homedir());
  });

  test("COWORK_HOME_OVERRIDE is the only lever and is resolved", () => {
    expect(home({ COWORK_HOME_OVERRIDE: realTmp })).toBe(path.resolve(realTmp));
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

describe("expandHome", () => {
  const homeDir = path.join(path.parse(os.homedir()).root, "testhome");

  test("expands ~ and ~/ prefixes", () => {
    expect(expandHome("~", { home: homeDir })).toBe(homeDir);
    expect(expandHome("~/a/b", { home: homeDir })).toBe(path.join(homeDir, "a", "b"));
    expect(expandHome("~\\a\\b", { home: homeDir })).toBe(path.join(homeDir, "a", "b"));
  });

  test("~user/x throws instead of silently mis-expanding", () => {
    expect(() => expandHome("~alice/x", { home: homeDir })).toThrow("home-relative");
    expect(() => expandHome("~2", { home: homeDir })).toThrow();
  });

  test("paths without a leading ~ pass through unchanged", () => {
    expect(expandHome("/a/~b", { home: homeDir })).toBe("/a/~b");
    expect(expandHome("a/b", { home: homeDir })).toBe("a/b");
    expect(expandHome("", { home: homeDir })).toBe("");
  });
});

describe("displayPath", () => {
  test("abbreviates paths under home as ~", () => {
    const homeDir = path.join(realTmp, "home");
    const inside = path.join(homeDir, "docs", "x.txt");
    expect(displayPath(inside, { home: homeDir })).toBe(
      `~${path.sep}${path.join("docs", "x.txt")}`,
    );
    expect(displayPath(homeDir, { home: homeDir })).toBe("~");
  });

  test("paths outside home stay absolute and unabbreviated", () => {
    const homeDir = path.join(realTmp, "home");
    const outside = path.join(realTmp, "elsewhere", "x.txt");
    expect(displayPath(outside, { home: homeDir })).toBe(outside);
    expect(displayPath(path.dirname(homeDir), { home: homeDir })).toBe(path.dirname(homeDir));
  });

  test("sibling with a shared name prefix is not abbreviated", () => {
    const homeDir = path.join(realTmp, "home");
    const sibling = path.join(realTmp, "homestead", "x.txt");
    expect(displayPath(sibling, { home: homeDir })).toBe(sibling);
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

describe("sanitizeFileName", () => {
  test("replaces invalid characters with the replacement (default _)", () => {
    expect(sanitizeFileName("a:b")).toBe("a_b");
    expect(sanitizeFileName("a/b\\c")).toBe("a_b_c");
    expect(sanitizeFileName(`a${NUL}b`)).toBe("a_b");
    expect(sanitizeFileName("a<b>c|d?e*f")).toBe("a_b_c_d_e_f");
  });

  test("honors a custom replacement", () => {
    expect(sanitizeFileName("a:b", { replacement: "-" })).toBe("a-b");
    expect(sanitizeFileName("a:b", { replacement: "" })).toBe("ab");
  });

  test("trims trailing dots and spaces", () => {
    expect(sanitizeFileName("name...")).toBe("name");
    expect(sanitizeFileName("name . .")).toBe("name");
  });

  test("defuses reserved device names by prefixing", () => {
    expect(sanitizeFileName("con")).toBe("_con");
    expect(sanitizeFileName("COM1.txt")).toBe("_COM1.txt");
    expect(sanitizeFileName("con", { replacement: "-" })).toBe("-con");
    expect(sanitizeFileName("con", { replacement: "" })).toBe("_con");
  });

  test("caps length at 255 without leaving a trailing dot", () => {
    const long = `${"a".repeat(254)}.b${"c".repeat(60)}`;
    const out = sanitizeFileName(long);
    expect(out.length).toBeLessThanOrEqual(255);
    expect(validateFileName(out)).toEqual({ ok: true });
  });

  test("degenerate inputs become _", () => {
    for (const name of ["", ".", "..", ":", "...", "   "]) {
      expect(sanitizeFileName(name)).toBe("_");
    }
  });

  test("property: sanitize output always validates on the portable rule set", () => {
    const nasty = [
      "con",
      "NUL.tar.gz",
      "a:b:c",
      "trailing. ",
      "a/b\\c",
      `x${NUL}${UNIT_SEPARATOR}y`,
      "..",
      "?",
      "***",
      " leading and trailing ",
      "a".repeat(400),
      `${"dot.".repeat(80)}end.`,
      "normal-name.txt",
    ];
    for (const name of nasty) {
      const out = sanitizeFileName(name);
      expect(validateFileName(out)).toEqual({ ok: true });
    }
  });
});

describe("timestampSegment", () => {
  test("renders a fixed date deterministically with no colons or dots", () => {
    const out = timestampSegment(new Date("2026-07-07T01:02:03.004Z"));
    expect(out).toBe("2026-07-07T01-02-03-004Z");
  });

  test("output is always a valid portable file name", () => {
    const out = timestampSegment();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    expect(out).not.toContain(":");
    expect(out).not.toContain(".");
    expect(validateFileName(out)).toEqual({ ok: true });
  });
});

describe("findGitRoot / findGitRootSync", () => {
  test("finds a .git directory from a nested start dir", () => {
    const repo = path.join(realTmp, "repo");
    const nested = path.join(repo, "a", "b");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    expect(findGitRootSync(nested)).toBe(repo);
    expect(findGitRootSync(repo)).toBe(repo);
  });

  test("a .git FILE (worktree/submodule) also marks the root", () => {
    const repo = path.join(realTmp, "worktree");
    const nested = path.join(repo, "src");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: /somewhere/else\n");
    expect(findGitRootSync(nested)).toBe(repo);
  });

  test("returns null and terminates at the filesystem root (drive/UNC loop-safe)", () => {
    const probes: string[] = [];
    const result = findGitRootSync(path.join(realTmp, "deep", "er"), {
      exists: (p) => {
        probes.push(p);
        return false;
      },
    });
    expect(result).toBeNull();
    expect(probes[0]).toBe(path.join(path.resolve(realTmp), "deep", "er", ".git"));
    const lastProbeDir = path.dirname(probes[probes.length - 1] as string);
    // The walk's final probe happens AT the fixed-point root — one step past it would loop.
    expect(path.dirname(lastProbeDir)).toBe(lastProbeDir);
  });

  test("async twin matches the sync walk exactly", async () => {
    const repo = path.join(realTmp, "repo2");
    const nested = path.join(repo, "x", "y");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    expect(await findGitRoot(nested)).toBe(findGitRootSync(nested));
    expect(await findGitRoot(realTmp, { exists: () => false })).toBeNull();
    expect(await findGitRoot(nested, { exists: async (p) => p.startsWith(repo) })).toBe(nested);
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

describe("splitAbsoluteGlob", () => {
  test("posix absolute patterns split at the last static slash", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      expect(splitAbsoluteGlob("/a/b/**/*.ts", platform)).toEqual({
        root: "/a/b",
        rest: "**/*.ts",
      });
      expect(splitAbsoluteGlob("/*.ts", platform)).toEqual({ root: "/", rest: "*.ts" });
      expect(splitAbsoluteGlob("/a/b/c", platform)).toEqual({ root: "/a/b", rest: "c" });
    }
  });

  test("win32 drive patterns produce drive-QUALIFIED roots, never drive-relative", () => {
    expect(splitAbsoluteGlob("C:\\a\\*.ts", "win32")).toEqual({ root: "C:/a", rest: "*.ts" });
    expect(splitAbsoluteGlob("C:\\*.ts", "win32")).toEqual({ root: "C:/", rest: "*.ts" });
    expect(splitAbsoluteGlob("c:/deep/dir/**", "win32")).toEqual({
      root: "c:/deep/dir",
      rest: "**",
    });
  });

  test("UNC roots are preserved", () => {
    expect(splitAbsoluteGlob("\\\\srv\\share\\**", "win32")).toEqual({
      root: "//srv/share",
      rest: "**",
    });
    expect(splitAbsoluteGlob("//srv/share/logs/*.log", "win32")).toEqual({
      root: "//srv/share/logs",
      rest: "*.log",
    });
  });

  test("win32-shaped patterns split on posix platforms too", () => {
    expect(splitAbsoluteGlob("C:\\a\\*.ts", "linux")).toEqual({ root: "C:/a", rest: "*.ts" });
  });

  test("relative and negated patterns return null", () => {
    for (const platform of PLATFORMS) {
      expect(splitAbsoluteGlob("src/**/*.ts", platform)).toBeNull();
      expect(splitAbsoluteGlob("*.ts", platform)).toBeNull();
      expect(splitAbsoluteGlob("!/a/*.ts", platform)).toBeNull();
      expect(splitAbsoluteGlob("", platform)).toBeNull();
    }
  });

  test("magic character inside the first segment roots at /", () => {
    expect(splitAbsoluteGlob("/*/x", "linux")).toEqual({ root: "/", rest: "*/x" });
  });
});
