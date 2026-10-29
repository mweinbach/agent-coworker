import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalizeSync } from "../src/platform/paths";
import { scratchRoots } from "../src/platform/sandbox/policy";
import { resolvePathInsideRootForBoundaryCheck } from "../src/utils/paths";
import { symlinkOrJunction } from "./helpers/platform";

const fixtures: string[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

async function makeFixture(): Promise<string> {
  const fixture = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-boundary-"));
  fixtures.push(fixture);
  return fixture;
}

describe("resolvePathInsideRootForBoundaryCheck", () => {
  test("returns the canonical path of a file inside the root", async () => {
    const fixture = await makeFixture();
    const project = path.join(fixture, "project");
    const file = path.join(project, "src", "ok.txt");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "ok");

    await expect(resolvePathInsideRootForBoundaryCheck(project, file)).resolves.toBe(
      canonicalizeSync(file),
    );
  });

  test("keeps a not-yet-created path under an existing in-root directory", async () => {
    const fixture = await makeFixture();
    const project = path.join(fixture, "project");
    const missing = path.join(project, "src", "new.txt");
    await fs.mkdir(path.dirname(missing), { recursive: true });

    await expect(resolvePathInsideRootForBoundaryCheck(project, missing)).resolves.toBe(
      canonicalizeSync(missing),
    );
  });

  test("accepts a real file when the root path is a symlink to that tree", async () => {
    const fixture = await makeFixture();
    const project = path.join(fixture, "project");
    const file = path.join(project, "src", "ok.txt");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "ok");
    const aliasRoot = path.join(fixture, "alias-root");
    const link = await symlinkOrJunction(project, aliasRoot, { type: "dir" });
    expect(link.created).toBe(true);

    const throughAlias = path.join(aliasRoot, "src", "ok.txt");
    await expect(resolvePathInsideRootForBoundaryCheck(aliasRoot, throughAlias)).resolves.toBe(
      canonicalizeSync(throughAlias),
    );
  });

  test("rejects a lexical escape before canonicalization", async () => {
    const fixture = await makeFixture();
    const project = path.join(fixture, "project");
    const outside = path.join(fixture, "outside", "secret.txt");
    const lookalike = path.join(fixture, "project-extra", "secret.txt");
    await fs.mkdir(project);
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.mkdir(path.dirname(lookalike), { recursive: true });
    await fs.writeFile(outside, "secret");

    const escaped = path.resolve(project, "../outside/secret.txt");
    await expect(resolvePathInsideRootForBoundaryCheck(project, escaped)).rejects.toThrow(
      `Path is outside root: ${escaped}`,
    );
    await expect(resolvePathInsideRootForBoundaryCheck(project, lookalike)).rejects.toThrow(
      `Path is outside root: ${path.resolve(lookalike)}`,
    );
  });

  test("rejects an in-root directory symlink whose target leaves the root", async () => {
    const fixture = await makeFixture();
    const project = path.join(fixture, "project");
    const outsideDir = path.join(fixture, "outside");
    const loot = path.join(outsideDir, "loot.txt");
    await fs.mkdir(path.join(project, "src"), { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.writeFile(loot, "secret");
    const link = path.join(project, "src", "link");
    const created = await symlinkOrJunction(outsideDir, link, { type: "dir" });
    expect(created.created).toBe(true);

    const target = path.join(link, "loot.txt");
    await expect(resolvePathInsideRootForBoundaryCheck(project, target)).rejects.toThrow(
      `Path resolves outside root: ${canonicalizeSync(target)}`,
    );
  });

  test("rejects an in-root file symlink whose target leaves the root", async () => {
    const fixture = await makeFixture();
    const project = path.join(fixture, "project");
    const outside = path.join(fixture, "secret.txt");
    await fs.mkdir(project);
    await fs.writeFile(outside, "secret");
    const link = path.join(project, "uploads-link.txt");
    const created = await symlinkOrJunction(outside, link, { type: "file" });
    if (!created.created) {
      expect(created.skipped).toContain("win32");
      return;
    }

    await expect(resolvePathInsideRootForBoundaryCheck(project, link)).rejects.toThrow(
      `Path resolves outside root: ${canonicalizeSync(link)}`,
    );
  });

  test("accepts a symlink that stays inside the root", async () => {
    const fixture = await makeFixture();
    const project = path.join(fixture, "project");
    const realDir = path.join(project, "real");
    const file = path.join(realDir, "inside.txt");
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(file, "ok");
    const alias = path.join(project, "alias");
    const created = await symlinkOrJunction(realDir, alias, { type: "dir" });
    expect(created.created).toBe(true);

    const inside = path.join(alias, "inside.txt");
    await expect(resolvePathInsideRootForBoundaryCheck(project, inside)).resolves.toBe(
      canonicalizeSync(inside),
    );
  });
});
