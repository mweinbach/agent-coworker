import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { parseGitHubShorthand, parseGitHubUrl } from "../src/extensions/github";
import { resolveGitHubOrLocalSource } from "../src/extensions/source";
import { scratchRoots } from "../src/platform/sandbox/policy";

describe("GitHub install source parsing", () => {
  test("parses owner/repo shorthand and strips .git", () => {
    expect(parseGitHubShorthand("  owner/repo  ")).toEqual({
      kind: "repo",
      repo: "owner/repo",
      url: "https://github.com/owner/repo",
    });
    expect(parseGitHubShorthand("/owner/repo.git/")).toEqual({
      kind: "repo",
      repo: "owner/repo",
      url: "https://github.com/owner/repo",
    });
    expect(parseGitHubShorthand("owner/repo/extra")).toBeNull();
    expect(parseGitHubShorthand("https://github.com/owner/repo")).toBeNull();
    expect(parseGitHubShorthand("owner repo")).toBeNull();
  });

  test("parses github.com tree, blob, and raw URLs", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo")).toEqual({
      kind: "repo",
      repo: "owner/repo",
      url: "https://github.com/owner/repo",
    });
    expect(parseGitHubUrl("https://www.github.com/owner/repo.git/tree/main/src")).toEqual({
      kind: "tree",
      repo: "owner/repo",
      ref: "main",
      subdir: "src",
      refPath: "main/src",
      url: "https://www.github.com/owner/repo.git/tree/main/src",
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/blob/main/src/file.ts")).toEqual({
      kind: "blob",
      repo: "owner/repo",
      ref: "main",
      subdir: "src",
      refPath: "main/src/file.ts",
      url: "https://github.com/owner/repo/blob/main/src/file.ts",
    });
    expect(parseGitHubUrl("https://raw.githubusercontent.com/owner/repo/main/src/file.ts")).toEqual(
      {
        kind: "raw",
        repo: "owner/repo",
        ref: "main",
        subdir: "src",
        refPath: "main/src/file.ts",
        url: "https://raw.githubusercontent.com/owner/repo/main/src/file.ts",
      },
    );
  });

  test("rejects non-GitHub hosts, short paths, and malformed URLs", () => {
    expect(parseGitHubUrl("https://gitlab.com/owner/repo")).toBeNull();
    expect(parseGitHubUrl("https://github.com.evil.com/owner/repo")).toBeNull();
    expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
    expect(parseGitHubUrl("https://raw.githubusercontent.com/owner/repo/main")).toBeNull();
    expect(parseGitHubUrl("javascript:alert(1)")).toBeNull();
    expect(parseGitHubUrl("not a url")).toBeNull();
  });
});

describe("resolveGitHubOrLocalSource", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", "cowork-github-source-"));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  test("throws on empty input", () => {
    expect(() => resolveGitHubOrLocalSource("  ", cwd)).toThrow("Extension source is required");
  });

  test("treats a missing owner/repo path as GitHub shorthand", () => {
    expect(resolveGitHubOrLocalSource("owner/repo", cwd)).toEqual({
      kind: "github_shorthand",
      raw: "owner/repo",
      displaySource: "https://github.com/owner/repo",
      url: "https://github.com/owner/repo",
      repo: "owner/repo",
    });
  });

  test("prefers an existing local path that looks like shorthand", async () => {
    const local = path.join(cwd, "owner", "repo");
    await fs.mkdir(local, { recursive: true });

    expect(resolveGitHubOrLocalSource("owner/repo", cwd)).toEqual({
      kind: "local_path",
      raw: "owner/repo",
      displaySource: local,
      localPath: local,
    });
  });
});
