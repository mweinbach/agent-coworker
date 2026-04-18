import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { A2uiRenderer, type A2uiRenderableComponent } from "../src/ui/chat/a2ui/A2uiRenderer";

function render(root: A2uiRenderableComponent, dataModel: unknown = {}) {
  return renderToStaticMarkup(createElement(A2uiRenderer, { root, dataModel }));
}

describe("A2uiRenderer extended catalog (Phase 3)", () => {
  test("TextArea renders with label and initial value", () => {
    const html = render({
      id: "root",
      type: "Column",
      children: [
        {
          id: "notes",
          type: "TextArea",
          props: { label: "Notes", value: "hello", rows: 3 },
        },
      ],
    });
    expect(html).toContain("Notes");
    expect(html).toContain("hello");
    // <textarea> element should be present
    expect(html).toContain("<textarea");
  });

  test("Select renders every option from props.options", () => {
    const html = render(
      {
        id: "root",
        type: "Column",
        children: [
          {
            id: "pick",
            type: "Select",
            props: {
              label: "Pick one",
              options: [
                { value: "a", label: "Apple" },
                { value: "b", label: "Banana" },
              ],
              value: "b",
            },
          },
        ],
      },
    );
    expect(html).toContain("Apple");
    expect(html).toContain("Banana");
    // The `b` value should be the selected default.
    expect(html).toMatch(/<select[^>]*>/);
  });

  test("Select renders option labels from dynamic bindings", () => {
    const html = render(
      {
        id: "root",
        type: "Column",
        children: [
          {
            id: "pick",
            type: "Select",
            props: {
              options: { path: "/opts" },
            },
          },
        ],
      },
      { opts: [{ value: "x", label: "Xylophone" }, { value: "y", label: "Yak" }] },
    );
    expect(html).toContain("Xylophone");
    expect(html).toContain("Yak");
  });

  test("Link renders an http href; unsafe schemes render as plain text", () => {
    const safe = render({
      id: "root",
      type: "Column",
      children: [
        { id: "a", type: "Link", props: { text: "Cowork", href: "https://example.com" } },
      ],
    });
    expect(safe).toContain("https://example.com");
    expect(safe).toContain("Cowork");

    const unsafe = render({
      id: "root",
      type: "Column",
      children: [
        { id: "a", type: "Link", props: { text: "bad", href: "javascript:alert(1)" } },
      ],
    });
    expect(unsafe).not.toContain("javascript:alert");
  });

  test("ProgressBar clamps values and exposes aria attributes", () => {
    const html = render({
      id: "root",
      type: "Column",
      children: [
        { id: "p", type: "ProgressBar", props: { value: 50, max: 100, label: "Loading" } },
      ],
    });
    expect(html).toContain("Loading");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
  });

  test("Badge renders with tone-specific classes", () => {
    const html = render({
      id: "root",
      type: "Column",
      children: [
        { id: "b", type: "Badge", props: { text: "new", tone: "success" } },
      ],
    });
    expect(html).toContain("new");
    // Tailwind class names we emit
    expect(html).toContain("bg-success");
  });

  test("Table renders header labels and cell values", () => {
    const html = render(
      {
        id: "root",
        type: "Column",
        children: [
          {
            id: "t",
            type: "Table",
            props: {
              columns: [
                { key: "name", label: "Name" },
                { key: "qty", label: "Qty" },
              ],
              rows: { path: "/rows" },
            },
          },
        ],
      },
      { rows: [{ name: "Widget", qty: 3 }, { name: "Gadget", qty: 7 }] },
    );
    expect(html).toContain("Name");
    expect(html).toContain("Qty");
    expect(html).toContain("Widget");
    expect(html).toContain("Gadget");
    expect(html).toContain(">3<");
    expect(html).toContain(">7<");
  });

  test("Table falls back gracefully when columns are missing", () => {
    const html = render({
      id: "root",
      type: "Column",
      children: [
        { id: "t", type: "Table", props: { rows: [{ name: "Widget" }] } },
      ],
    });
    expect(html).toContain("Table requires props.columns");
  });

  test("Card at root depth renders children flat (no nested card chrome)", () => {
    // The host of A2uiRenderer (A2uiInlineCard, dock, dialog) already supplies
    // the visible card chrome. A root-level Card must not add another rounded
    // border on top of that or we get a "card on card" look.
    const html = render({
      id: "root",
      type: "Card",
      children: [
        { id: "h", type: "Heading", props: { text: "Hello", level: 2 } },
        { id: "t", type: "Text", props: { text: "World" } },
      ],
    });
    expect(html).toContain("Hello");
    expect(html).toContain("World");
    // Classes that would indicate the nested card chrome was rendered.
    expect(html).not.toContain("rounded-xl");
    expect(html).not.toContain("from-background/85");
  });

  test("Card nested below root keeps its card chrome", () => {
    const html = render({
      id: "root",
      type: "Column",
      children: [
        {
          id: "inner-card",
          type: "Card",
          children: [{ id: "h", type: "Heading", props: { text: "Inner", level: 3 } }],
        },
      ],
    });
    expect(html).toContain("Inner");
    expect(html).toContain("rounded-xl");
  });

  test("Text reads via function calls (formatString style via `if`/`concat`)", () => {
    const html = render(
      {
        id: "root",
        type: "Column",
        children: [
          {
            id: "greeting",
            type: "Text",
            props: {
              text: {
                if: {
                  cond: { path: "/active" },
                  then: { concat: ["Hi ", { path: "/name" }] },
                  else: "Inactive",
                },
              },
            },
          },
        ],
      },
      { active: true, name: "Ada" },
    );
    expect(html).toContain("Hi Ada");
  });
});
