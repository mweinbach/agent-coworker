import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildBunBundle, resolveBundledBunRuntimeVersion } from "../scripts/releaseBuildUtils";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-release-build-utils-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("release build utils", () => {
  test("pins the Windows ARM64 bundled Bun runtime to the release-smoked version", () => {
    expect(resolveBundledBunRuntimeVersion({ platform: "win32", arch: "arm64" }, {})).toBe(
      "1.3.13",
    );
    expect(
      resolveBundledBunRuntimeVersion(
        { platform: "win32", arch: "arm64" },
        { COWORK_BUNDLED_BUN_RUNTIME_VERSION: "1.3.14" },
      ),
    ).toBe("1.3.14");
    expect(resolveBundledBunRuntimeVersion({ platform: "darwin", arch: "arm64" }, {})).toBe(
      Bun.version,
    );
  });

  test("buildBunBundle writes a Bun-target bundle without spawning the CLI", async () => {
    const dir = await makeTempDir();
    const entry = path.join(dir, "entry.ts");
    const outfile = path.join(dir, "resources", "binaries", "server", "index.js");
    await fs.writeFile(
      entry,
      "export const value = process.env.COWORK_DESKTOP_BUNDLE;\nconsole.log(value);\n",
      "utf8",
    );

    const previousDesktopBundleEnv = process.env.COWORK_DESKTOP_BUNDLE;
    process.env.COWORK_DESKTOP_BUNDLE = "1";
    try {
      await buildBunBundle({
        entry,
        env: "COWORK_DESKTOP_BUNDLE*",
        minify: false,
        outfile,
      });
    } finally {
      if (previousDesktopBundleEnv === undefined) {
        delete process.env.COWORK_DESKTOP_BUNDLE;
      } else {
        process.env.COWORK_DESKTOP_BUNDLE = previousDesktopBundleEnv;
      }
    }

    const bundled = await fs.readFile(outfile, "utf8");
    expect(bundled).toContain('var value = "1"');
    expect(bundled).not.toContain("process.env.COWORK_DESKTOP_BUNDLE");
  });
});
