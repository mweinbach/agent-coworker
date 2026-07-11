import fs from "node:fs/promises";
import path from "node:path";

import type { App } from "electron";

import type { ThemeSource } from "../../src/lib/desktopApi";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function normalizeThemeSource(value: unknown): ThemeSource {
  return value === "light" || value === "dark" ? value : "system";
}

export class AppearancePreferences {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly electronApp: Pick<App, "getPath">) {}

  private get filePath(): string {
    return path.join(this.electronApp.getPath("userData"), "appearance.json");
  }

  async loadThemeSource(): Promise<ThemeSource> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return "system";
      }
      return normalizeThemeSource((parsed as { themeSource?: unknown }).themeSource);
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) {
        return "system";
      }
      throw error;
    }
  }

  async saveThemeSource(themeSource: ThemeSource): Promise<void> {
    const normalized = normalizeThemeSource(themeSource);
    const write = this.pendingWrite.then(async () => {
      const directory = path.dirname(this.filePath);
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
      await fs.writeFile(
        temporaryPath,
        `${JSON.stringify({ themeSource: normalized }, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: PRIVATE_FILE_MODE,
        },
      );
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, PRIVATE_FILE_MODE);
    });
    this.pendingWrite = write.catch(() => {});
    await write;
  }
}
