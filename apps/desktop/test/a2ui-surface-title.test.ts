import { describe, expect, test } from "bun:test";

import { extractSurfaceTitle } from "../src/ui/chat/a2ui/surfaceTitle";

describe("extractSurfaceTitle", () => {
  test("returns null when root is missing", () => {
    expect(extractSurfaceTitle(null, {})).toBeNull();
  });

  test("prefers the highest-level heading over later nested ones", () => {
    const title = extractSurfaceTitle(
      {
        id: "root",
        type: "Column",
        children: [
          {
            id: "hero",
            type: "Card",
            children: [{ id: "hero-title", type: "Heading", props: { text: "A2UI Demo Lab", level: 1 } }],
          },
          { id: "sub", type: "Heading", props: { text: "System Pulse", level: 2 } },
        ],
      },
      {},
    );
    expect(title).toBe("A2UI Demo Lab");
  });

  test("falls back to first text/paragraph when no headings exist", () => {
    const title = extractSurfaceTitle(
      {
        id: "root",
        type: "Column",
        children: [
          { id: "body", type: "Text", props: { text: "hello there" } },
        ],
      },
      {},
    );
    expect(title).toBe("hello there");
  });

  test("resolves dynamic bindings via the data model", () => {
    const title = extractSurfaceTitle(
      {
        id: "root",
        type: "Heading",
        props: { text: { path: "/title" }, level: 1 },
      },
      { title: "Bound Title" },
    );
    expect(title).toBe("Bound Title");
  });

  test("skips empty heading text and prefers the next heading it finds", () => {
    const title = extractSurfaceTitle(
      {
        id: "root",
        type: "Column",
        children: [
          { id: "blank", type: "Heading", props: { text: "", level: 1 } },
          { id: "real", type: "Heading", props: { text: "Real Title", level: 2 } },
        ],
      },
      {},
    );
    expect(title).toBe("Real Title");
  });
});
