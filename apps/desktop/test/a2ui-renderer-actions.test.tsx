import { describe, expect, test, mock } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { A2uiRenderer, type A2uiActionDispatcher, type A2uiRenderableComponent } from "../src/ui/chat/a2ui/A2uiRenderer";

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  // @ts-expect-error jsdom -> global
  globalThis.document = dom.window.document;
  // @ts-expect-error jsdom -> global
  globalThis.window = dom.window;
  // @ts-expect-error jsdom -> global
  globalThis.HTMLElement = dom.window.HTMLElement;
  // @ts-expect-error jsdom -> global
  globalThis.Element = dom.window.Element;
  // @ts-expect-error jsdom -> global
  globalThis.navigator = dom.window.navigator;
  // @ts-expect-error - required by React 19
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

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
    const dom = setupDom();
    const dispatcher: A2uiActionDispatcher = mock(async () => {});
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(A2uiRenderer, { root: BUTTON_TREE, dataModel: {}, onAction: dispatcher }));
    });

    const button = dom.window.document.querySelector("button");
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
  });

  test("button stays disabled when onAction is omitted", async () => {
    const dom = setupDom();
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(A2uiRenderer, { root: BUTTON_TREE, dataModel: {} }));
    });
    const button = dom.window.document.querySelector("button");
    expect(button!.disabled).toBe(true);
  });

  test("checkbox change dispatches event type 'change' with payload { value }", async () => {
    const dom = setupDom();
    const dispatcher = mock(async () => {});
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(A2uiRenderer, { root: BUTTON_TREE, dataModel: {}, onAction: dispatcher }));
    });
    const checkbox = dom.window.document.querySelector<HTMLInputElement>("input[type=\"checkbox\"]");
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
  });
});
