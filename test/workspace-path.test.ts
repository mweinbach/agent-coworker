import { describe, expect, test } from "bun:test";

import {
  canonicalWorkspacePath,
  sameWorkspacePath,
  workspacePathOverlaps,
} from "../src/utils/workspacePath";

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

  describe("workspacePathOverlaps", () => {
    test("equal paths overlap", () => {
      expect(workspacePathOverlaps("/tmp/repo", "/tmp/repo", "linux")).toBe(true);
    });

    test("source is ancestor of target", () => {
      expect(workspacePathOverlaps("/workspace", "/workspace/.agent/skills/foo", "linux")).toBe(
        true,
      );
    });

    test("target is ancestor of source", () => {
      expect(workspacePathOverlaps("/workspace/.agent/skills/foo", "/workspace", "linux")).toBe(
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
  });
});
