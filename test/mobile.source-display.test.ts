import { describe, expect, test } from "bun:test";

import {
  displayDomain,
  displaySourceSubtitle,
  displaySourceTitle,
  faviconUrl,
} from "../apps/mobile/src/features/cowork/sourceDisplay";

describe("mobile source display", () => {
  test("derives domain labels from urls", () => {
    expect(displayDomain("https://www.apple.com/apple-intelligence/")).toBe("apple.com");
    expect(
      displaySourceSubtitle({ label: "", href: "https://support.apple.com/en-us/121115" }),
    ).toBe("support.apple.com");
  });

  test("uses custom labels when provided", () => {
    expect(
      displaySourceTitle({
        label: "Apple Intelligence",
        href: "https://www.apple.com/apple-intelligence/",
      }),
    ).toBe("Apple Intelligence");
  });

  test("derives title slugs from long url paths", () => {
    expect(
      displaySourceTitle({
        label: "https://www.apple.com/newsroom/2025/06/apple-intelligence-gets-even-more-powerful",
        href: "https://www.apple.com/newsroom/2025/06/apple-intelligence-gets-even-more-powerful",
      }),
    ).toBe("Apple Intelligence Gets Even More Powerful");
  });

  test("builds favicon urls from domains", () => {
    expect(faviconUrl("https://support.apple.com/en-us/121115")).toBe(
      "https://www.google.com/s2/favicons?domain=support.apple.com&sz=32",
    );
  });
});
