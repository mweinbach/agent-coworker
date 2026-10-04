import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  cleanupCreatedDirectories,
  prepareMutationDirectory,
  withFileMutation,
} from "../../src/tools/mutationGuard";
import { makeCtx } from "./tools.harness";

const fixtureRoots: string[] = [];

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(import.meta.dir, "mutation-guard-"));
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("withFileMutation", () => {
  test("rejects sandbox read-only and no-project-write before touching the file", async () => {
    const dir = await makeFixture();
    const filePath = path.join(dir, "notes.txt");
    await fs.writeFile(filePath, "original");

    await expect(
      withFileMutation(
        makeCtx(dir, { sandboxPolicy: { kind: "read-only", network: false } }),
        "write",
        filePath,
        async () => {
          throw new Error("mutate must not run");
        },
      ),
    ).rejects.toThrow("write blocked: sandbox mode is read-only");

    await expect(
      withFileMutation(
        makeCtx(dir, { sandboxPolicy: { kind: "no-project-write", network: false } }),
        "edit",
        filePath,
        async () => {
          throw new Error("mutate must not run");
        },
      ),
    ).rejects.toThrow("edit blocked: sandbox mode is no-project-write");

    expect(await fs.readFile(filePath, "utf8")).toBe("original");
  });

  test("rejects when the file contents change between read and commit", async () => {
    const dir = await makeFixture();
    const filePath = path.join(dir, "notes.txt");
    await fs.writeFile(filePath, "original");

    await expect(
      withFileMutation(makeCtx(dir), "write", filePath, async ({ commit }) => {
        await fs.writeFile(filePath, "changed-by-another-writer");
        await commit("replacement");
      }),
    ).rejects.toThrow(/file changed during mutation; read it again before retrying/);

    expect(await fs.readFile(filePath, "utf8")).toBe("changed-by-another-writer");
  });

  test("rejects when the path is rebound to a different file before commit", async () => {
    const dir = await makeFixture();
    const filePath = path.join(dir, "notes.txt");
    const otherPath = path.join(dir, "other.txt");
    await fs.writeFile(filePath, "original");
    await fs.writeFile(otherPath, "other");

    await expect(
      withFileMutation(makeCtx(dir), "write", filePath, async ({ commit }) => {
        await fs.unlink(filePath);
        await fs.symlink(otherPath, filePath);
        await commit("replacement");
      }),
    ).rejects.toThrow(/file path changed during mutation/);

    expect(await fs.readFile(otherPath, "utf8")).toBe("other");
  });

  test("honors an already-aborted turn without creating files", async () => {
    const dir = await makeFixture();
    const filePath = path.join(dir, "nested", "notes.txt");
    const controller = new AbortController();
    controller.abort();

    await expect(
      withFileMutation(
        makeCtx(dir, { abortSignal: controller.signal }),
        "write",
        filePath,
        async ({ commit }) => {
          await commit("must not be written");
        },
      ),
    ).rejects.toThrow(/abort|cancel/i);

    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("commits a new file and keeps created parent directories", async () => {
    const dir = await makeFixture();
    const filePath = path.join(dir, "nested", "notes.txt");

    const result = await withFileMutation(
      makeCtx(dir),
      "write",
      filePath,
      async ({ commit, stat }) => {
        expect(stat).toBeNull();
        await commit("hello");
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(await fs.readFile(filePath, "utf8")).toBe("hello");
  });
});

describe("prepareMutationDirectory", () => {
  test("rolls back newly created directories when the late mutate gate fails", async () => {
    const dir = await makeFixture();
    const missing = path.join(dir, "a", "b", "c");
    let calls = 0;

    await expect(
      prepareMutationDirectory(
        makeCtx(dir, {
          assertCanMutate: () => {
            calls += 1;
            if (calls > 1) throw new Error("denied after mkdir");
          },
        }),
        "write",
        missing,
      ),
    ).rejects.toThrow("denied after mkdir");

    expect(calls).toBe(2);
    await expect(fs.stat(path.join(dir, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cleanupCreatedDirectories ignores leftover non-empty directories", async () => {
    const dir = await makeFixture();
    const nested = path.join(dir, "keep");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "file.txt"), "stay");

    await cleanupCreatedDirectories([nested]);
    expect(await fs.readFile(path.join(nested, "file.txt"), "utf8")).toBe("stay");
  });
});
