import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsShell, getSettingsGroups } from "../src/ui/settings/SettingsShell";

describe("settings shell", () => {
  test("shows remote access when the feature is enabled", () => {
    const pageIds = getSettingsGroups(true).flatMap((group) => group.pages.map((page) => page.id));
    expect(pageIds).toContain("remoteAccess");
    expect(pageIds).toContain("featureFlags");
  });

  test("hides remote access when the feature is disabled", () => {
    const pageIds = getSettingsGroups(false).flatMap((group) => group.pages.map((page) => page.id));
    expect(pageIds).not.toContain("remoteAccess");
    expect(pageIds).toContain("featureFlags");
  });

  test("keeps the drag zone out of normal layout flow", () => {
    const markup = renderToStaticMarkup(createElement(SettingsShell));
    expect(markup).toContain("settings-shell__drag-zone absolute inset-x-0 top-0");
  });

  test("keeps settings navigation copy on readable foreground-derived colors", () => {
    const markup = renderToStaticMarkup(createElement(SettingsShell));
    expect(markup).toContain("text-foreground/72");
    expect(markup).toContain("font-normal text-foreground/78 hover:bg-foreground/[0.05] hover:text-foreground");
  });
});
