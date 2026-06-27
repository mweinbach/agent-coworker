import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyElectronUserDataDirOverride,
  ELECTRON_USER_DATA_DIR_ENV,
} from "../electron/services/userDataOverride";

function makeApp(isPackaged = false) {
  const paths = new Map<string, string>();
  return {
    app: {
      isPackaged,
      setPath: (name: string, value: string) => {
        paths.set(name, value);
      },
    },
    paths,
  };
}

describe("applyElectronUserDataDirOverride", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs.length = 0;
  });

  async function tempRoot(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-electron-user-data-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("creates and canonicalizes a dev/test userData override before applying it", async () => {
    const root = await tempRoot();
    const requested = path.join(root, "nested", "..", "profile");
    const { app, paths } = makeApp();

    const result = applyElectronUserDataDirOverride(app, {
      [ELECTRON_USER_DATA_DIR_ENV]: requested,
    });

    const canonical = await fs.realpath(path.join(root, "profile"));
    expect(result).toEqual({ applied: true, path: canonical });
    expect(paths.get("userData")).toBe(canonical);
  });

  test("ignores missing or blank overrides", () => {
    const { app, paths } = makeApp();

    expect(applyElectronUserDataDirOverride(app, {})).toEqual({ applied: false });
    expect(applyElectronUserDataDirOverride(app, { [ELECTRON_USER_DATA_DIR_ENV]: "  " })).toEqual({
      applied: false,
    });
    expect(paths.has("userData")).toBe(false);
  });

  test("fails closed for packaged builds", async () => {
    const root = await tempRoot();
    const { app, paths } = makeApp(true);

    expect(() =>
      applyElectronUserDataDirOverride(app, { [ELECTRON_USER_DATA_DIR_ENV]: root }),
    ).toThrow(`${ELECTRON_USER_DATA_DIR_ENV} is only supported in desktop dev/test builds.`);
    expect(paths.has("userData")).toBe(false);
  });
});
