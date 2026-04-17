---
name: "a2ui"
description: "Use when you need to render generative UI surfaces — forms, cards, layouts, richer controls — back to the user inside the chat. Available only when the harness enables A2UI (config `enableA2ui: true`). Emit A2UI v0.9 envelopes through the `a2ui` tool."
---

# A2UI Generative UI Skill

Render agent-authored UI surfaces inside the chat using the
[A2UI v0.9 streaming protocol](https://a2ui.org/specification/v0.9-a2ui/).

## When to use

- The user asks for a richer response than plain text (a form, a card, a list
  of options, a layout with headings).
- You want to summarize structured data (tables, KPIs) in a way that scans
  better than markdown.
- The requested information is inherently visual (cards with images, etc.).

Avoid A2UI for pure prose answers. Use it when the shape of the output
warrants a dedicated UI.

## Protocol cheat sheet

Every envelope MUST carry `"version": "v0.9"` and exactly **one** of:

- `createSurface` — create a named surface with a component tree + data model.
- `updateComponents` — upsert components (by id), replace a subtree, or delete components.
- `updateDataModel` — patch the surface's JSON data model at a JSON-pointer path.
- `deleteSurface` — remove a surface.

Send envelopes via the `a2ui` tool:

```json
{
  "envelopes": [
    {
      "version": "v0.9",
      "createSurface": {
        "surfaceId": "order-confirmation",
        "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json",
        "theme": { "primaryColor": "#0f766e" },
        "root": {
          "id": "root",
          "type": "Column",
          "children": [
            { "id": "title",  "type": "Heading", "props": { "text": "Order placed", "level": 2 } },
            { "id": "total",  "type": "Text",    "props": { "text": { "formatString": "Total: $${/amountUsd}" } } },
            { "id": "thanks", "type": "Paragraph", "props": { "text": "We'll email a receipt shortly." } }
          ]
        },
        "dataModel": { "amountUsd": 42.37 }
      }
    }
  ]
}
```

## Supported components (basic catalog v0.9)

The desktop renderer supports these component types out of the box:

| Type | Props we read |
|---|---|
| `Text` / `Paragraph` | `text` (or `value`) |
| `Heading` | `text`, `level` (1–6) |
| `Column` / `Row` / `Stack` | `justify`, `align`, nested `children` |
| `Divider` / `Spacer` | — |
| `Card` | nested `children` |
| `List` | `ordered: boolean`, nested `children` |
| `Button` | `text` / `label` (phase 1: displayed but not interactive) |
| `TextField` | `label`, `placeholder`, `value` (phase 1: read-only for the agent) |
| `Checkbox` | `label`, `value` (phase 1: read-only for the agent) |
| `Image` | `src` (must be http, https, or data URL), `alt` |

Unknown component types are shown as a diagnostic fallback. If you're
streaming updates for a new component type, include a short `Paragraph`
fallback nearby so the user still sees meaningful content.

## Dynamic bindings

Props may reference the data model:

- `{ "path": "/user/name" }` — read a value by JSON-pointer.
- `{ "$ref": "/items/0/title" }` — alias for `path`.
- `{ "literal": 42 }` — force the value through literally.
- `{ "formatString": "Hi ${/name}, you have ${/count} items." }` — interpolate
  pointer expressions. Unknown tokens render as empty string.

The renderer does **not** evaluate arbitrary expressions. Stick to plain
JSON-pointer paths inside `${...}`.

## Security rules

- All text renders as plain text — HTML tags are NOT parsed. Don't try to
  inject `<script>` or `<img onerror=...>`; they render as literal strings.
- `Image` URLs are restricted to `http:`, `https:`, and `data:` schemes.
- The desktop renderer caps component depth and string length to avoid
  runaway surfaces.

## Interaction model (phase 1)

Interactive controls (`Button`, `TextField`, `Checkbox`) are shown but their
events are **not yet delivered back to you**. If you need user input in this
release, continue to use the `ask` tool.

## Typical workflow

1. Emit a single `createSurface` envelope with the full tree.
2. When data changes, emit `updateDataModel` to patch a specific path.
3. When structure changes, emit `updateComponents` with the affected
   components (keyed by id).
4. When the surface is no longer needed, emit `deleteSurface`.

Always reuse a stable `surfaceId` across updates so the client replaces the
surface in place rather than creating duplicates.

## Failure handling

The `a2ui` tool returns `{ applied, failed, results: [...] }`. On `failed`
entries, the `error` field explains what was rejected (version mismatch,
unknown surface, resolved-state too large, etc). Read the error and send a
corrective envelope.

## Example: incremental update

```json
// 1) Initial surface
{ "version": "v0.9", "createSurface": { "surfaceId": "counter", "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json",
  "root": { "id": "root", "type": "Column", "children": [
    { "id": "label", "type": "Heading", "props": { "text": { "formatString": "Count: ${/count}" }, "level": 2 } }
  ]},
  "dataModel": { "count": 0 }
}}

// 2) After doing some work, bump the counter
{ "version": "v0.9", "updateDataModel": { "surfaceId": "counter", "path": "/count", "value": 3 } }

// 3) Done — tear down.
{ "version": "v0.9", "deleteSurface": { "surfaceId": "counter" } }
```
