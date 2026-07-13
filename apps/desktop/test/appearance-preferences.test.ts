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
  hardenedDirectories: string[];
  hardenedFiles: string[];
  preferences: AppearancePreferences;
}> {
  const [scratchRoot] = scratchRoots();
  if (!scratchRoot) {
    throw new Error("No platform scratch root is available for appearance preference tests.");
  }
  const directory = await fs.mkdtemp(path.join(scratchRoot, "cowork-appearance-"));
  const hardenedDirectories: string[] = [];
  const hardenedFiles: string[] = [];
  temporaryDirectories.push(directory);
  return {
    directory,
    hardenedDirectories,
    hardenedFiles,
    preferences: new AppearancePreferences(
      { getPath: () => directory },
      {
        hardenPrivateDir: async (candidate) => {
          hardenedDirectories.push(candidate);
        },
        hardenPrivateFile: async (candidate) => {
          hardenedFiles.push(candidate);
        },
      },
    ),
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
    const { directory, hardenedDirectories, hardenedFiles, preferences } =
      await createPreferences();

    expect(await preferences.loadThemeSource()).toBe("system");
    await preferences.saveThemeSource("dark");

    expect(await preferences.loadThemeSource()).toBe("dark");
    const filePath = path.join(directory, "appearance.json");
    expect(hardenedDirectories).toEqual([directory]);
    expect(hardenedFiles).toEqual([filePath]);
  });

  test("falls back safely when the preference file is malformed", async () => {
    const { directory, preferences } = await createPreferences();
    await fs.writeFile(path.join(directory, "appearance.json"), "{not json", "utf8");

    expect(await preferences.loadThemeSource()).toBe("system");
  });

  test("serializes concurrent saves so the latest theme wins atomically", async () => {
    const { preferences } = await createPreferences();

    await Promise.all([preferences.saveThemeSource("dark"), preferences.saveThemeSource("light")]);

    expect(await preferences.loadThemeSource()).toBe("light");
  });
});
