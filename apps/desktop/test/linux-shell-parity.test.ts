import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readLinuxCss(): string {
  return readFileSync(resolve(import.meta.dir, "../src/styles/platform/linux.css"), "utf8");
}

function readPlatformTokensCss(): string {
  return readFileSync(resolve(import.meta.dir, "../src/styles/tokens/platform.css"), "utf8");
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

  test("matches the Windows main-card shell geometry on chat and settings surfaces", () => {
    const css = readLinuxCss();

    expect(css).toMatch(
      /:root\[data-platform="linux"\]\s+\.app-chat-body\s*\{[^}]*margin-top:\s*calc\(-1 \* var\(--platform-titlebar-height\)\);/s,
    );
    expect(css).toMatch(
      /:root\[data-platform="linux"\]\s+\.app-chat-body\s*>\s*\.app-main-content\s*\{[^}]*margin:\s*var\(--platform-titlebar-height\) 0 0 0;[^}]*border-top-left-radius:\s*var\(--main-card-radius\);/s,
    );
    expect(css).toMatch(
      /:root\[data-platform="linux"\]\s+\.settings-shell__main\s*\{[^}]*height:\s*calc\(100% - var\(--platform-titlebar-height\)\);[^}]*margin:\s*var\(--platform-titlebar-height\) 0 0 0;[^}]*border-top-left-radius:\s*var\(--main-card-radius\);/s,
    );
  });

  test("uses the same translucent shell tokens as Windows", () => {
    const css = readPlatformTokensCss();

    const linuxTokenRule = css.match(
      /:root\[data-platform="linux"\]:not\(\[data-reduced-transparency="true"\]\)\s*\{([^}]*)\}/s,
    );

    expect(linuxTokenRule).not.toBeNull();
    const body = linuxTokenRule?.[1] ?? "";

    expect(body).toMatch(/--sidebar-pane-surface:\s*color-mix\(in srgb, var\(--sidebar-bg\) 20%, transparent\);/);
    expect(body).toMatch(/--sidebar-blur:\s*0px\s*;/);
    expect(body).toMatch(/--sidebar-titlebar-blur:\s*0px\s*;/);
    expect(body).toMatch(/--surface-main-card:\s*color-mix\(in srgb, var\(--panel-bg\) 94%, transparent\);/);
    expect(body).toMatch(/--main-card-radius:\s*10px\s*;/);
    expect(body).toMatch(/--surface-overlay:\s*color-mix\(in srgb, var\(--panel-bg\) 72%, transparent\);/);
  });
});
