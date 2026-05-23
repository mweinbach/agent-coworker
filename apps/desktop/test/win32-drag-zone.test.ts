import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression test for the Win32 sidebar-toggle click bug.
 *
 * Bug: On Windows, the topbar's win32-left-rail hosts the sidebar toggle
 * button (with `-webkit-app-region: no-drag`). The `app-sidebar__titleband`
 * inside the sidebar pane sits directly behind the rail and used to provide
 * a drag layer that covered the entire title band, including the toggle
 * button area. Chromium's draggable-region computation walks the DOM in tree
 * order and lets later "drag" regions overwrite earlier "no-drag" regions.
 * Because the `titleband-drag-zone` appears *after* the rail's button in
 * DOM order, the drag region was re-applied over the toggle button, and
 * Windows WM_NCHITTEST treated real OS clicks on the icon as window-drag
 * gestures instead of routing them to the renderer.
 *
 * Fix: offset the drag zone past the rail's collapsed width so it cannot
 * overlap the button area. The drag zone still provides drag for the empty
 * portion of the title band to the right of the rail's buttons.
 *
 * If this regresses, the platform-control test should fail and the
 * standalone real-OS-click verification described in
 * `docs/desktop/win32-titleband-drag.md` (or similar) should reproduce the
 * bug end-to-end.
 */

function readWin32Css(): string {
  return readFileSync(resolve(import.meta.dir, "../src/styles/platform/win32.css"), "utf8");
}

describe("win32 sidebar titleband drag zone", () => {
  test("offsets the drag zone past the topbar's win32-left-rail to keep the toggle button clickable", () => {
    const css = readWin32Css();

    const dragZoneRule = css.match(
      /:root\[data-platform="win32"\]\s+\.app-sidebar__titleband-drag-zone\s*\{([^}]*)\}/s,
    );

    expect(dragZoneRule).not.toBeNull();
    const body = dragZoneRule?.[1] ?? "";

    expect(body).toMatch(/-webkit-app-region:\s*drag\s*;/);
    expect(body).toMatch(/pointer-events:\s*none\s*;/);

    expect(body).toMatch(/left:\s*var\(--platform-collapsed-left-rail-width(?:\s*,[^)]*)?\)\s*;/);
  });

  test("declares the collapsed left rail width so the drag zone offset resolves", () => {
    const css = readWin32Css();
    expect(css).toMatch(/--platform-collapsed-left-rail-width:\s*84px\s*;/);
  });

  test("keeps the win32-left-rail and its strip explicitly no-drag for the toggle button", () => {
    const css = readWin32Css();
    expect(css).toMatch(
      /:root\[data-platform="win32"\]\s+\.app-topbar__win32-left-rail\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/s,
    );
    expect(css).toMatch(
      /:root\[data-platform="win32"\]\s+\.app-topbar__win32-left-strip\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/s,
    );
    expect(css).toMatch(
      /:root\[data-platform="win32"\]\s+\.app-topbar__win32-left-strip\s*>\s*\*\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/s,
    );
  });
});
