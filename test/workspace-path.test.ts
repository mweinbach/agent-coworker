import { describe, expect, test } from "bun:test";

import { canonicalWorkspacePath, sameWorkspacePath } from "../src/utils/workspacePath";

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
    expect(canonicalWorkspacePath("C:\\Repo\\..\\Repo\\Subdir\\.", "win32")).toBe("c:\\repo\\subdir");
  });
});
