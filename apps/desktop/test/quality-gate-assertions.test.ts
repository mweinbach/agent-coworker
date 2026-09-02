import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { assertNoViewportClipping, isKnownColorContrastTarget } from "../quality-gates/assertions";
import { type JsdomHarness, setupJsdom } from "./jsdomHarness";

const page = {
  evaluate: async (callback: (input: unknown) => unknown, input: unknown) => callback(input),
} as unknown as Page;

function setBounds(element: HTMLElement, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
    scrollWidth: { configurable: true, value: width },
    scrollHeight: { configurable: true, value: height },
  });
}

describe("quality-gate assertions", () => {
  let harness: JsdomHarness;

  beforeEach(() => {
    harness = setupJsdom();
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_240 },
      innerHeight: { configurable: true, value: 820 },
    });
    setBounds(document.documentElement, 0, 0, 1_240, 820);
    setBounds(document.body, 0, 0, 1_240, 820);
  });

  afterEach(() => harness.restore());

  test("rejects an ordinary action completely outside the viewport", async () => {
    const button = document.createElement("button");
    button.textContent = "Unreachable action";
    setBounds(button, -200, 20, 120, 32);
    document.body.append(button);

    await expect(assertNoViewportClipping(page)).rejects.toThrow("Unreachable action");
  });

  test("does not treat negative overflow as reachable by scrolling", async () => {
    const scroller = document.createElement("div");
    scroller.style.overflowX = "auto";
    setBounds(scroller, 20, 20, 180, 80);
    Object.defineProperty(scroller, "scrollWidth", { value: 500 });
    const button = document.createElement("button");
    button.textContent = "Before scroll origin";
    setBounds(button, -160, 30, 120, 32);
    scroller.append(button);
    document.body.append(scroller);

    await expect(assertNoViewportClipping(page)).rejects.toThrow("Before scroll origin");
  });

  test("allows an offscreen list action that scrolling can reveal", async () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    setBounds(scroller, 20, 20, 180, 80);
    Object.defineProperty(scroller, "scrollHeight", { value: 1_000 });
    const button = document.createElement("button");
    button.textContent = "Reachable list action";
    setBounds(button, 30, 920, 120, 32);
    scroller.append(button);
    document.body.append(scroller);

    await assertNoViewportClipping(page);
  });

  test("does not let an offscreen scroll container make its contents reachable", async () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    setBounds(scroller, 20, 900, 180, 80);
    Object.defineProperty(scroller, "scrollHeight", { value: 1_000 });
    const button = document.createElement("button");
    button.textContent = "Offscreen container action";
    setBounds(button, 30, 1_020, 120, 32);
    scroller.append(button);
    document.body.append(scroller);

    await expect(assertNoViewportClipping(page)).rejects.toThrow("Offscreen container action");
  });

  test.each(["tracking-wide", "text-foreground/78", "hover:bg-primary/90"])(
    "does not waive a new contrast violation merely for using %s",
    async (className) => {
      const label = document.createElement("span");
      label.id = "new-contrast-regression";
      label.className = className;
      label.textContent = "New low contrast text";
      document.body.append(label);

      expect(await isKnownColorContrastTarget(page, ["#new-contrast-regression"])).toBe(false);
    },
  );
});
