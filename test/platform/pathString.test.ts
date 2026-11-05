import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import {
  absolutePathStyle,
  basename,
  canonicalKeyLexical,
  dirname,
  isAbsolute,
  isPathEqualOrInsideLexical,
  join,
  type PathStyle,
  resolve,
  styleFor,
  toPosix,
} from "../../src/platform/pathString";

// pathString.ts is pure string logic keyed on an explicit PathStyle, so every branch
// below (win32 AND posix) executes identically on win32, darwin, and linux hosts. The
// test file may import node:path as the differential oracle; the module may not.

const WIN32_CWD = "C:\\Users\\dev\\repo";
const WIN32_UNC_CWD = "\\\\srv\\share\\work";
const POSIX_CWD = "/home/dev/repo";

// ---------------------------------------------------------------------------
// Structured-random input generation (seeded, reproducible)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)] as T;
}

const SEGMENTS = [
  "a",
  "B",
  "foo bar",
  ".",
  "..",
  "...",
  "name.txt",
  "sub_dir",
  "x..",
  "..y",
  "Ünïcode",
  "UPPER",
  "lower",
  "trailing.",
] as const;
// "a:b" is win32-drive-relative when it lands first in a relative path, which makes the
// node oracle consult REAL host process state — kept out of the win32 differential pool
// and covered by a deterministic named test instead.

// Drive-relative prefixes ("C:", "c:") stay on the same drive as WIN32_CWD so the
// node:path oracle never consults real per-drive process state (host-agnostic).
const WIN32_PREFIXES = [
  "",
  "\\",
  "/",
  "C:",
  "c:",
  "C:\\",
  "C:/",
  "c:\\",
  "\\\\srv\\share\\",
  "//srv/share/",
  "\\\\srv\\share",
  "\\\\SRV\\Share\\",
  "..\\",
  ".\\",
  "./",
] as const;
const WIN32_ABSOLUTE_SAFE_PREFIXES = WIN32_PREFIXES.filter((p) => p !== "C:" && p !== "c:");
const WIN32_SEPS = ["\\", "/", "\\\\", "//", "\\/"] as const;

const POSIX_PREFIXES = ["", "/", "//", "./", "../", "~/"] as const;
const POSIX_SEPS = ["/", "//"] as const;
const POSIX_SEGMENTS = [...SEGMENTS, "a:b", "back\\slash", "\\"] as const;

function generatePath(
  rand: () => number,
  prefixes: readonly string[],
  segments: readonly string[],
  seps: readonly string[],
): string {
  const prefix = pick(rand, prefixes);
  const count = Math.floor(rand() * 6);
  let out = prefix;
  for (let i = 0; i < count; i++) {
    if (i > 0 || (prefix !== "" && !/[\\/]$/.test(prefix))) out += pick(rand, seps);
    out += pick(rand, segments);
  }
  if (rand() < 0.25) out += pick(rand, seps);
  return out;
}

type Mismatch = { fn: string; input: unknown; got: unknown; want: unknown };

function checkAgainstNode(
  mismatches: Mismatch[],
  style: PathStyle,
  cwd: string,
  p: string,
  opts: { driveRelativeDivergence?: boolean } = {},
): void {
  const oracle = style === "win32" ? nodePath.win32 : nodePath.posix;

  const gotResolve = resolve(p, style, cwd);
  const wantResolve = oracle.resolve(cwd, p);
  if (gotResolve !== wantResolve) {
    mismatches.push({ fn: "resolve", input: p, got: gotResolve, want: wantResolve });
  }

  const gotAbs = isAbsolute(p, style);
  const wantAbs = oracle.isAbsolute(p);
  if (gotAbs !== wantAbs) {
    mismatches.push({ fn: "isAbsolute", input: p, got: gotAbs, want: wantAbs });
  }

  let wantDirname = oracle.dirname(p);
  if (opts.driveRelativeDivergence && /^[A-Za-z]:$/.test(wantDirname)) {
    // Documented divergence: dirname never yields drive-relative "C:".
    wantDirname = `${wantDirname}\\`;
  }
  const gotDirname = dirname(p, style);
  if (gotDirname !== wantDirname) {
    mismatches.push({ fn: "dirname", input: p, got: gotDirname, want: wantDirname });
  }

  // basename treats both separator families (and a leading drive prefix) per win32 on
  // every platform, which is exactly node:path.win32.basename; posix parity additionally
  // holds when the input has no backslashes and no drive-letter prefix (asserted below).
  const gotBasename = basename(p);
  const wantBasename = nodePath.win32.basename(p);
  if (gotBasename !== wantBasename) {
    mismatches.push({ fn: "basename", input: p, got: gotBasename, want: wantBasename });
  }
  if (style === "posix" && !p.includes("\\") && !/^[A-Za-z]:/.test(p)) {
    const wantPosixBasename = nodePath.posix.basename(p);
    if (gotBasename !== wantPosixBasename) {
      mismatches.push({
        fn: "basename(posix)",
        input: p,
        got: gotBasename,
        want: wantPosixBasename,
      });
    }
  }
}

describe("differential: pathString vs node:path on structured-random inputs", () => {
  test("win32 resolve/dirname/basename/isAbsolute agree with node:path.win32 (drive cwd, 700 inputs)", () => {
    const rand = mulberry32(0x5eed1);
    const mismatches: Mismatch[] = [];
    for (let i = 0; i < 700; i++) {
      const p = generatePath(rand, WIN32_PREFIXES, SEGMENTS, WIN32_SEPS);
      checkAgainstNode(mismatches, "win32", WIN32_CWD, p, { driveRelativeDivergence: true });
    }
    expect(mismatches).toEqual([]);
  });

  test("win32 resolve/dirname/basename/isAbsolute agree with node:path.win32 (UNC cwd, 300 inputs)", () => {
    const rand = mulberry32(0x5eed2);
    const mismatches: Mismatch[] = [];
    for (let i = 0; i < 300; i++) {
      const p = generatePath(rand, WIN32_ABSOLUTE_SAFE_PREFIXES, SEGMENTS, WIN32_SEPS);
      checkAgainstNode(mismatches, "win32", WIN32_UNC_CWD, p, { driveRelativeDivergence: true });
    }
    expect(mismatches).toEqual([]);
  });

  test("posix resolve/dirname/basename/isAbsolute agree with node:path.posix (700 inputs)", () => {
    const rand = mulberry32(0x5eed3);
    const mismatches: Mismatch[] = [];
    for (let i = 0; i < 700; i++) {
      const p = generatePath(rand, POSIX_PREFIXES, POSIX_SEGMENTS, POSIX_SEPS);
      checkAgainstNode(mismatches, "posix", POSIX_CWD, p);
    }
    expect(mismatches).toEqual([]);
  });

  test("win32 join agrees with node:path.win32.join (400 tuples)", () => {
    const rand = mulberry32(0x5eed4);
    const mismatches: Mismatch[] = [];
    for (let i = 0; i < 400; i++) {
      const count = 1 + Math.floor(rand() * 4);
      const parts: string[] = [];
      for (let j = 0; j < count; j++) {
        parts.push(rand() < 0.15 ? "" : generatePath(rand, WIN32_PREFIXES, SEGMENTS, WIN32_SEPS));
      }
      const got = join("win32", ...parts);
      const want = nodePath.win32.join(...parts);
      if (got !== want) mismatches.push({ fn: "join", input: parts, got, want });
    }
    expect(mismatches).toEqual([]);
  });

  test("posix join agrees with node:path.posix.join (400 tuples)", () => {
    const rand = mulberry32(0x5eed5);
    const mismatches: Mismatch[] = [];
    for (let i = 0; i < 400; i++) {
      const count = 1 + Math.floor(rand() * 4);
      const parts: string[] = [];
      for (let j = 0; j < count; j++) {
        parts.push(
          rand() < 0.15 ? "" : generatePath(rand, POSIX_PREFIXES, POSIX_SEGMENTS, POSIX_SEPS),
        );
      }
      const got = join("posix", ...parts);
      const want = nodePath.posix.join(...parts);
      if (got !== want) mismatches.push({ fn: "join", input: parts, got, want });
    }
    expect(mismatches).toEqual([]);
  });
});

describe("intentional divergences from node:path (asserted explicitly)", () => {
  test("dirname never yields drive-relative 'C:' (node does)", () => {
    expect(nodePath.win32.dirname("C:foo")).toBe("C:");
    expect(dirname("C:foo", "win32")).toBe("C:\\");
    expect(nodePath.win32.dirname("C:")).toBe("C:");
    expect(dirname("C:", "win32")).toBe("C:\\");
  });

  test("resolve de-namespaces \\\\?\\ drive prefixes (node keeps them as UNC server '?')", () => {
    expect(nodePath.win32.resolve(WIN32_CWD, "\\\\?\\C:\\Users\\X\\..\\y")).toBe(
      "\\\\?\\C:\\Users\\y",
    );
    expect(resolve("\\\\?\\C:\\Users\\X\\..\\y", "win32", WIN32_CWD)).toBe("C:\\Users\\y");
    // Mixed separators and the \\.\ marker take the same route.
    expect(resolve("//?/C:/a/./b", "win32", WIN32_CWD)).toBe("C:\\a\\b");
    expect(resolve("\\\\.\\C:\\a", "win32", WIN32_CWD)).toBe("C:\\a");
    expect(resolve("\\\\?\\C:", "win32", WIN32_CWD)).toBe("C:\\");
  });

  test("resolve de-namespaces \\\\?\\UNC\\ prefixes to plain UNC paths", () => {
    expect(resolve("\\\\?\\UNC\\srv\\share\\a\\..\\b", "win32", WIN32_CWD)).toBe(
      "\\\\srv\\share\\b",
    );
    expect(nodePath.win32.resolve(WIN32_CWD, "\\\\?\\UNC\\srv\\share\\a\\..\\b")).toBe(
      "\\\\?\\UNC\\srv\\share\\b",
    );
  });

  test("basename splits on backslash even for posix-origin strings (node.posix keeps it)", () => {
    expect(nodePath.posix.basename("a\\b")).toBe("a\\b");
    expect(basename("a\\b")).toBe("b");
  });

  test("basename skips a leading drive prefix even for posix-origin strings", () => {
    expect(nodePath.posix.basename("a:b")).toBe("a:b");
    expect(basename("a:b")).toBe("b");
  });

  test("cross-drive drive-relative resolve is deterministic (drive root, no process state)", () => {
    expect(resolve("D:foo", "win32", "C:\\base")).toBe("D:\\foo");
    expect(resolve("d:foo\\..\\bar", "win32", WIN32_UNC_CWD)).toBe("d:\\bar");
    // node consults process.env["=a:"] / process.cwd() here — host state this module
    // never reads, so the result below is stable on every machine.
    expect(resolve("a:b\\lower", "win32", WIN32_CWD)).toBe("a:\\b\\lower");
  });
});

describe("styleFor", () => {
  const cases: Array<[NodeJS.Platform, PathStyle]> = [
    ["win32", "win32"],
    ["darwin", "posix"],
    ["linux", "posix"],
    ["aix", "posix"],
    ["android", "posix"],
    ["freebsd", "posix"],
    ["haiku", "posix"],
    ["openbsd", "posix"],
    ["sunos", "posix"],
    ["cygwin", "posix"],
    ["netbsd", "posix"],
  ];
  for (const [platform, style] of cases) {
    test(`${platform} → ${style}`, () => {
      expect(styleFor(platform)).toBe(style);
    });
  }
});

describe("resolve", () => {
  test("win32: relative against drive cwd", () => {
    expect(resolve("a\\b", "win32", WIN32_CWD)).toBe("C:\\Users\\dev\\repo\\a\\b");
    expect(resolve("a/b", "win32", WIN32_CWD)).toBe("C:\\Users\\dev\\repo\\a\\b");
    expect(resolve("..", "win32", WIN32_CWD)).toBe("C:\\Users\\dev");
    expect(resolve("", "win32", WIN32_CWD)).toBe(WIN32_CWD);
  });

  test("win32: rooted '\\foo' picks up the cwd's drive or UNC root", () => {
    expect(resolve("\\foo", "win32", WIN32_CWD)).toBe("C:\\foo");
    expect(resolve("/foo", "win32", WIN32_CWD)).toBe("C:\\foo");
    expect(resolve("\\foo", "win32", WIN32_UNC_CWD)).toBe("\\\\srv\\share\\foo");
  });

  test("win32: drive-relative 'C:foo' resolves under the cwd of the same drive", () => {
    expect(resolve("C:foo", "win32", WIN32_CWD)).toBe("C:\\Users\\dev\\repo\\foo");
    expect(resolve("c:foo", "win32", WIN32_CWD)).toBe("c:\\Users\\dev\\repo\\foo");
  });

  test("win32: '..' clamps at drive and UNC roots", () => {
    expect(resolve("C:\\a\\..\\..\\..", "win32", WIN32_CWD)).toBe("C:\\");
    expect(resolve("\\\\srv\\share\\a\\..\\..", "win32", WIN32_CWD)).toBe("\\\\srv\\share\\");
  });

  test("win32: UNC inputs keep their root", () => {
    expect(resolve("\\\\srv\\share", "win32", WIN32_CWD)).toBe("\\\\srv\\share\\");
    expect(resolve("//srv/share/a/b", "win32", WIN32_CWD)).toBe("\\\\srv\\share\\a\\b");
  });

  test("win32: device-namespace roots are preserved and never escaped", () => {
    expect(resolve("\\\\?\\Volume{abc}\\x\\..\\y", "win32", WIN32_CWD)).toBe(
      "\\\\?\\Volume{abc}\\y",
    );
    expect(resolve("\\\\?\\Volume{abc}\\..\\..", "win32", WIN32_CWD)).toBe("\\\\?\\Volume{abc}\\");
    expect(resolve("\\\\.\\PhysicalDrive0", "win32", WIN32_CWD)).toBe("\\\\.\\PhysicalDrive0");
  });

  test("win32: verbatim cwd is de-namespaced too", () => {
    expect(resolve("x", "win32", "\\\\?\\C:\\base")).toBe("C:\\base\\x");
  });

  test("posix: relative, dot-dot clamping, absolute passthrough", () => {
    expect(resolve("a/b", "posix", POSIX_CWD)).toBe("/home/dev/repo/a/b");
    expect(resolve("../x", "posix", POSIX_CWD)).toBe("/home/dev/x");
    expect(resolve("/a/../../b", "posix", POSIX_CWD)).toBe("/b");
    expect(resolve("/abs", "posix", POSIX_CWD)).toBe("/abs");
    expect(resolve("", "posix", POSIX_CWD)).toBe(POSIX_CWD);
  });

  test("posix: backslashes are ordinary characters", () => {
    expect(resolve("a\\b", "posix", POSIX_CWD)).toBe("/home/dev/repo/a\\b");
  });

  test("default cwd produces an absolute path in the requested style on every host", () => {
    const win = resolve("leaf", "win32");
    expect(isAbsolute(win, "win32")).toBe(true);
    expect(win.endsWith("\\leaf")).toBe(true);
    const posix = resolve("leaf", "posix");
    expect(isAbsolute(posix, "posix")).toBe(true);
    expect(posix.endsWith("/leaf")).toBe(true);
  });

  test("relative cwd misuse still yields a deterministic absolute path", () => {
    expect(resolve("a", "win32", "rel\\base")).toBe("C:\\rel\\base\\a");
    expect(resolve("a", "posix", "rel/base")).toBe("/rel/base/a");
  });
});

describe("isAbsolute", () => {
  const cases: Array<[string, PathStyle, boolean]> = [
    ["C:\\foo", "win32", true],
    ["C:/foo", "win32", true],
    ["C:\\", "win32", true],
    ["C:", "win32", false],
    ["C:foo", "win32", false],
    ["\\foo", "win32", true],
    ["/foo", "win32", true],
    ["\\", "win32", true],
    ["\\\\srv\\share\\x", "win32", true],
    ["\\\\?\\C:\\x", "win32", true],
    ["foo\\bar", "win32", false],
    ["", "win32", false],
    ["/foo", "posix", true],
    ["/", "posix", true],
    ["foo", "posix", false],
    ["\\foo", "posix", false],
    ["C:\\foo", "posix", false],
    ["", "posix", false],
  ];
  for (const [p, style, want] of cases) {
    test(`${JSON.stringify(p)} (${style}) → ${want}`, () => {
      expect(isAbsolute(p, style)).toBe(want);
    });
  }
});

describe("dirname", () => {
  const cases: Array<[string, PathStyle, string]> = [
    ["C:\\a\\b", "win32", "C:\\a"],
    ["C:\\a", "win32", "C:\\"],
    ["C:\\", "win32", "C:\\"],
    ["C:/a/b", "win32", "C:/a"],
    ["\\\\srv\\share\\a\\b", "win32", "\\\\srv\\share\\a"],
    ["\\\\srv\\share\\a", "win32", "\\\\srv\\share\\"],
    ["\\\\srv\\share", "win32", "\\\\srv\\share"],
    ["\\\\?\\C:\\a\\b", "win32", "\\\\?\\C:\\a"],
    ["\\\\?\\C:\\a", "win32", "\\\\?\\C:\\"],
    ["\\a\\b", "win32", "\\a"],
    ["a\\b", "win32", "a"],
    ["a", "win32", "."],
    ["", "win32", "."],
    ["/a/b", "posix", "/a"],
    ["/a", "posix", "/"],
    ["/", "posix", "/"],
    ["a/b", "posix", "a"],
    ["a", "posix", "."],
    ["//a", "posix", "//"],
    ["", "posix", "."],
    ["a\\b", "posix", "."],
  ];
  for (const [p, style, want] of cases) {
    test(`${JSON.stringify(p)} (${style}) → ${JSON.stringify(want)}`, () => {
      expect(dirname(p, style)).toBe(want);
    });
  }
});

describe("basename", () => {
  const cases: Array<[string, string]> = [
    ["C:\\a\\b.txt", "b.txt"],
    ["C:\\a\\b\\", "b"],
    ["C:\\", ""],
    ["C:", ""],
    ["C:file", "file"],
    ["/a/b", "b"],
    ["/a/b/", "b"],
    ["/", ""],
    ["mixed/sep\\name", "name"],
    ["\\\\srv\\share\\doc.docx", "doc.docx"],
    ["", ""],
    ["plain", "plain"],
  ];
  for (const [p, want] of cases) {
    test(`${JSON.stringify(p)} → ${JSON.stringify(want)}`, () => {
      expect(basename(p)).toBe(want);
    });
  }
});

describe("join", () => {
  test("no parts or all-empty parts → '.' in both styles", () => {
    expect(join("win32")).toBe(".");
    expect(join("posix")).toBe(".");
    expect(join("win32", "", "")).toBe(".");
    expect(join("posix", "", "")).toBe(".");
  });

  test("win32 guards against fabricating UNC from joined separators", () => {
    expect(join("win32", "\\", "\\srv", "share")).toBe("\\srv\\share");
    expect(join("win32", "\\\\srv", "share")).toBe("\\\\srv\\share\\");
  });

  test("posix keeps backslashes as content", () => {
    expect(join("posix", "a\\b", "c")).toBe("a\\b/c");
  });

  test("dot-segments are squashed per style", () => {
    expect(join("win32", "C:\\a", "..", "b")).toBe("C:\\b");
    expect(join("posix", "/a", "./b", "../c")).toBe("/a/c");
  });
});

describe("absolute path style and lexical containment", () => {
  test("infers path syntax without consulting the host", () => {
    expect(absolutePathStyle("/Users/alice/project")).toBe("posix");
    expect(absolutePathStyle("C:\\Users\\alice\\project")).toBe("win32");
    expect(absolutePathStyle("C:/Users/alice/project")).toBe("win32");
    expect(absolutePathStyle("\\\\server\\share\\project")).toBe("win32");
    expect(absolutePathStyle("//server/share/project")).toBe("win32");
    expect(absolutePathStyle("relative/project")).toBeNull();
    expect(absolutePathStyle("\\drive-rooted")).toBeNull();
  });

  test("checks containment with the path's syntax rather than the host's", () => {
    expect(isPathEqualOrInsideLexical("/Users/alice/ws", "/Users/alice/ws/a.png", "posix")).toBe(
      true,
    );
    expect(isPathEqualOrInsideLexical("/Users/alice/ws", "/Users/alice/ws2/a.png", "posix")).toBe(
      false,
    );
    expect(
      isPathEqualOrInsideLexical("C:\\Users\\Alice\\ws", "c:/users/alice/ws/a.png", "win32"),
    ).toBe(true);
    expect(
      isPathEqualOrInsideLexical("C:\\Users\\Alice\\ws", "D:\\Users\\Alice\\ws\\a.png", "win32"),
    ).toBe(false);
    expect(isPathEqualOrInsideLexical("relative", "relative/a.png", "posix")).toBe(false);
  });
});
