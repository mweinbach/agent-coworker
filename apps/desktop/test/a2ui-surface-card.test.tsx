import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { A2uiSurfaceCard } from "../src/ui/chat/a2ui/A2uiSurfaceCard";
import type { FeedItem } from "../src/app/types";

type UiSurfaceItem = Extract<FeedItem, { kind: "ui_surface" }>;

function createItem(partial: Partial<UiSurfaceItem> = {}): UiSurfaceItem {
  return {
    id: "ui:s1",
    kind: "ui_surface",
    ts: "2026-01-01T00:00:00.000Z",
    surfaceId: "s1",
    catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
    version: "v0.9",
    revision: 1,
    deleted: false,
    root: {
      id: "root",
      type: "Column",
      children: [
        { id: "title", type: "Heading", props: { text: "Hello, world" } },
        { id: "body", type: "Text", props: { text: { path: "/message" } } },
        { id: "unsafe", type: "Text", props: { text: "<script>alert(1)</script>" } },
      ],
    },
    dataModel: { message: "bound value" },
    ...partial,
  };
}

describe("A2uiSurfaceCard", () => {
  test("renders basic catalog components with dynamic bindings", () => {
    const html = renderToStaticMarkup(createElement(A2uiSurfaceCard, { item: createItem() }));
    expect(html).toContain("Generative UI");
    expect(html).toContain("Hello, world");
    expect(html).toContain("bound value");
  });

  test("escapes HTML-ish strings so script tags render as text", () => {
    const html = renderToStaticMarkup(createElement(A2uiSurfaceCard, { item: createItem() }));
    // Unsafe text must be escaped.
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders a tombstone card when the surface is deleted", () => {
    const html = renderToStaticMarkup(
      createElement(A2uiSurfaceCard, { item: createItem({ deleted: true }) }),
    );
    expect(html).toContain("was deleted");
    // No Column/Heading should render for deleted surfaces.
    expect(html).not.toContain("Hello, world");
  });

  test("shows an unsupported-catalog banner when catalog id doesn't match basic catalog", () => {
    const html = renderToStaticMarkup(
      createElement(A2uiSurfaceCard, {
        item: createItem({ catalogId: "https://example.com/custom-catalog.json" }),
      }),
    );
    expect(html).toContain("unknown catalog");
    expect(html).toContain("unsupported catalog");
  });

  test("drops unknown component types with a diagnostic fallback", () => {
    const html = renderToStaticMarkup(
      createElement(A2uiSurfaceCard, {
        item: createItem({
          root: {
            id: "root",
            type: "Column",
            children: [
              { id: "x", type: "FancyGizmo", props: { foo: "bar" } },
            ],
          },
        }),
      }),
    );
    expect(html).toContain("Unrendered component");
    expect(html).toContain("FancyGizmo");
  });

  test("ignores non-http image sources", () => {
    const html = renderToStaticMarkup(
      createElement(A2uiSurfaceCard, {
        item: createItem({
          root: {
            id: "root",
            type: "Column",
            children: [
              { id: "img", type: "Image", props: { src: "javascript:alert(1)" } },
            ],
          },
        }),
      }),
    );
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("image source unavailable");
  });
});
