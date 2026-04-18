import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { A2uiInlineCard } from "../src/ui/chat/a2ui/A2uiInlineCard";
import type { FeedItem } from "../src/app/types";

type UiSurfaceItem = Extract<FeedItem, { kind: "ui_surface" }>;

function createItem(partial: Partial<UiSurfaceItem> = {}): UiSurfaceItem {
  return {
    id: "ui:s1@1",
    kind: "ui_surface",
    ts: "2026-04-17T00:00:00.000Z",
    surfaceId: "s1",
    catalogId: "https://a2ui.org/specification/v0_9/basic_catalog.json",
    version: "v0.9",
    revision: 3,
    deleted: false,
    root: {
      id: "root",
      type: "Column",
      children: [
        { id: "title", type: "Heading", props: { text: "Live Surface", level: 1 } },
        { id: "body", type: "Text", props: { text: "inline content" } },
      ],
    },
    dataModel: {},
    ...partial,
  };
}

describe("A2uiInlineCard", () => {
  test("renders the surface content inline with title + kind chip", () => {
    const html = renderToStaticMarkup(
      createElement(A2uiInlineCard, {
        item: createItem({ changeKind: "createSurface", reason: "initial render" }),
      }),
    );
    expect(html).toContain("Live Surface");
    expect(html).toContain("Created");
    expect(html).toContain("inline content");
    expect(html).toContain(">s1<");
  });

  test("shows an 'Updated' label when changeKind is missing (legacy items)", () => {
    const html = renderToStaticMarkup(
      createElement(A2uiInlineCard, { item: createItem() }),
    );
    expect(html).toContain("Updated");
  });

  test("falls back to a tombstone when the surface is deleted", () => {
    const html = renderToStaticMarkup(
      createElement(A2uiInlineCard, { item: createItem({ deleted: true }) }),
    );
    expect(html).toContain("was deleted at revision 3");
    expect(html).not.toContain("inline content");
  });

  test("renders the kind label next to the title", () => {
    const html = renderToStaticMarkup(
      createElement(A2uiInlineCard, {
        item: createItem({ changeKind: "updateDataModel", reason: "boosted energy" }),
      }),
    );
    expect(html).toContain("Data update");
    expect(html).toContain("boosted energy");
  });

  test("a root-level Card in the surface does not add a second card chrome", () => {
    // Regression: a surface whose root component is `Card` used to render
    // with a full rounded-xl inner card inside the A2uiInlineCard chrome,
    // producing a visible "card on card" look. Root Cards should render as
    // a plain column inside the inline card.
    const html = renderToStaticMarkup(
      createElement(A2uiInlineCard, {
        item: createItem({
          root: {
            id: "root",
            type: "Card",
            children: [
              { id: "heading", type: "Heading", props: { text: "Nested", level: 2 } },
              { id: "body", type: "Text", props: { text: "flat content" } },
            ],
          },
        }),
      }),
    );
    expect(html).toContain("Nested");
    expect(html).toContain("flat content");
    expect(html).not.toContain("rounded-xl");
    expect(html).not.toContain("from-background/85");
  });
});
