import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Modal surfaces must not carry the acrylic tint on win32/linux.
 *
 * Both platforms thin `--surface-overlay` to 72% so `backdrop-filter` can read
 * through it as Fluent acrylic. That works for light-dismiss flyouts, which sit
 * directly on app content. It fails for modals: they stack on the `bg-black/50`
 * scrim, ~12% of the backdrop still transmits, and blur erases text-scale detail
 * but not low-frequency shapes — so buttons and status pills behind the dialog
 * ghost through and the card reads as plain transparency rather than glass.
 * Measured live on win32 as a luminance delta of 30.4 at 72% versus 0.0 opaque.
 */
const MODAL_SLOTS = [
  "alert-dialog-content",
  "dialog-content",
  "drawer-content",
  "sheet-content",
] as const;

/** Light-dismiss surfaces that should keep the acrylic treatment. */
const FLYOUT_SLOTS = [
  "dropdown-menu-content",
  "popover-content",
  "select-content",
  "tooltip-content",
] as const;

async function readPlatformCss(platform: "win32" | "linux"): Promise<string> {
  return await fs.readFile(
    path.join(import.meta.dir, "..", "src", "styles", "platform", `${platform}.css`),
    "utf8",
  );
}

/** The selector list of the rule that applies the acrylic backdrop-filter. */
function acrylicSelectorBlock(css: string): string {
  const index = css.indexOf("backdrop-filter: blur(20px) saturate(1.4)");
  expect(index).toBeGreaterThan(-1);
  const blockStart = css.lastIndexOf(":root", index);
  return css.slice(blockStart, index);
}

/** The selector list of the rule that pins modals to the opaque fill. */
function opaqueModalBlock(css: string): string {
  const index = css.indexOf("--surface-overlay: var(--surface-opaque)");
  expect(index).toBeGreaterThan(-1);
  const blockStart = css.lastIndexOf(":root", index);
  return css.slice(blockStart, index);
}

describe.each(["win32", "linux"] as const)("%s modal surfaces", (platform) => {
  test("are excluded from the acrylic backdrop-filter rule", async () => {
    const acrylic = acrylicSelectorBlock(await readPlatformCss(platform));

    for (const slot of MODAL_SLOTS) {
      expect(acrylic).not.toContain(`[data-slot="${slot}"]`);
    }
  });

  test("keep acrylic on light-dismiss flyouts", async () => {
    const acrylic = acrylicSelectorBlock(await readPlatformCss(platform));

    for (const slot of FLYOUT_SLOTS) {
      expect(acrylic).toContain(`[data-slot="${slot}"]`);
    }
  });

  test("resolve the overlay surface to the opaque fill", async () => {
    const opaque = opaqueModalBlock(await readPlatformCss(platform));

    for (const slot of MODAL_SLOTS) {
      expect(opaque).toContain(`[data-slot="${slot}"]`);
    }
  });

  test("leave reduced transparency and high contrast to their own fallbacks", async () => {
    const opaque = opaqueModalBlock(await readPlatformCss(platform));

    expect(opaque).toContain('[data-reduced-transparency="true"]');
    expect(opaque).toContain('[data-high-contrast="true"]');
  });
});

describe("darwin", () => {
  test("never adopted the acrylic tint, so it needs no modal exception", async () => {
    const css = await fs.readFile(
      path.join(import.meta.dir, "..", "src", "styles", "platform", "darwin.css"),
      "utf8",
    );

    expect(css).not.toContain("backdrop-filter: blur(20px) saturate(1.4)");
    expect(css).not.toContain("--surface-overlay: var(--surface-opaque)");
  });
});
