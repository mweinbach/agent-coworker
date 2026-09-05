import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readLinuxCss(): string {
  return readFileSync(resolve(import.meta.dir, "../src/styles/platform/linux.css"), "utf8");
}

describe("linux desktop shell parity", () => {
  test("uses the Windows-style left rail and native titleband shell", () => {
    const css = readLinuxCss();

    expect(css).toMatch(/--platform-caption-button-reserve:\s*136px\s*;/);
    expect(css).toMatch(/--platform-collapsed-left-rail-width:\s*84px\s*;/);
    expect(css).toMatch(
      /:root\[data-platform="linux"\]\s+\.app-topbar__win32-left-rail\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/s,
    );
    expect(css).toMatch(
      /:root\[data-platform="linux"\]\s+\.app-sidebar__titleband-drag-zone\s*\{[^}]*left:\s*var\(--platform-collapsed-left-rail-width,\s*84px\);[^}]*-webkit-app-region:\s*drag\s*;/s,
    );
  });
});
