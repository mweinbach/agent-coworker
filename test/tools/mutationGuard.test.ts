import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { removeWithRetry } from "../../src/platform/fs";
import { scratchRoots } from "../../src/platform/sandbox";
import type { ToolContext } from "../../src/tools/context";
import { cleanupCreatedDirectories, prepareMutationDirectory } from "../../src/tools/mutationGuard";
import { makeConfig } from "./tools.harness";

const cleanupPaths = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(scratchRoots()[0] ?? "/tmp", prefix));
  cleanupPaths.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (target) => {
      await removeWithRetry(target, { recursive: true, bestEffort: true });
      cleanupPaths.delete(target);
    }),
  );
});

function makeGateCtx(
  workspace: string,
  assertCanMutate: ToolContext["assertCanMutate"],
): ToolContext {
  return {
    config: makeConfig(workspace),
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    shellPolicy: "full",
    assertCanMutate,
  };
}

describe("prepareMutationDirectory", () => {
  test("rolls back created dirs when the post-mkdir gate denies", async () => {
    const workspace = await makeTempDir("cowork-mutation-guard-rollback-");
    const target = path.join(workspace, "a", "b", "c");
    let checks = 0;

    await expect(
      prepareMutationDirectory(
        makeGateCtx(workspace, () => {
          checks += 1;
          if (checks > 1) throw new Error("gate closed");
        }),
        "write",
        target,
      ),
    ).rejects.toThrow("gate closed");

    expect(checks).toBe(2);
    await expect(fs.access(path.join(workspace, "a"))).rejects.toThrow();
  });

  test("does not mkdir when the pre-mkdir gate denies", async () => {
    const workspace = await makeTempDir("cowork-mutation-guard-predeny-");
    const target = path.join(workspace, "blocked", "nested");

    await expect(
      prepareMutationDirectory(
        makeGateCtx(workspace, () => {
          throw new Error("gate closed before mkdir");
        }),
        "write",
        target,
      ),
    ).rejects.toThrow("gate closed before mkdir");

    await expect(fs.access(path.join(workspace, "blocked"))).rejects.toThrow();
  });

  test("returns empty when the target directory already exists", async () => {
    const workspace = await makeTempDir("cowork-mutation-guard-exists-");
    const target = path.join(workspace, "existing");
    await fs.mkdir(target, { recursive: true });
    let checks = 0;

    const created = await prepareMutationDirectory(
      makeGateCtx(workspace, () => {
        checks += 1;
      }),
      "write",
      target,
    );

    expect(created).toEqual([]);
    expect(checks).toBe(1);
  });

  test("only rolls back newly created segments when a parent already exists", async () => {
    const workspace = await makeTempDir("cowork-mutation-guard-partial-");
    const parent = path.join(workspace, "parent");
    const target = path.join(parent, "new");
    await fs.mkdir(parent, { recursive: true });
    let checks = 0;

    await expect(
      prepareMutationDirectory(
        makeGateCtx(workspace, () => {
          checks += 1;
          if (checks > 1) throw new Error("gate closed");
        }),
        "write",
        target,
      ),
    ).rejects.toThrow("gate closed");

    expect((await fs.stat(parent)).isDirectory()).toBe(true);
    await expect(fs.access(target)).rejects.toThrow();
  });
});

describe("cleanupCreatedDirectories", () => {
  test("ignores ENOENT and ENOTEMPTY without throwing", async () => {
    const workspace = await makeTempDir("cowork-mutation-guard-cleanup-");
    const missing = path.join(workspace, "already-gone");
    const occupied = path.join(workspace, "occupied");
    await fs.mkdir(occupied, { recursive: true });
    await fs.writeFile(path.join(occupied, "keep.txt"), "stay", "utf-8");

    await cleanupCreatedDirectories([missing, occupied]);

    expect((await fs.stat(occupied)).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(occupied, "keep.txt"), "utf-8")).resolves.toBe("stay");
  });
});
