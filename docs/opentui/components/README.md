# Components Reference

OpenTUI provides a rich set of built-in components (renderables) for building terminal UIs. All components extend from `Renderable` (or `BaseRenderable`) and integrate with the Yoga flexbox layout engine.

## Component Index

### Layout & Containers

| Component | Class | Description |
|-----------|-------|-------------|
| [Box](./box.md) | `BoxRenderable` | Container with flexbox layout, borders, background fill, and title |
| [ScrollBox](./scrollbox.md) | `ScrollBoxRenderable` | Scrollable container with automatic scrollbars, sticky scroll, and viewport culling |

### Text Display

| Component | Class | Description |
|-----------|-------|-------------|
| [Text](./text.md) | `TextRenderable` / `TextNodeRenderable` | Styled text display with hierarchical formatting via TextNode tree |
| [ASCIIFont](./ascii-font.md) | `ASCIIFontRenderable` | Large ASCII art text using built-in bitmap fonts |

### Text Input

| Component | Class | Description |
|-----------|-------|-------------|
| [Input](./input.md) | `InputRenderable` | Single-line text input with placeholder, maxLength, and Enter submission |
| [Textarea](./textarea.md) | `TextareaRenderable` | Multi-line text editor with cursor, selection, undo/redo, and key bindings |

### Selection

| Component | Class | Description |
|-----------|-------|-------------|
| [Select](./select.md) | `SelectRenderable` | Vertical list selection with descriptions and keyboard navigation |
| [TabSelect](./select.md#tabselect) | `TabSelectRenderable` | Horizontal tab-style selection with underline indicator |

### Code & Content

| Component | Class | Description |
|-----------|-------|-------------|
| [Code](./code.md) | `CodeRenderable` | Syntax-highlighted code display via Tree-sitter |
| [Diff](./diff.md) | `DiffRenderable` | Git-style unified/split diff viewer with syntax highlighting |
| [Markdown](./markdown.md) | `MarkdownRenderable` | Full markdown renderer with code block highlighting and streaming |

### Primitives & Low-Level

| Component | Class | Description |
|-----------|-------|-------------|
| [Slider](./slider.md) | `SliderRenderable` | Horizontal/vertical slider with thumb and track |
| [ScrollBar](./scrollbox.md#scrollbar) | `ScrollBarRenderable` | Scrollbar with arrows, track, and slider thumb |
| [FrameBuffer](./frame-buffer.md) | `FrameBufferRenderable` | Raw pixel/cell buffer for custom rendering |
| [TextBuffer](./text-buffer.md) | `TextBufferRenderable` / `EditBufferRenderable` | Low-level text display and editing buffer primitives |
| [LineNumbers](./line-numbers.md) | `LineNumberRenderable` | Line number gutter with signs and per-line coloring |

### Composition

| Component | Description |
|-----------|-------------|
| [Composition System](../advanced/composition-system.md) | VNode, `h()`, constructs, vstyles, delegate pattern |

## Inheritance Hierarchy

```
EventEmitter
  BaseRenderable
    TextNodeRenderable
      RootTextNodeRenderable
    Renderable
      BoxRenderable
        ScrollBoxRenderable
      TextBufferRenderable (abstract)
        TextRenderable
        CodeRenderable
      EditBufferRenderable (abstract)
        TextareaRenderable
          InputRenderable
      FrameBufferRenderable
        ASCIIFontRenderable
      SelectRenderable
      TabSelectRenderable
      SliderRenderable
      DiffRenderable
      MarkdownRenderable
      LineNumberRenderable
      ScrollBarRenderable
        ArrowRenderable
      VRenderable
      RootRenderable
```

## Common Props

All components that extend `Renderable` share these base properties from `RenderableOptions`:

### Layout Props (Yoga Flexbox)

```typescript
// Sizing
width?: number | "auto" | `${number}%`
height?: number | "auto" | `${number}%`
minWidth?: number | "auto" | `${number}%`
minHeight?: number | "auto" | `${number}%`
maxWidth?: number | "auto" | `${number}%`
maxHeight?: number | "auto" | `${number}%`

// Flex properties
flexGrow?: number
flexShrink?: number
flexDirection?: "row" | "row-reverse" | "column" | "column-reverse"
flexWrap?: "no-wrap" | "wrap" | "wrap-reverse"
flexBasis?: number | "auto"

// Alignment
justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly"
alignItems?: "auto" | "flex-start" | "center" | "flex-end" | "stretch" | "baseline"
alignSelf?: AlignString

// Positioning
position?: "static" | "relative" | "absolute"
top?: number | "auto" | `${number}%`
right?: number | "auto" | `${number}%`
bottom?: number | "auto" | `${number}%`
left?: number | "auto" | `${number}%`
overflow?: "visible" | "hidden" | "scroll"

// Spacing
margin?: number | "auto" | `${number}%`
marginX?: number | "auto" | `${number}%`
marginY?: number | "auto" | `${number}%`
marginTop?: number | "auto" | `${number}%`
marginRight?: number | "auto" | `${number}%`
marginBottom?: number | "auto" | `${number}%`
marginLeft?: number | "auto" | `${number}%`
padding?: number | `${number}%`
paddingX?: number | `${number}%`
paddingY?: number | `${number}%`
paddingTop?: number | `${number}%`
paddingRight?: number | `${number}%`
paddingBottom?: number | `${number}%`
paddingLeft?: number | `${number}%`
```

### Display & Rendering Props

```typescript
id?: string                  // Unique identifier
visible?: boolean            // Show/hide (default true)
zIndex?: number              // Stack order
opacity?: number             // 0.0 to 1.0
buffered?: boolean           // Use frame buffer for rendering
live?: boolean               // Enable live (animated) rendering
enableLayout?: boolean       // Participate in Yoga layout

// Custom render hooks
renderBefore?: (buffer: OptimizedBuffer, deltaTime: number) => void
renderAfter?: (buffer: OptimizedBuffer, deltaTime: number) => void
```

### Event Props

```typescript
// Mouse events
onMouse?: (event: MouseEvent) => void
onMouseDown?: (event: MouseEvent) => void
onMouseUp?: (event: MouseEvent) => void
onMouseMove?: (event: MouseEvent) => void
onMouseDrag?: (event: MouseEvent) => void
onMouseDragEnd?: (event: MouseEvent) => void
onMouseDrop?: (event: MouseEvent) => void
onMouseOver?: (event: MouseEvent) => void
onMouseOut?: (event: MouseEvent) => void
onMouseScroll?: (event: MouseEvent) => void

// Keyboard & input
onKeyDown?: (key: KeyEvent) => void
onPaste?: (event: PasteEvent) => void

// Lifecycle
onSizeChange?: () => void
```

### Common Renderable Methods

```typescript
// Tree operations
add(obj: Renderable | VNode, index?: number): number
insertBefore(obj: Renderable | VNode, anchor?: Renderable): number
remove(id: string): void
getChildren(): Renderable[]
getChildrenCount(): number
getRenderable(id: string): Renderable | undefined
findDescendantById(id: string): Renderable | undefined

// Focus
focus(): void
blur(): void
get focused(): boolean
get focusable(): boolean
set focusable(value: boolean)

// Selection
hasSelection(): boolean
getSelectedText(): string
onSelectionChanged(selection: Selection | null): boolean

// Rendering
requestRender(): void

// Destruction
destroy(): void
destroyRecursively(): void
```

## Using Components

### Imperative (Core API)

```typescript
import { BoxRenderable, TextRenderable } from "@opentui/core"

const box = new BoxRenderable(ctx, {
  backgroundColor: "#1e1e2e",
  border: true,
  padding: 1,
})

const text = new TextRenderable(ctx, {
  content: "Hello",
  fg: "#cdd6f4",
})

box.add(text)
renderer.root.add(box)
```

### JSX (Solid.js)

```tsx
<box backgroundColor="#1e1e2e" border padding={1}>
  <text fg="#cdd6f4">Hello</text>
</box>
```

### JSX (React)

```tsx
<box backgroundColor="#1e1e2e" border padding={1}>
  <text fg="#cdd6f4">Hello</text>
</box>
```

## Component Lifecycle

```typescript
// 1. Creation
const component = new ComponentRenderable(ctx, options)

// 2. Add to render tree
parent.add(component)

// 3. Update properties reactively
component.someProperty = newValue  // auto-triggers re-render

// 4. Manual re-render request
component.requestRender()

// 5. Remove from tree
parent.remove(component.id)

// 6. Destroy (release resources)
component.destroy()              // This component only
component.destroyRecursively()   // This + all descendants
```

## Layout Events

```typescript
enum LayoutEvents {
  LAYOUT_CHANGED = "layout-changed",
  ADDED = "added",
  REMOVED = "removed",
  RESIZED = "resized",
}

enum RenderableEvents {
  FOCUSED = "focused",
  BLURRED = "blurred",
}
```
