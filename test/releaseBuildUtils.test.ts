import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildBunBundle } from "../scripts/releaseBuildUtils";

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
