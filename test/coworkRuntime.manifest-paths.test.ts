import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  assertSafeRelativePath,
  RUNTIME_MANIFEST_FILE,
  readRuntimeManifest,
} from "../src/coworkRuntime/manifest";
import type { CoworkRuntimeManifest } from "../src/coworkRuntime/types";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(import.meta.dir, "tmp-runtime-manifest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const safePaths: CoworkRuntimeManifest["paths"] = {
  bin: "..hidden/bin",
  node: "dependencies/node",
  python: "dependencies/python",
  nodeModules: "dependencies/node_modules",
  nodeResolver: "cowork/node-resolver/register.mjs",
  artifactToolPackage: "dependencies/artifact-tool",
};

function buildManifest(): CoworkRuntimeManifest {
  return {
    schemaVersion: 1,
    version: "2026-10-31",
    createdAt: "2026-10-31T00:00:00.000Z",
    asset: "linux-x86",
    assetFileName: "cowork-runtime-linux-x86.zip",
    compatibleHosts: ["linux-x64"],
    source: {
      kind: "codex-primary-runtime",
      bundleVersion: "fixture.1",
      targetPlatform: "linux",
      targetArch: "x64",
    },
    components: [{ id: "tool", strategy: "copied", path: "..hidden/tool" }],
    versions: {},
    paths: { ...safePaths },
    payload: { fileCount: 0, unpackedBytes: 0 },
  };
}

describe("assertSafeRelativePath", () => {
  test("rejects empty, absolute, drive, and non-normalized runtime paths", () => {
    for (const value of ["", "a\0b", "bin\\node"]) {
      expect(() => assertSafeRelativePath(value)).toThrow(
        "path must be a non-empty POSIX relative path.",
      );
    }
    expect(() => assertSafeRelativePath("/etc/passwd")).toThrow(
      "path must not be absolute: /etc/passwd",
    );
    expect(() => assertSafeRelativePath("C:evil")).toThrow("path must not be absolute: C:evil");
    expect(() => assertSafeRelativePath("c:/windows/system32")).toThrow(
      "path must not be absolute: c:/windows/system32",
    );
    for (const value of [
      "..",
      "../etc/passwd",
      "foo/../../etc",
      "foo/../bar",
      "bin/./node",
      "bin//node",
      "./bin",
    ]) {
      expect(() => assertSafeRelativePath(value, "paths.bin")).toThrow(
        `paths.bin escapes or is not normalized: ${value}`,
      );
    }
  });

  test("accepts normalized relative paths, including dot-dot lookalikes", () => {
    expect(() => assertSafeRelativePath("dependencies/bin")).not.toThrow();
    expect(() => assertSafeRelativePath("..hidden/file")).not.toThrow();
    expect(() => assertSafeRelativePath(".../notes")).not.toThrow();
  });
});

describe("readRuntimeManifest path containment", () => {
  test("loads a manifest whose paths are already normalized", async () => {
    const dir = await makeTempDir();
    const manifest = buildManifest();
    await fs.writeFile(path.join(dir, RUNTIME_MANIFEST_FILE), JSON.stringify(manifest));

    await expect(readRuntimeManifest(dir)).resolves.toMatchObject({
      paths: { bin: "..hidden/bin" },
      components: [{ id: "tool", path: "..hidden/tool" }],
    });
  });

  test("rejects a component path that normalizes inside but is not normalized", async () => {
    const dir = await makeTempDir();
    const manifest = buildManifest();
    const component = manifest.components[0];
    if (!component) throw new Error("fixture component missing");
    component.path = "foo/../bar";
    await fs.writeFile(path.join(dir, RUNTIME_MANIFEST_FILE), JSON.stringify(manifest));

    await expect(readRuntimeManifest(dir)).rejects.toThrow(
      "components.tool.path escapes or is not normalized: foo/../bar",
    );
  });

  test("rejects an absolute or drive-letter path field before the runtime is used", async () => {
    const dir = await makeTempDir();
    const absolute = buildManifest();
    absolute.paths.node = "bin/./node";
    await fs.writeFile(path.join(dir, RUNTIME_MANIFEST_FILE), JSON.stringify(absolute));
    await expect(readRuntimeManifest(dir)).rejects.toThrow(
      "paths.node escapes or is not normalized: bin/./node",
    );

    const drive = buildManifest();
    drive.paths.python = "C:evil";
    await fs.writeFile(path.join(dir, RUNTIME_MANIFEST_FILE), JSON.stringify(drive));
    await expect(readRuntimeManifest(dir)).rejects.toThrow(
      "paths.python must not be absolute: C:evil",
    );

    const typed = buildManifest();
    (typed.paths as { pnpm?: unknown }).pnpm = 1;
    await fs.writeFile(path.join(dir, RUNTIME_MANIFEST_FILE), JSON.stringify(typed));
    await expect(readRuntimeManifest(dir)).rejects.toThrow("paths.pnpm must be a string.");
  });
});
