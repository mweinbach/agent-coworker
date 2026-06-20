import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  canonicalWorkspacePath,
  sameWorkspacePath,
  workspacePathOverlaps,
} from "../src/utils/workspacePath";

async function withWindowsCwd<T>(cwd: string, run: () => T | Promise<T>): Promise<T> {
  const originalCwd = process.cwd;
  Object.defineProperty(process, "cwd", {
    configurable: true,
    value: () => cwd,
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "cwd", {
      configurable: true,
      value: originalCwd,
    });
  }
}

describe("workspacePath", () => {
  test("sameWorkspacePath keeps POSIX comparisons case-sensitive", () => {
    expect(sameWorkspacePath("/tmp/repo", "/tmp/repo/.", "linux")).toBe(true);
    expect(sameWorkspacePath("/tmp/repo", "/tmp/Repo", "linux")).toBe(false);
  });

  test("sameWorkspacePath compares Windows paths case-insensitively", () => {
    expect(sameWorkspacePath("C:\\Repo", "c:\\repo\\.", "win32")).toBe(true);
    expect(sameWorkspacePath("C:/Repo/src", "c:\\repo\\src", "win32")).toBe(true);
  });

  test("canonicalWorkspacePath normalizes Windows paths before case folding", () => {
    expect(canonicalWorkspacePath("C:\\Repo\\..\\Repo\\Subdir\\.", "win32")).toBe(
      "c:\\repo\\subdir",
    );
  });

  test("canonicalWorkspacePath preserves Windows current-drive rooted paths", () => {
    return withWindowsCwd("D:\\Users\\me", () => {
      expect(canonicalWorkspacePath("\\repo\\subdir\\.", "win32")).toBe("d:\\repo\\subdir");
    });
  });

  test("canonicalWorkspacePath resolves same-drive Windows drive-relative paths from cwd", () => {
    return withWindowsCwd("C:\\Users\\me", () => {
      const expected = path.win32.resolve("C:\\Users\\me", "C:repo").toLowerCase();
      expect(canonicalWorkspacePath("C:repo", "win32")).toBe(expected);
      expect(canonicalWorkspacePath("C:repo")).not.toContain("\\c:repo");
    });
  });

  test("canonicalWorkspacePath resolves different-drive Windows drive-relative paths from drive root", () => {
    return withWindowsCwd("D:\\Users\\me", () => {
      expect(canonicalWorkspacePath("C:repo", "win32")).toBe("c:\\repo");
      expect(canonicalWorkspacePath("C:repo", "win32")).not.toContain("\\c:repo");
    });
  });

  test("canonicalWorkspacePath handles Windows drive-only and rooted forms", () => {
    return withWindowsCwd("C:\\Users\\me", () => {
      expect(canonicalWorkspacePath("C:", "win32")).toBe("c:\\users\\me");
      expect(canonicalWorkspacePath("D:", "win32")).toBe("d:\\");
      expect(canonicalWorkspacePath("C:\\repo", "win32")).toBe("c:\\repo");
    });
  });

  test("canonicalWorkspacePath normalizes Windows drive-relative dot segments", () => {
    return withWindowsCwd("C:\\Users\\me\\project", () => {
      expect(canonicalWorkspacePath("C:.", "win32")).toBe("c:\\users\\me\\project");
      expect(canonicalWorkspacePath("C:..", "win32")).toBe("c:\\users\\me");
      expect(canonicalWorkspacePath("C:.\\repo", "win32")).toBe("c:\\users\\me\\project\\repo");
      expect(canonicalWorkspacePath("C:..\\repo", "win32")).toBe("c:\\users\\me\\repo");
      expect(canonicalWorkspacePath("D:.", "win32")).toBe("d:\\");
      expect(canonicalWorkspacePath("D:..", "win32")).toBe("d:\\");
      expect(canonicalWorkspacePath("C:repo\\..\\Other\\.", "win32")).toBe(
        "c:\\users\\me\\project\\other",
      );
    });
  });

  test("canonicalWorkspacePath keeps Windows drive-relative paths case-folded", () => {
    return withWindowsCwd("C:\\Users\\me", () => {
      expect(canonicalWorkspacePath("c:Repo\\Sub", "win32")).toBe("c:\\users\\me\\repo\\sub");
    });
  });

  test("canonicalWorkspacePath preserves Windows UNC and mixed separators", () => {
    expect(canonicalWorkspacePath("\\\\Server\\Share\\repo\\..\\Other", "win32")).toBe(
      "\\\\server\\share\\other",
    );

    return withWindowsCwd("C:\\Users\\me", () => {
      expect(canonicalWorkspacePath("C:repo/child\\..\\other", "win32")).toBe(
        "c:\\users\\me\\repo\\other",
      );
    });
  });

  describe("workspacePathOverlaps", () => {
    test("equal paths overlap", () => {
      expect(workspacePathOverlaps("/tmp/repo", "/tmp/repo", "linux")).toBe(true);
    });

    test("source is ancestor of target", () => {
      expect(workspacePathOverlaps("/workspace", "/workspace/.cowork/skills/foo", "linux")).toBe(
        true,
      );
    });

    test("target is ancestor of source", () => {
      expect(workspacePathOverlaps("/workspace/.cowork/skills/foo", "/workspace", "linux")).toBe(
        true,
      );
    });

    test("sibling paths do not overlap", () => {
      expect(workspacePathOverlaps("/tmp/a", "/tmp/b", "linux")).toBe(false);
    });

    test("path prefix that is not a directory boundary does not overlap", () => {
      expect(workspacePathOverlaps("/tmp/repo-extra", "/tmp/repo", "linux")).toBe(false);
    });

    test("overlap detection works with trailing separators / dots", () => {
      expect(workspacePathOverlaps("/tmp/repo/.", "/tmp/repo/sub", "linux")).toBe(true);
    });

    test("Windows ancestor overlap is case-insensitive", () => {
      expect(workspacePathOverlaps("C:\\Repo", "c:\\repo\\skills\\foo", "win32")).toBe(true);
    });

    test("Windows drive-relative workspace equality uses the current drive cwd", () => {
      return withWindowsCwd("C:\\Users\\me", () => {
        expect(sameWorkspacePath("C:repo", "C:\\Users\\me\\repo", "win32")).toBe(true);
      });
    });

    test("Windows drive-relative workspace overlap does not retain colon path segments", () => {
      return withWindowsCwd("D:\\Users\\me", () => {
        expect(workspacePathOverlaps("C:repo", "C:\\repo\\child", "win32")).toBe(true);
        expect(canonicalWorkspacePath("C:repo\\child", "win32")).toBe("c:\\repo\\child");
      });
    });
  });
});
