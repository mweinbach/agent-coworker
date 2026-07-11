import { describe, expect, test } from "bun:test";
import { resolveChatBottomOffset } from "../src/ui/chat/chatBottomOffset";

describe("chat bottom offset ownership", () => {
  test("reserves exactly the measured absolute overlay once", () => {
    expect(
      resolveChatBottomOffset({
        chrome: "overlay",
        measuredOverlayHeight: 219.2,
        minimumOverlayHeight: 140,
      }),
    ).toBe(220);
  });

  test("uses the compact floor before the overlay is measured", () => {
    expect(
      resolveChatBottomOffset({
        chrome: "overlay",
        minimumOverlayHeight: 140,
      }),
    ).toBe(140);
  });

  test("does not reserve an in-flow source-task lock a second time", () => {
    expect(
      resolveChatBottomOffset({
        chrome: "in-flow",
        measuredOverlayHeight: 240,
        minimumOverlayHeight: 140,
      }),
    ).toBe(0);
  });
});
