import { describe, expect, test } from "bun:test";

import { compactDisplayPath } from "../src/ui/sidebar/SidebarSearchOverlay";

describe("compactDisplayPath", () => {
  test("keeps short paths as they are", () => {
    expect(compactDisplayPath("/Users/max/code/app")).toBe("~/code/app");
  });

  test("elides the middle of long home paths once", () => {
    expect(
      compactDisplayPath("/Users/max/Developer/clients/acme/platform/services/billing-api"),
    ).toBe("~/…/services/billing-api");
  });

  test("elides the middle of long non-home paths once", () => {
    expect(compactDisplayPath("/srv/builds/workspaces/acme-platform/services/billing-api")).toBe(
      "…/services/billing-api",
    );
  });

  test("normalizes Windows separators before compacting", () => {
    expect(
      compactDisplayPath("D:\\Projects\\clients\\acme\\platform\\services\\billing-api-gateway"),
    ).toBe("…/services/billing-api-gateway");
  });
});
