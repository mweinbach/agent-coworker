import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureArtifactRuntimeReady } from "../src/artifactRuntime";
import { buildZip, S_IFLNK, S_IFREG } from "./fixtures/zipBuilder";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-artifact-zip-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("artifact runtime download with the real (safe) extractor", () => {
  test("installs a benign archive into the cache without symlinks", async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, "home");
      await fs.mkdir(home, { recursive: true });
      const exe = process.platform === "win32" ? ".exe" : "";
      const archiveBytes = buildZip([
        { name: "runtime.json", data: JSON.stringify({ bundleVersion: "test" }) },
        {
          name: "node/node_modules/@oai/artifact-tool/package.json",
          data: JSON.stringify({ name: "@oai/artifact-tool", version: "9.9.9" }),
        },
        { name: `node/bin/node${exe}`, data: "node-binary", unixMode: S_IFREG | 0o755 },
        { name: `python/python${exe}`, data: "py-binary", unixMode: S_IFREG | 0o755 },
      ]);
      const archiveUrl = "https://download.test/artifact-runtime.zip";
      const fetchImpl = (async () =>
        new Response(new Uint8Array(archiveBytes), { status: 200 })) as typeof fetch;

      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        archiveUrl,
        fetchImpl,
      });

      const cacheDir = path.join(home, ".cache", "cowork", "artifact-runtime");
      expect(result?.archive).toMatchObject({ status: "downloaded", endpoint: archiveUrl });
      expect(result?.artifactTool.status).toBe("available");
      await expect(
        fs.stat(
          path.join(cacheDir, "node", "node_modules", "@oai", "artifact-tool", "package.json"),
        ),
      ).resolves.toBeDefined();
      const nodeStat = await fs.lstat(path.join(cacheDir, "node", "bin", `node${exe}`));
      expect(nodeStat.isSymbolicLink()).toBe(false);
    });
  });

  test("fails the archive install when the archive carries a symlink", async () => {
    await withTmpDir(async (dir) => {
      const home = path.join(dir, "home");
      await fs.mkdir(home, { recursive: true });
      const archiveBytes = buildZip([
        { name: "runtime.json", data: "{}" },
        {
          name: "node/node_modules/@oai/artifact-tool/package.json",
          data: JSON.stringify({ name: "@oai/artifact-tool", version: "9.9.9" }),
        },
        { name: "node/escape", data: "../../../../../../etc", unixMode: S_IFLNK | 0o777 },
      ]);
      const archiveUrl = "https://download.test/evil-artifact-runtime.zip";
      const fetchImpl = (async () =>
        new Response(new Uint8Array(archiveBytes), { status: 200 })) as typeof fetch;

      const result = await ensureArtifactRuntimeReady({
        homedir: home,
        env: {},
        archiveUrl,
        fetchImpl,
      });

      expect(result?.archive.status).toBe("failed");
      expect(result?.archive.reason ?? "").toMatch(/symlink/i);
      expect(result?.artifactTool.status).toBe("missing");
      const cacheDir = path.join(home, ".cache", "cowork", "artifact-runtime");
      await expect(fs.stat(cacheDir)).rejects.toThrow();
    });
  });
});
