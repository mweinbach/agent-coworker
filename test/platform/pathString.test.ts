import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import {
  basename,
  canonicalKeyLexical,
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  localPathPattern,
  normalizeSeparators,
  normalizeZipPath,
  type PathStyle,
  resolve,
  samePath,
  styleFor,
  toFileUrl,
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

describe("canonicalKeyLexical / samePath", () => {
  test("win32 keys fold case, separators, trailing separators, and verbatim prefixes", () => {
    expect(canonicalKeyLexical("C:\\Foo\\Bar\\", "win32")).toBe("c:\\foo\\bar");
    expect(canonicalKeyLexical("C:/Foo//Bar", "win32")).toBe("c:\\foo\\bar");
    expect(canonicalKeyLexical("\\\\?\\C:\\Foo\\Bar", "win32")).toBe("c:\\foo\\bar");
    expect(canonicalKeyLexical("\\\\?\\UNC\\Srv\\Share\\X", "win32")).toBe("\\\\srv\\share\\x");
    expect(canonicalKeyLexical("\\\\Srv\\Share\\", "win32")).toBe("\\\\srv\\share");
  });

  test("win32 roots keep their separator (never degrade to drive-relative)", () => {
    expect(canonicalKeyLexical("C:\\", "win32")).toBe("c:\\");
    expect(canonicalKeyLexical("C:/", "win32")).toBe("c:\\");
    expect(canonicalKeyLexical("\\", "win32")).toBe("\\");
  });

  test("win32 keys squash dot-segments lexically", () => {
    expect(canonicalKeyLexical("C:\\a\\.\\b\\..\\c", "win32")).toBe("c:\\a\\c");
  });

  test("posix keys are case-exact and only normalize structure", () => {
    expect(canonicalKeyLexical("/a/b/", "posix")).toBe("/a/b");
    expect(canonicalKeyLexical("//a//b", "posix")).toBe("/a/b");
    expect(canonicalKeyLexical("/a/../b", "posix")).toBe("/b");
    expect(canonicalKeyLexical("/", "posix")).toBe("/");
    expect(canonicalKeyLexical("/A", "posix")).not.toBe(canonicalKeyLexical("/a", "posix"));
  });

  test("empty input stays empty in both styles", () => {
    expect(canonicalKeyLexical("", "win32")).toBe("");
    expect(canonicalKeyLexical("", "posix")).toBe("");
  });

  test("samePath: win32 tolerant, posix exact-case", () => {
    expect(samePath("C:\\foo", "c:/FOO/", "win32")).toBe(true);
    expect(samePath("C:\\foo", "\\\\?\\C:\\Foo", "win32")).toBe(true);
    expect(samePath("C:\\foo", "C:\\bar", "win32")).toBe(false);
    expect(samePath("C:\\foo", "D:\\foo", "win32")).toBe(false);
    expect(samePath("/a/b", "/a/b/", "posix")).toBe(true);
    expect(samePath("/a/./b", "/a/b", "posix")).toBe(true);
    expect(samePath("/a/B", "/a/b", "posix")).toBe(false);
  });

  test("relative inputs get stable keys too", () => {
    expect(canonicalKeyLexical("A/..\\B", "win32")).toBe("b");
    expect(canonicalKeyLexical("a/../b", "posix")).toBe("b");
    expect(canonicalKeyLexical("..", "posix")).toBe("..");
  });
});

describe("normalizeSeparators / toPosix", () => {
  test("normalizeSeparators rewrites both families to the style's canonical one", () => {
    expect(normalizeSeparators("a/b\\c", "win32")).toBe("a\\b\\c");
    expect(normalizeSeparators("a/b\\c", "posix")).toBe("a/b/c");
    expect(normalizeSeparators("C:/x", "win32")).toBe("C:\\x");
  });

  test("toPosix converts win32-shaped input only", () => {
    expect(toPosix("C:\\a\\b")).toBe("C:/a/b");
    expect(toPosix("C:/already/forward")).toBe("C:/already/forward");
    expect(toPosix("\\\\srv\\share\\x")).toBe("//srv/share/x");
    expect(toPosix("rel\\only\\backslashes")).toBe("rel/only/backslashes");
  });

  test("toPosix leaves posix paths (even with literal backslashes) untouched", () => {
    expect(toPosix("/home/user/file")).toBe("/home/user/file");
    expect(toPosix("dir/weird\\name")).toBe("dir/weird\\name");
    expect(toPosix("plain")).toBe("plain");
  });
});

describe("fromFileUrl", () => {
  test("win32 drive URLs", () => {
    expect(fromFileUrl("file:///C:/Program%20Files/App", "win32")).toBe("C:\\Program Files\\App");
    expect(fromFileUrl("file:///C:/", "win32")).toBe("C:\\");
    expect(fromFileUrl("file:///C:", "win32")).toBe("C:\\");
    expect(fromFileUrl("file://localhost/C:/x", "win32")).toBe("C:\\x");
  });

  test("win32 UNC URLs (host becomes the UNC server)", () => {
    expect(fromFileUrl("file://server/share/x%20y", "win32")).toBe("\\\\server\\share\\x y");
  });

  test("posix URLs decode to plain absolute paths", () => {
    expect(fromFileUrl("file:///home/user/a%20b", "posix")).toBe("/home/user/a b");
    expect(fromFileUrl("file://localhost/etc/hosts", "posix")).toBe("/etc/hosts");
    expect(fromFileUrl("file:///", "posix")).toBe("/");
  });

  test("posix NEVER fabricates a UNC path from a URL host (throws instead)", () => {
    expect(() => fromFileUrl("file://server/share/x", "posix")).toThrow();
  });

  test("encoded separators are rejected", () => {
    expect(() => fromFileUrl("file:///a%2Fb", "posix")).toThrow();
    expect(() => fromFileUrl("file:///C:/a%5Cb", "win32")).toThrow();
  });

  test("non-file and invalid URLs are rejected", () => {
    expect(() => fromFileUrl("https://example.com/a", "posix")).toThrow();
    expect(() => fromFileUrl("not a url", "win32")).toThrow();
  });

  test("win32 URL without drive or host is rejected", () => {
    expect(() => fromFileUrl("file:///home/user", "win32")).toThrow();
  });

  test("unicode percent-escapes decode", () => {
    expect(fromFileUrl("file:///tmp/%C3%BC", "posix")).toBe("/tmp/ü");
  });
});

describe("toFileUrl", () => {
  test("win32 drive paths", () => {
    expect(toFileUrl("C:\\Program Files\\App", "win32")).toBe("file:///C:/Program%20Files/App");
    expect(toFileUrl("C:\\", "win32")).toBe("file:///C:/");
    expect(toFileUrl("C:/forward/ok", "win32")).toBe("file:///C:/forward/ok");
  });

  test("win32 UNC paths keep the host in the URL authority", () => {
    expect(toFileUrl("\\\\server\\share\\x y", "win32")).toBe("file://server/share/x%20y");
  });

  test("win32 verbatim drive/UNC prefixes are de-namespaced", () => {
    expect(toFileUrl("\\\\?\\C:\\x", "win32")).toBe("file:///C:/x");
    expect(toFileUrl("\\\\?\\UNC\\server\\share\\x", "win32")).toBe("file://server/share/x");
  });

  test("posix paths", () => {
    expect(toFileUrl("/home/user/a b", "posix")).toBe("file:///home/user/a%20b");
    expect(toFileUrl("/a/../b", "posix")).toBe("file:///b");
    expect(toFileUrl("/", "posix")).toBe("file:///");
  });

  test("special characters are encoded so they survive URL parsing", () => {
    expect(toFileUrl("/tmp/a#b?c", "posix")).toBe("file:///tmp/a%23b%3Fc");
  });

  test("non-fully-qualified input throws", () => {
    expect(() => toFileUrl("relative", "posix")).toThrow();
    expect(() => toFileUrl("relative", "win32")).toThrow();
    expect(() => toFileUrl("C:drive-relative", "win32")).toThrow();
    expect(() => toFileUrl("\\rooted-no-drive", "win32")).toThrow();
    expect(() => toFileUrl("\\\\.\\PhysicalDrive0", "win32")).toThrow();
  });

  test("round-trips through fromFileUrl (lowercase UNC hosts: URL folds host case)", () => {
    const win32Paths = ["C:\\Program Files\\App", "C:\\Üni\\a#b", "\\\\server\\share\\doc x.txt"];
    for (const p of win32Paths) {
      expect(fromFileUrl(toFileUrl(p, "win32"), "win32")).toBe(p);
    }
    const posixPaths = ["/home/user/a b", "/tmp/ü", "/etc/hosts"];
    for (const p of posixPaths) {
      expect(fromFileUrl(toFileUrl(p, "posix"), "posix")).toBe(p);
    }
  });
});

describe("localPathPattern", () => {
  test("win32 kind matches drive and UNC paths embedded in prose", () => {
    const text = "see C:\\Users\\max\\secret.txt and \\\\srv\\share\\doc.docx for details";
    const matches = text.match(localPathPattern("win32"));
    expect(matches).toEqual(["C:\\Users\\max\\secret.txt", "\\\\srv\\share\\doc.docx"]);
  });

  test("win32 kind matches forward-slash drive paths and stops at quotes", () => {
    expect('path "C:/Users/x/y"'.match(localPathPattern("win32"))).toEqual(["C:/Users/x/y"]);
  });

  test("win32 kind does not fire inside URLs (no word boundary before the scheme letter)", () => {
    expect("visit https://example.com/a and http://x/y".match(localPathPattern("win32"))).toBe(
      null,
    );
  });

  test("posix kind matches user-data roots, including file:// prefixed", () => {
    const text = "log at /Users/max/x.log then /home/dev/y and file:///tmp/z";
    const matches = text.match(localPathPattern("posix"));
    expect(matches).toEqual(["/Users/max/x.log", "/home/dev/y", "file:///tmp/z"]);
  });

  test("posix kind is root-anchored: system binaries and URL paths do not match", () => {
    expect("/usr/bin/ls".match(localPathPattern("posix"))).toBe(null);
    expect("https://example.com/a/b".match(localPathPattern("posix"))).toBe(null);
  });

  test("any kind matches both families", () => {
    const text = "win C:\\Temp\\a and posix /var/log/b";
    const matches = text.match(localPathPattern("any"));
    expect(matches).toEqual(["C:\\Temp\\a", "/var/log/b"]);
  });

  test("returns a fresh global RegExp per call (no shared lastIndex state)", () => {
    const first = localPathPattern("any");
    expect(first.global).toBe(true);
    expect(first.exec("C:\\a\\b")).not.toBeNull();
    expect(first.lastIndex).toBeGreaterThan(0);
    const second = localPathPattern("any");
    expect(second).not.toBe(first);
    expect(second.lastIndex).toBe(0);
  });
});

describe("normalizeZipPath", () => {
  const cases: Array<[string, string]> = [
    ["word\\media/image.png", "word/media/image.png"],
    ["a/./b/../c", "a/c"],
    ["/leading/x", "leading/x"],
    ["../..", ""],
    ["a//b", "a/b"],
    ["a/b/", "a/b"],
    ["", ""],
    ["a/../../b", "b"],
  ];
  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
      expect(normalizeZipPath(input)).toBe(want);
    });
  }
});
