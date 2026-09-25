import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { parseGitHubShorthand, parseGitHubUrl } from "../src/extensions/github";
import { resolveGitHubOrLocalSource, trimSlashes } from "../src/extensions/source";

const fixtureRoots: string[] = [];

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(import.meta.dir, "extension-source-"));
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("extension source resolution", () => {
  test("trimSlashes and blank inputs fail closed", () => {
    expect(trimSlashes("/owner/repo/")).toBe("owner/repo");
    expect(() => resolveGitHubOrLocalSource("   ")).toThrow("Extension source is required");
  });

  test("parses GitHub URLs and rejects non-GitHub hosts", () => {
    expect(parseGitHubUrl("https://github.com/acme/widgets")).toEqual({
      kind: "repo",
      repo: "acme/widgets",
      url: "https://github.com/acme/widgets",
    });
    expect(parseGitHubUrl("https://github.com/acme/widgets.git")).toEqual({
      kind: "repo",
      repo: "acme/widgets",
      url: "https://github.com/acme/widgets.git",
    });
    expect(parseGitHubUrl("https://github.com/acme/widgets/tree/main/skills/foo")).toEqual({
      kind: "tree",
      repo: "acme/widgets",
      ref: "main",
      subdir: "skills/foo",
      refPath: "main/skills/foo",
      url: "https://github.com/acme/widgets/tree/main/skills/foo",
    });
    expect(parseGitHubUrl("https://github.com/acme/widgets/blob/main/skills/foo/SKILL.md")).toEqual(
      {
        kind: "blob",
        repo: "acme/widgets",
        ref: "main",
        subdir: "skills/foo",
        refPath: "main/skills/foo/SKILL.md",
        url: "https://github.com/acme/widgets/blob/main/skills/foo/SKILL.md",
      },
    );
    expect(
      parseGitHubUrl("https://raw.githubusercontent.com/acme/widgets/main/skills/foo/SKILL.md"),
    ).toEqual({
      kind: "raw",
      repo: "acme/widgets",
      ref: "main",
      subdir: "skills/foo",
      refPath: "main/skills/foo/SKILL.md",
      url: "https://raw.githubusercontent.com/acme/widgets/main/skills/foo/SKILL.md",
    });
    expect(parseGitHubUrl("https://example.com/acme/widgets")).toBeNull();
    expect(parseGitHubUrl("javascript:alert(1)")).toBeNull();
    expect(parseGitHubUrl("https://github.com/acme")).toBeNull();
    expect(parseGitHubShorthand("acme/widgets")).toEqual({
      kind: "repo",
      repo: "acme/widgets",
      url: "https://github.com/acme/widgets",
    });
    expect(parseGitHubShorthand("acme/widgets/extra")).toBeNull();
  });

  test("treats an existing local shorthand path as local instead of GitHub", async () => {
    const cwd = await makeFixture();
    const local = path.join(cwd, "acme", "widgets");
    await fs.mkdir(local, { recursive: true });

    expect(resolveGitHubOrLocalSource("acme/widgets", cwd)).toEqual({
      kind: "local_path",
      raw: "acme/widgets",
      displaySource: local,
      localPath: local,
    });
    expect(resolveGitHubOrLocalSource("acme/missing", cwd)).toEqual({
      kind: "github_shorthand",
      raw: "acme/missing",
      displaySource: "https://github.com/acme/missing",
      url: "https://github.com/acme/missing",
      repo: "acme/missing",
    });
  });

  test("resolves relative local paths against the provided cwd", async () => {
    const cwd = await makeFixture();
    expect(resolveGitHubOrLocalSource("./plugins/demo", cwd)).toEqual({
      kind: "local_path",
      raw: "./plugins/demo",
      displaySource: path.join(cwd, "plugins", "demo"),
      localPath: path.join(cwd, "plugins", "demo"),
    });
  });
});
