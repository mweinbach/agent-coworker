import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox";
import {
  AppearancePreferences,
  normalizeThemeSource,
} from "../electron/services/appearancePreferences";

const temporaryDirectories: string[] = [];

async function createPreferences(): Promise<{
  directory: string;
  preferences: AppearancePreferences;
}> {
  const [scratchRoot] = scratchRoots();
  if (!scratchRoot) {
    throw new Error("No platform scratch root is available for appearance preference tests.");
  }
  const directory = await fs.mkdtemp(path.join(scratchRoot, "cowork-appearance-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    preferences: new AppearancePreferences({
      getPath: () => directory,
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("appearance preferences", () => {
  test("normalizes unknown values to the system theme", () => {
    expect(normalizeThemeSource("light")).toBe("light");
    expect(normalizeThemeSource("dark")).toBe("dark");
    expect(normalizeThemeSource("sepia")).toBe("system");
  });

  test("round-trips the native first-paint theme source", async () => {
    const { directory, preferences } = await createPreferences();

    expect(await preferences.loadThemeSource()).toBe("system");
    await preferences.saveThemeSource("dark");

    expect(await preferences.loadThemeSource()).toBe("dark");
    const stat = await fs.stat(path.join(directory, "appearance.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("falls back safely when the preference file is malformed", async () => {
    const { directory, preferences } = await createPreferences();
    await fs.writeFile(path.join(directory, "appearance.json"), "{not json", "utf8");

    expect(await preferences.loadThemeSource()).toBe("system");
  });
});
