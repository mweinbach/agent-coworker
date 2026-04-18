import { describe, expect, test, mock } from "bun:test";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { A2uiRenderer, type A2uiActionDispatcher, type A2uiRenderableComponent } from "../src/ui/chat/a2ui/A2uiRenderer";
import { setupJsdom } from "./jsdomHarness";

const BUTTON_TREE: A2uiRenderableComponent = {
  id: "root",
  type: "Column",
  children: [
    { id: "buy", type: "Button", props: { text: "Buy" } },
    { id: "qty", type: "TextField", props: { label: "Quantity" } },
    { id: "agree", type: "Checkbox", props: { label: "Agree" } },
  ],
};

describe("A2uiRenderer Phase 2 interactions", () => {
  test("button click fires onAction with event type 'click'", async () => {
    const harness = setupJsdom();
    const dispatcher: A2uiActionDispatcher = mock(async () => {});
    const root = createRoot(harness.dom.window.document.getElementById("root")!);
    try {
      await act(async () => {
        root.render(createElement(A2uiRenderer, { root: BUTTON_TREE, dataModel: {}, onAction: dispatcher }));
      });

      const button = harness.dom.window.document.querySelector("button");
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(false);

      await act(async () => {
        button!.click();
      });
      expect(dispatcher).toHaveBeenCalledTimes(1);
      const call = (dispatcher as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
        componentId: string;
        eventType: string;
      };
      expect(call.componentId).toBe("buy");
      expect(call.eventType).toBe("click");
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("button stays disabled when onAction is omitted", async () => {
    const harness = setupJsdom();
    const root = createRoot(harness.dom.window.document.getElementById("root")!);
    try {
      await act(async () => {
        root.render(createElement(A2uiRenderer, { root: BUTTON_TREE, dataModel: {} }));
      });
      const button = harness.dom.window.document.querySelector("button");
      expect(button!.disabled).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });

  test("checkbox change dispatches event type 'change' with payload { value }", async () => {
    const harness = setupJsdom();
    const dispatcher = mock(async () => {});
    const root = createRoot(harness.dom.window.document.getElementById("root")!);
    try {
      await act(async () => {
        root.render(createElement(A2uiRenderer, { root: BUTTON_TREE, dataModel: {}, onAction: dispatcher }));
      });
      const checkbox = harness.dom.window.document.querySelector<HTMLInputElement>("input[type=\"checkbox\"]");
      expect(checkbox).not.toBeNull();
      await act(async () => {
        checkbox!.click();
      });
      const calls = (dispatcher as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.length).toBe(1);
      const arg = calls[0]![0] as { componentId: string; eventType: string; payload?: Record<string, unknown> };
      expect(arg.componentId).toBe("agree");
      expect(arg.eventType).toBe("change");
      expect(arg.payload).toEqual({ value: true });
    } finally {
      await act(async () => {
        root.unmount();
      });
      harness.restore();
    }
  });
});
