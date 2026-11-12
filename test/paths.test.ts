import { describe, expect, test } from "bun:test";
import path from "node:path";

import { hostPlatform } from "../src/platform/host";

import { isPathInside, pathCrossesProtectedMetadata } from "../src/utils/paths";

// ---------------------------------------------------------------------------
// resolveMaybeRelative
// ---------------------------------------------------------------------------

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

describe("pathCrossesProtectedMetadata", () => {
  test("detects protected metadata below child directories starting with two dots", () => {
    expect(
      pathCrossesProtectedMetadata("/project", "/project/..cache/.git/hooks/post-checkout"),
    ).toBe(true);
  });

  test("does not treat sibling paths starting with two dots as inside", () => {
    expect(pathCrossesProtectedMetadata("/project", "/..project/.git/hooks/post-checkout")).toBe(
      false,
    );
  });

  test("case-folds protected names on case-insensitive platforms (.GIT bypass)", () => {
    // Deny-side check: folds on win32 AND darwin (over-blocking is safe);
    // linux filesystems are case-sensitive, so .GIT there is a distinct dir.
    const expectFolded = hostPlatform() !== "linux";
    expect(pathCrossesProtectedMetadata("/project", "/project/.GIT/hooks/pre-commit")).toBe(
      expectFolded,
    );
    expect(pathCrossesProtectedMetadata("/project", "/project/.CoWork/skills/x.md")).toBe(
      expectFolded,
    );
    // Exact-case detection is unconditional on every platform.
    expect(pathCrossesProtectedMetadata("/project", "/project/.git/hooks/pre-commit")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// truncateText
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// truncateLine
// ---------------------------------------------------------------------------
