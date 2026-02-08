import { describe, expect, test } from "bun:test";
import path from "node:path";

import { isPathInside, resolveMaybeRelative, truncateLine, truncateText } from "../src/utils/paths";

// ---------------------------------------------------------------------------
// resolveMaybeRelative
// ---------------------------------------------------------------------------

describe("resolveMaybeRelative", () => {
  const base = "/home/user/project";

  describe("absolute paths remain unchanged (modulo normalization)", () => {
    test("simple absolute path is returned as-is", () => {
      expect(resolveMaybeRelative("/usr/local/bin", base)).toBe("/usr/local/bin");
    });

    test("absolute path with trailing slash is normalized", () => {
      expect(resolveMaybeRelative("/usr/local/bin/", base)).toBe(
        path.normalize("/usr/local/bin/"),
      );
    });

    test("absolute path with .. components is normalized", () => {
      expect(resolveMaybeRelative("/usr/local/../bin", base)).toBe("/usr/bin");
    });

    test("absolute path with . components is normalized", () => {
      expect(resolveMaybeRelative("/usr/./local/./bin", base)).toBe("/usr/local/bin");
    });

    test("root path", () => {
      expect(resolveMaybeRelative("/", base)).toBe("/");
    });

    test("absolute path ignores baseDir entirely", () => {
      expect(resolveMaybeRelative("/etc/config", "/some/other/dir")).toBe("/etc/config");
    });
  });

  describe("relative paths are resolved against baseDir", () => {
    test("simple relative path", () => {
      expect(resolveMaybeRelative("src/index.ts", base)).toBe(
        path.normalize("/home/user/project/src/index.ts"),
      );
    });

    test("relative path with ./ prefix", () => {
      expect(resolveMaybeRelative("./src/index.ts", base)).toBe(
        path.normalize("/home/user/project/src/index.ts"),
      );
    });

    test("relative path with .. component", () => {
      expect(resolveMaybeRelative("../sibling/file.txt", base)).toBe(
        path.normalize("/home/user/sibling/file.txt"),
      );
    });

    test("relative path with multiple .. components", () => {
      expect(resolveMaybeRelative("../../other/file.txt", base)).toBe(
        path.normalize("/home/other/file.txt"),
      );
    });

    test("bare filename", () => {
      expect(resolveMaybeRelative("file.txt", base)).toBe(
        path.normalize("/home/user/project/file.txt"),
      );
    });

    test("relative path with redundant separators is normalized", () => {
      expect(resolveMaybeRelative("src//lib///util.ts", base)).toBe(
        path.normalize("/home/user/project/src/lib/util.ts"),
      );
    });

    test("dot-only relative path", () => {
      expect(resolveMaybeRelative(".", base)).toBe(path.normalize("/home/user/project"));
    });

    test("double-dot relative path", () => {
      expect(resolveMaybeRelative("..", base)).toBe(path.normalize("/home/user"));
    });
  });

  describe("empty string handling", () => {
    test("empty string returns empty string", () => {
      expect(resolveMaybeRelative("", base)).toBe("");
    });

    test("empty string ignores baseDir", () => {
      expect(resolveMaybeRelative("", "/any/base")).toBe("");
    });
  });

  describe("different baseDirs", () => {
    test("root baseDir", () => {
      expect(resolveMaybeRelative("foo", "/")).toBe(path.normalize("/foo"));
    });

    test("deeply nested baseDir", () => {
      expect(resolveMaybeRelative("f.ts", "/a/b/c/d/e")).toBe(
        path.normalize("/a/b/c/d/e/f.ts"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// isPathInside
// ---------------------------------------------------------------------------

describe("isPathInside", () => {
  describe("child inside parent", () => {
    test("direct child", () => {
      expect(isPathInside("/project", "/project/src")).toBe(true);
    });

    test("deeply nested child", () => {
      expect(isPathInside("/project", "/project/src/lib/utils/helpers.ts")).toBe(true);
    });

    test("child with file extension", () => {
      expect(isPathInside("/project", "/project/index.ts")).toBe(true);
    });
  });

  describe("same path", () => {
    test("identical paths return true", () => {
      expect(isPathInside("/project", "/project")).toBe(true);
    });

    test("identical root paths", () => {
      expect(isPathInside("/", "/")).toBe(true);
    });
  });

  describe("not inside", () => {
    test("sibling directories", () => {
      expect(isPathInside("/project-a", "/project-b")).toBe(false);
    });

    test("parent and child reversed", () => {
      expect(isPathInside("/project/src", "/project")).toBe(false);
    });

    test("completely unrelated paths", () => {
      expect(isPathInside("/home/user", "/var/log")).toBe(false);
    });

    test("child going above parent with ..", () => {
      expect(isPathInside("/project/src", "/project/src/../../etc")).toBe(false);
    });
  });

  describe("trailing slashes", () => {
    test("parent with trailing slash", () => {
      expect(isPathInside("/project/", "/project/src")).toBe(true);
    });

    test("child with trailing slash", () => {
      expect(isPathInside("/project", "/project/src/")).toBe(true);
    });

    test("both with trailing slashes", () => {
      expect(isPathInside("/project/", "/project/src/")).toBe(true);
    });
  });

  describe("similar prefixes", () => {
    test("/project vs /projects - not inside", () => {
      expect(isPathInside("/project", "/projects")).toBe(false);
    });

    test("/project vs /project-extra - not inside", () => {
      expect(isPathInside("/project", "/project-extra")).toBe(false);
    });

    test("/project vs /project2 - not inside", () => {
      expect(isPathInside("/project", "/project2")).toBe(false);
    });

    test("/foo/bar vs /foo/barbaz - not inside", () => {
      expect(isPathInside("/foo/bar", "/foo/barbaz")).toBe(false);
    });
  });

  describe("paths with . and .. components", () => {
    test("child with . component resolves inside", () => {
      expect(isPathInside("/project", "/project/./src")).toBe(true);
    });

    test("child with .. that stays inside", () => {
      expect(isPathInside("/project", "/project/src/../lib")).toBe(true);
    });

    test("child with .. that escapes parent", () => {
      expect(isPathInside("/project", "/project/../other")).toBe(false);
    });

    test("parent with . component", () => {
      expect(isPathInside("/project/.", "/project/src")).toBe(true);
    });
  });

  describe("root path edge cases", () => {
    test("root is parent of everything", () => {
      expect(isPathInside("/", "/anything")).toBe(true);
    });

    test("root is parent of deeply nested path", () => {
      expect(isPathInside("/", "/a/b/c/d/e")).toBe(true);
    });

    test("non-root is not parent of root", () => {
      expect(isPathInside("/project", "/")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// truncateText
// ---------------------------------------------------------------------------

describe("truncateText", () => {
  describe("under limit - unchanged", () => {
    test("short string well under limit", () => {
      expect(truncateText("hello", 100)).toBe("hello");
    });

    test("string one char under limit", () => {
      expect(truncateText("abcd", 5)).toBe("abcd");
    });

    test("empty string with positive limit", () => {
      expect(truncateText("", 10)).toBe("");
    });
  });

  describe("exactly at limit", () => {
    test("string length equals maxChars", () => {
      expect(truncateText("hello", 5)).toBe("hello");
    });

    test("single char at limit of 1", () => {
      expect(truncateText("x", 1)).toBe("x");
    });
  });

  describe("over limit - truncated", () => {
    test("string one char over limit", () => {
      expect(truncateText("abcdef", 5)).toBe("abcde");
    });

    test("long string truncated to small limit", () => {
      expect(truncateText("hello world this is a test", 5)).toBe("hello");
    });

    test("truncated to 1 char", () => {
      expect(truncateText("abcdef", 1)).toBe("a");
    });

    test("truncated to 0 chars returns empty", () => {
      expect(truncateText("abcdef", 0)).toBe("");
    });

    test("does not append any suffix", () => {
      const result = truncateText("hello world", 5);
      expect(result).toBe("hello");
      expect(result.length).toBe(5);
    });
  });

  describe("empty string", () => {
    test("empty string with zero maxChars", () => {
      expect(truncateText("", 0)).toBe("");
    });

    test("empty string with large maxChars", () => {
      expect(truncateText("", 1000)).toBe("");
    });
  });

  describe("edge cases", () => {
    test("string with newlines truncated mid-line", () => {
      expect(truncateText("line1\nline2\nline3", 8)).toBe("line1\nli");
    });

    test("unicode string truncation by char index", () => {
      const result = truncateText("abcdef", 3);
      expect(result).toBe("abc");
    });

    test("very large maxChars with short string", () => {
      expect(truncateText("hi", 1_000_000)).toBe("hi");
    });
  });
});

// ---------------------------------------------------------------------------
// truncateLine
// ---------------------------------------------------------------------------

describe("truncateLine", () => {
  describe("under limit - unchanged", () => {
    test("short string well under limit", () => {
      expect(truncateLine("hello", 100)).toBe("hello");
    });

    test("string one char under limit", () => {
      expect(truncateLine("abcd", 5)).toBe("abcd");
    });

    test("empty string with positive limit", () => {
      expect(truncateLine("", 10)).toBe("");
    });
  });

  describe("exactly at limit", () => {
    test("string length equals maxChars", () => {
      expect(truncateLine("hello", 5)).toBe("hello");
    });

    test("single char at limit of 1", () => {
      expect(truncateLine("x", 1)).toBe("x");
    });
  });

  describe("over limit - truncated with ... suffix", () => {
    test("string one char over limit gets ... appended", () => {
      expect(truncateLine("abcdef", 5)).toBe("abcde...");
    });

    test("long string truncated to small limit with ...", () => {
      expect(truncateLine("hello world this is a test", 5)).toBe("hello...");
    });

    test("truncated to 1 char with ...", () => {
      expect(truncateLine("abcdef", 1)).toBe("a...");
    });

    test("truncated to 0 chars gives just ...", () => {
      expect(truncateLine("abcdef", 0)).toBe("...");
    });

    test("result length is maxChars + 3 when truncated", () => {
      const result = truncateLine("a very long string indeed", 5);
      expect(result.length).toBe(5 + 3);
    });

    test("suffix is exactly three dots", () => {
      const result = truncateLine("hello world", 5);
      expect(result.endsWith("...")).toBe(true);
      expect(result).toBe("hello...");
    });
  });

  describe("empty string", () => {
    test("empty string with zero maxChars", () => {
      expect(truncateLine("", 0)).toBe("");
    });

    test("empty string with large maxChars", () => {
      expect(truncateLine("", 1000)).toBe("");
    });
  });

  describe("comparison with truncateText", () => {
    test("under limit: both return same value", () => {
      const s = "short";
      expect(truncateLine(s, 100)).toBe(truncateText(s, 100));
    });

    test("at limit: both return same value", () => {
      const s = "exact";
      expect(truncateLine(s, 5)).toBe(truncateText(s, 5));
    });

    test("over limit: truncateLine has ... but truncateText does not", () => {
      const s = "longer string";
      const line = truncateLine(s, 5);
      const text = truncateText(s, 5);
      expect(line).toBe("longe...");
      expect(text).toBe("longe");
      expect(line).not.toBe(text);
    });
  });

  describe("edge cases", () => {
    test("string with newlines truncated mid-line adds ...", () => {
      expect(truncateLine("line1\nline2\nline3", 8)).toBe("line1\nli...");
    });

    test("very large maxChars with short string returns unchanged", () => {
      expect(truncateLine("hi", 1_000_000)).toBe("hi");
    });
  });
});
