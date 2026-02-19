# @opentui/solid -- Solid.js Binding

`@opentui/solid` provides a custom Solid.js renderer that bridges Solid's fine-grained reactivity system to OpenTUI's terminal renderable tree. Instead of rendering to the DOM, Solid components produce `@opentui/core` renderables (`BoxRenderable`, `TextRenderable`, etc.) that are laid out with Yoga and painted to a terminal buffer.

**Version:** 0.1.80
**License:** MIT
**Peer dependency:** `solid-js@1.9.9`

## Table of Contents

- [Installation and Setup](#installation-and-setup)
  - [Install Dependencies](#install-dependencies)
  - [TypeScript Configuration](#typescript-configuration)
  - [Bun Preload Script](#bun-preload-script)
  - [Build Plugin](#build-plugin)
- [Architecture](#architecture)
  - [How the Reconciler Works](#how-the-reconciler-works)
  - [Renderer Creation Pipeline](#renderer-creation-pipeline)
  - [Element Creation and the Component Catalogue](#element-creation-and-the-component-catalogue)
  - [Property Setting and Event Wiring](#property-setting-and-event-wiring)
  - [The Slot System](#the-slot-system)
  - [Text Node Handling](#text-node-handling)
- [Top-Level API](#top-level-api)
  - [render(node, rendererOrConfig?)](#rendernode-rendererorconfig)
  - [testRender(node, options?)](#testrendernode-options)
  - [extend(components)](#extendcomponents)
  - [getComponentCatalogue()](#getcomponentcatalogue)
- [Hooks](#hooks)
  - [useRenderer()](#userenderer)
  - [useTerminalDimensions()](#useterminaldimensions)
  - [onResize(callback)](#onresizecallback)
  - [useKeyboard(callback, options?)](#usekeyboardcallback-options)
  - [usePaste(callback)](#usepastecallback)
  - [useSelectionHandler(callback)](#useselectionhandlercallback)
  - [useTimeline(options?)](#usetimelineoptions)
  - [useKeyHandler (deprecated)](#usekeyhandler-deprecated)
- [JSX Elements Reference](#jsx-elements-reference)
  - [Common Props](#common-props)
  - [Layout and Container Elements](#layout-and-container-elements)
  - [Text Elements](#text-elements)
  - [Input Elements](#input-elements)
  - [Code and Display Elements](#code-and-display-elements)
  - [Text Modifier Elements](#text-modifier-elements)
- [Special Components](#special-components)
  - [Portal](#portal)
  - [Dynamic](#dynamic)
  - [createDynamic (low-level)](#createdynamic-low-level)
- [Component Extension System](#component-extension-system)
- [Reconciler Internals](#reconciler-internals)
  - [Exported Reconciler Primitives](#exported-reconciler-primitives)
- [Utilities](#utilities)
  - [ID Counter](#id-counter)
  - [Debug Logging](#debug-logging)
- [Complete JSX Elements Quick Reference](#complete-jsx-elements-quick-reference)

---

## Installation and Setup

### Install Dependencies

```bash
bun install solid-js @opentui/solid
```

This installs Solid.js as a peer dependency alongside the OpenTUI Solid binding. The `@opentui/core` package is a transitive dependency and is installed automatically.

### TypeScript Configuration

Set the JSX import source so that TypeScript resolves JSX types from the OpenTUI Solid namespace rather than the DOM:

```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid"
  }
}
```

This makes TypeScript use the `@opentui/solid/jsx-runtime` module for JSX type checking, which defines `JSX.IntrinsicElements` with all OpenTUI element types (`box`, `text`, `input`, etc.) instead of HTML elements.

### Bun Preload Script

The preload script registers the Solid transform plugin before any `.tsx`/`.jsx` files are imported. Add it to `bunfig.toml`:

```toml
preload = ["@opentui/solid/preload"]
```

The preload script (`scripts/preload.ts`) simply calls `plugin(solidTransformPlugin)` using Bun's plugin API. The plugin uses Babel with `babel-preset-solid` and `@babel/preset-typescript` to transform JSX into Solid's `createComponent` / `createElement` / `insert` calls at load time.

### Build Plugin

For production builds with `Bun.build`, import and pass the same plugin:

```ts
import solidPlugin from "@opentui/solid/bun-plugin"

await Bun.build({
  entrypoints: ["./index.tsx"],
  target: "bun",
  outdir: "./build",
  plugins: [solidPlugin],
})
```

The plugin can also compile to a standalone binary:

```ts
await Bun.build({
  entrypoints: ["./index.tsx"],
  target: "bun",
  outdir: "./build",
  plugins: [solidPlugin],
  compile: {
    target: "bun-darwin-arm64",
    outfile: "my-app",
  },
})
```

**Plugin type:**

```typescript
import { type BunPlugin } from "bun"
declare const solidTransformPlugin: BunPlugin
export default solidTransformPlugin
```

---

## Architecture

### How the Reconciler Works

The `@opentui/solid` package implements a **custom Solid.js universal renderer**. Solid's rendering model is fundamentally different from React's virtual DOM diffing: Solid compiles JSX into direct, fine-grained reactive subscriptions. The renderer provides the "backend" that tells Solid how to create, insert, remove, and update nodes.

The architecture has three layers:

```
Solid.js Reactivity (signals, effects, memos)
        |
        v
Universal Renderer (src/renderer/universal.js)
  -- createRenderer({ createElement, insertNode, removeNode, ... })
        |
        v
OpenTUI Renderable Tree (BoxRenderable, TextRenderable, etc.)
  -- Yoga layout, ANSI buffer painting, terminal output
```

The universal renderer (`src/renderer/universal.js`) is adapted from Solid's own `solid-js/universal` custom renderer pattern. It provides the core algorithms for:

- **Expression insertion** (`insert`): Handles inserting reactive values (signals, memos, arrays) into the tree, setting up `createRenderEffect` to track changes.
- **Array reconciliation** (`reconcileArrays`): An efficient O(n) algorithm for diffing and patching child arrays, similar to Solid's DOM reconciler but operating on renderables.
- **Spread expressions** (`spread`): Applies a dynamic bag of props to a node, tracking each property reactively.
- **Child cleanup** (`cleanChildren`): Removes old children and optionally inserts a replacement, using slot nodes as markers.

### Renderer Creation Pipeline

The renderer is created in two steps:

1. **`createRenderer(options)`** in `src/renderer/universal.js` -- Takes an options object with 11 callback functions and returns the renderer primitives (`render`, `insert`, `spread`, `createElement`, etc.). This is a generic implementation.

2. **`createRenderer2(options)`** in `src/renderer/index.ts` -- Wraps the above, replacing `mergeProps` with Solid's own `mergeProps` for proper reactive prop merging.

The reconciler (`src/reconciler.ts`) calls `createRenderer2()` with OpenTUI-specific implementations for each callback:

| Callback | What it does |
|---|---|
| `createElement(tagName)` | Looks up `tagName` in the component catalogue, instantiates the corresponding `Renderable` class with an auto-generated ID, using the current `RendererContext` as the render context |
| `createTextNode(value)` | Creates a `TextNode` (extends `TextNodeRenderable`) with the string content |
| `createSlotNode()` | Creates a `SlotRenderable` -- a placeholder/marker node used internally by the reconciler |
| `isTextNode(node)` | Returns `true` if the node is a `TextNode` instance |
| `replaceText(node, value)` | Calls `node.replace(value, 0)` on a `TextNode` to update its content in-place |
| `insertNode(parent, node, anchor?)` | Adds a child renderable to its parent, handling slot resolution, text-node parenting validation, and anchor-based positioning |
| `removeNode(parent, node)` | Removes a child and schedules `destroyRecursively()` on the next tick if the node is orphaned |
| `setProperty(node, name, value, prev)` | The property routing engine (see below) |
| `getParentNode(node)` | Walks up the parent chain, handling `RootTextNodeRenderable` and `ScrollBoxRenderable` wrapping |
| `getFirstChild(node)` | Returns the first child, dispatching to `getTextChildren()` for `TextRenderable` |
| `getNextSibling(node)` | Returns the next sibling in the parent's children array |

### Element Creation and the Component Catalogue

When the reconciler encounters a JSX tag like `<box>`, it calls `createElement("box")`. This function:

1. Generates a unique ID via `getNextId("box")` (e.g., `"box-1"`, `"box-2"`, ...)
2. Reads the current `RendererContext` from Solid's context system to get the `CliRenderer` instance
3. Looks up `"box"` in the component catalogue (a mutable `Record<string, RenderableConstructor>`)
4. Instantiates `new BoxRenderable(renderer, { id })` and returns it

The **base component catalogue** maps tag names to renderable classes:

```typescript
const baseComponents = {
  box:         BoxRenderable,
  text:        TextRenderable,
  input:       InputRenderable,
  select:      SelectRenderable,
  textarea:    TextareaRenderable,
  ascii_font:  ASCIIFontRenderable,
  tab_select:  TabSelectRenderable,
  scrollbox:   ScrollBoxRenderable,
  code:        CodeRenderable,
  diff:        DiffRenderable,
  line_number: LineNumberRenderable,
  markdown:    MarkdownRenderable,
  span:        SpanRenderable,
  strong:      BoldSpanRenderable,
  b:           BoldSpanRenderable,
  em:          ItalicSpanRenderable,
  i:           ItalicSpanRenderable,
  u:           UnderlineSpanRenderable,
  br:          LineBreakRenderable,
  a:           LinkRenderable,
}
```

### Property Setting and Event Wiring

The `setProperty` callback handles all prop updates. It routes based on the property name:

**Event handlers via `on:` prefix:**
```tsx
<box on:customEvent={(data) => handle(data)} />
```
Any prop starting with `on:` is treated as an event name. `node.on(eventName, value)` is called, and the previous handler (if any) is removed with `node.off(eventName, prev)`.

**Built-in event shorthands for interactive elements:**

| Prop | Element(s) | Underlying event |
|---|---|---|
| `onChange` | `select`, `tab_select`, `input` | `SELECTION_CHANGED` / `CHANGE` |
| `onInput` | `input` | `INPUT` |
| `onSubmit` | `input` | `ENTER` |
| `onSelect` | `select`, `tab_select` | `ITEM_SELECTED` |

**The `focused` prop:**
Setting `focused={true}` calls `node.focus()`; setting `focused={false}` calls `node.blur()`.

**The `style` prop:**
Iterates over the style object's keys and assigns each to the node directly (`node[prop] = propVal`), skipping unchanged values.

**Text node properties:**
- `href` on a text node sets `node.link = { url: value }`
- `style` on a text node applies text attributes (bold, italic, etc.) and foreground/background colors

**Content properties:**
`text` and `content` props are stringified before assignment.

**Everything else:** Assigned directly to the node (`node[name] = value`).

### The Slot System

Slots are internal marker nodes used by the reconciler to track positions in the child list during conditional rendering and array reconciliation. They are not user-facing components.

There are three slot types:

- **`SlotRenderable`** -- The primary slot. When inserted into the tree, it delegates to one of two specialized children based on the parent type:
  - **`TextSlotRenderable`** (extends `TextNodeRenderable`) -- Used when the parent is a `TextRenderable` or text node. Invisible (`_visible = false`).
  - **`LayoutSlotRenderable`** (extends `SlotBaseRenderable`) -- Used when the parent is a layout node. Creates a Yoga node with `Display.None` so it occupies no space.

The `getSlotChild(parent)` method on `SlotRenderable` lazily creates the appropriate child type. This dual-mode design lets slots work correctly in both text and layout contexts.

All slot renderables extend `SlotBaseRenderable`, which provides stub implementations for the renderable interface (`add()`, `remove()`, `getChildren()`, etc.) that either throw or return empty values, since slots don't have real children.

### Text Node Handling

String and number values in JSX become `TextNode` instances (a subclass of `TextNodeRenderable`). The reconciler enforces that text nodes can only be parented by `TextRenderable` or other `TextNodeRenderable` instances. Attempting to insert a text node under a `BoxRenderable` (or any non-text parent) throws an orphan text error:

```
Orphan text error: "hello" must have a <text> as a parent
```

This means raw strings must always be wrapped in a `<text>` element (or a text modifier like `<span>`, `<strong>`, etc.).

---

## Top-Level API

### render(node, rendererOrConfig?)

Render a Solid component tree into a terminal. This is the main entry point for OpenTUI Solid applications.

```typescript
declare const render: (
  node: () => JSX.Element,
  rendererOrConfig?: CliRenderer | CliRendererConfig
) => Promise<void>
```

**Parameters:**

- `node` -- A function returning a JSX element. Must be a function (not a raw element) because Solid tracks reactivity at the call boundary.
- `rendererOrConfig` (optional) -- Either:
  - A `CliRenderer` instance (reuse an existing renderer)
  - A `CliRendererConfig` object (options passed to `createCliRenderer()`)
  - Omitted / `{}` (creates a default renderer)

**Behavior:**

1. If `rendererOrConfig` is not a `CliRenderer`, calls `createCliRenderer()` to create one
2. Attaches the renderer to the OpenTUI engine (`engine.attach(renderer)`)
3. Calls the internal `_render()` to mount the Solid tree, wrapping it in a `RendererContext.Provider` so all child components can access the renderer
4. Registers a destroy handler so the Solid reactive root is disposed when the renderer is destroyed

**Examples:**

```tsx
import { render } from "@opentui/solid"

// Default renderer (auto-created)
render(() => <App />)

// With renderer config
render(() => <App />, { backgroundColor: "#1e1e2e" })

// With existing renderer
import { createCliRenderer } from "@opentui/core"
const renderer = await createCliRenderer({ exitOnCtrlC: false })
render(() => <App />, renderer)
```

### testRender(node, options?)

Create a test renderer for snapshot and interaction testing. Returns a test harness object.

```typescript
declare const testRender: (
  node: () => JSX.Element,
  renderConfig?: TestRendererOptions
) => Promise<{
  renderer: TestRenderer
  mockInput: MockInput
  mockMouse: MockMouse
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
  captureSpans: () => CapturedFrame
  resize: (width: number, height: number) => void
}>
```

**Return value:**

| Field | Type | Description |
|---|---|---|
| `renderer` | `TestRenderer` | The test renderer instance |
| `mockInput` | `MockInput` | Simulate keyboard input |
| `mockMouse` | `MockMouse` | Simulate mouse events |
| `renderOnce` | `() => Promise<void>` | Force a single render pass |
| `captureCharFrame` | `() => string` | Capture the current frame as a string of characters |
| `captureSpans` | `() => CapturedFrame` | Capture the current frame as styled spans (preserving color/attribute info) |
| `resize` | `(width, height) => void` | Simulate a terminal resize |

**Example:**

```tsx
import { testRender } from "@opentui/solid"
import { test, expect } from "bun:test"

test("renders a counter", async () => {
  const { captureCharFrame, renderOnce, mockInput } = await testRender(
    () => <text>Hello, World!</text>,
    { width: 40, height: 10 }
  )

  await renderOnce()
  const frame = captureCharFrame()
  expect(frame).toContain("Hello, World!")
})
```

### extend(components)

Register custom renderable classes as JSX intrinsic elements. This mutates the global component catalogue.

```typescript
declare function extend<T extends Record<string, RenderableConstructor>>(objects: T): void
```

See [Component Extension System](#component-extension-system) for full details and TypeScript augmentation.

### getComponentCatalogue()

Returns the current component catalogue object. Useful for introspection or debugging.

```typescript
declare function getComponentCatalogue(): Record<string, RenderableConstructor>
```

---

## Hooks

All hooks must be called within a component that is rendered inside a `render()` or `testRender()` call, because they depend on `RendererContext` and Solid's reactive ownership.

### useRenderer()

Returns the current `CliRenderer` instance from context. Throws if called outside of a render tree.

```typescript
declare const useRenderer: () => CliRenderer
```

```tsx
function StatusBar() {
  const renderer = useRenderer()
  // Access renderer properties directly
  return <text>Terminal: {renderer.width}x{renderer.height}</text>
}
```

### useTerminalDimensions()

Returns a reactive signal accessor with the current terminal `width` and `height`. Automatically updates when the terminal is resized.

```typescript
declare const useTerminalDimensions: () => Accessor<{ width: number; height: number }>
```

```tsx
function ResponsiveLayout() {
  const dims = useTerminalDimensions()

  return (
    <box flexDirection={dims().width > 80 ? "row" : "column"}>
      <box flex={1}><text>Sidebar</text></box>
      <box flex={3}><text>Main ({dims().width}x{dims().height})</text></box>
    </box>
  )
}
```

**Implementation:** Uses `useRenderer()` internally. Creates a signal, subscribes to the renderer's `"resize"` event via `onResize`, and cleans up the listener on component disposal.

### onResize(callback)

Low-level resize subscription. Subscribes on mount, unsubscribes on cleanup. Prefer `useTerminalDimensions()` for reactive access to dimensions.

```typescript
declare const onResize: (callback: (width: number, height: number) => void) => void
```

```tsx
function MyComponent() {
  onResize((width, height) => {
    console.log(`Terminal resized to ${width}x${height}`)
  })
  return <box />
}
```

### useKeyboard(callback, options?)

Subscribe to keyboard events. By default only receives press events (including key repeats where `event.repeated` is `true`). Set `options.release` to also receive release events (where `event.eventType` is `"release"`).

```typescript
interface UseKeyboardOptions {
  /** Include release events */
  release?: boolean
}

declare const useKeyboard: (
  callback: (key: KeyEvent) => void,
  options?: UseKeyboardOptions
) => void
```

**KeyEvent fields** (from `@opentui/core`):
- `name` -- Key name (e.g., `"a"`, `"enter"`, `"escape"`, `"up"`)
- `eventType` -- `"press"` or `"release"`
- `repeated` -- `true` if this is a key repeat
- `ctrl`, `alt`, `shift`, `meta` -- Modifier key states

```tsx
function VimBindings() {
  const [mode, setMode] = createSignal("normal")

  useKeyboard((e) => {
    if (e.name === "i" && mode() === "normal") setMode("insert")
    if (e.name === "escape" && mode() === "insert") setMode("normal")
  })

  return <text>Mode: {mode()}</text>
}
```

```tsx
// Track held keys
function KeyTracker() {
  const [held, setHeld] = createSignal(new Set<string>())

  useKeyboard((e) => {
    setHeld(prev => {
      const next = new Set(prev)
      if (e.eventType === "release") next.delete(e.name)
      else next.add(e.name)
      return next
    })
  }, { release: true })

  return <text>Held: {[...held()].join(", ") || "none"}</text>
}
```

**Implementation:** Subscribes to `"keypress"` (and optionally `"keyrelease"`) on `renderer.keyInput`. Cleans up on component disposal.

### usePaste(callback)

Subscribe to paste events from the terminal.

```typescript
declare const usePaste: (callback: (event: PasteEvent) => void) => void
```

```tsx
function PasteHandler() {
  usePaste((event) => {
    console.log("User pasted:", event.text)
  })
  return <text>Paste something...</text>
}
```

**Implementation:** Subscribes to `"paste"` on `renderer.keyInput`.

### useSelectionHandler(callback)

Subscribe to text selection events (mouse-based text selection in the terminal).

```typescript
declare const useSelectionHandler: (callback: (selection: Selection) => void) => void
```

```tsx
useSelectionHandler((selection) => {
  const text = selection.getSelectedText()
  if (text) console.log("Selected:", text)
})
```

**Implementation:** Subscribes to `"selection"` on the renderer.

### useTimeline(options?)

Create and register a `Timeline` instance for animations. The timeline is automatically played on mount (unless `autoplay: false`) and paused/unregistered on cleanup.

```typescript
declare const useTimeline: (options?: TimelineOptions) => Timeline
```

```tsx
function FadeIn() {
  const timeline = useTimeline({ duration: 500 })

  return (
    <box style={{ opacity: timeline.progress }}>
      <text>Fading in...</text>
    </box>
  )
}
```

```tsx
// Looping animation
const timeline = useTimeline({ duration: 1000, loop: true })

// Manual control
const timeline = useTimeline({ autoplay: false })
timeline.play()
timeline.pause()
timeline.seek(0.5) // 50%
```

**Implementation:** Creates a `new Timeline(options)`, calls `engine.register(timeline)` on mount and `engine.unregister(timeline)` on cleanup.

### useKeyHandler (deprecated)

Renamed to `useKeyboard`. Same signature and behavior.

```typescript
/** @deprecated Use useKeyboard instead */
declare const useKeyHandler: (callback: (key: KeyEvent) => void, options?: UseKeyboardOptions) => void
```

---

## JSX Elements Reference

### Common Props

All elements support these Solid-specific props in addition to their renderable options:

```typescript
type ElementProps<TRenderable> = {
  ref?: Ref<TRenderable>   // Solid ref for direct access to the renderable instance
}
```

All layout elements (everything except text modifiers) also support a `style` prop that accepts a partial subset of the element's options, excluding non-style properties like `id`, `buffered`, `live`, `enableLayout`, `selectable`, `renderAfter`, `renderBefore`, and event handlers.

Interactive elements (`input`, `textarea`, `select`, `tab_select`, `box`, `scrollbox`) support the `focused` prop (`boolean`) to programmatically focus/blur the element.

### Layout and Container Elements

#### `<box>`

The primary layout container. Uses Yoga (Flexbox) for layout. Supports borders, padding, margins, flex properties, and background colors.

```typescript
type BoxProps = BoxOptions & {
  children?: JSX.Element
  focused?: boolean
  style?: Partial<Omit<BoxOptions, NonStyledProps | "title">>
  ref?: Ref<BoxRenderable>
}
```

**Key BoxOptions properties:**
- `flex`, `flexDirection`, `flexGrow`, `flexShrink`, `flexBasis`, `flexWrap`
- `alignItems`, `alignSelf`, `alignContent`, `justifyContent`
- `width`, `height`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight`
- `padding`, `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft`
- `margin`, `marginTop`, `marginRight`, `marginBottom`, `marginLeft`
- `border` (boolean or border config), `borderColor`, `borderStyle`
- `backgroundColor`, `title`
- `position` (`"relative"` | `"absolute"`), `top`, `right`, `bottom`, `left`
- `gap`, `rowGap`, `columnGap`
- `overflow` (`"visible"` | `"hidden"` | `"scroll"`)

```tsx
<box
  flex={1}
  flexDirection="column"
  padding={2}
  border
  borderColor="#89b4fa"
  backgroundColor="#1e1e2e"
  gap={1}
>
  <text>Header</text>
  <box flex={1}>
    <text>Content area</text>
  </box>
</box>
```

#### `<scrollbox>`

A scrollable container. Wraps content in an internal scrollable viewport.

```typescript
type ScrollBoxProps = ScrollBoxOptions & {
  children?: JSX.Element
  focused?: boolean
  stickyScroll?: boolean
  stickyStart?: "bottom" | "top" | "left" | "right"
  style?: Partial<Omit<ScrollBoxOptions, NonStyledProps>>
  ref?: Ref<ScrollBoxRenderable>
}
```

**Key ScrollBoxOptions properties:**
- `scrollX`, `scrollY` (boolean) -- Enable horizontal/vertical scrolling
- `viewportCulling` (boolean) -- Only render visible content for performance
- All `BoxOptions` layout properties

```tsx
<scrollbox scrollY stickyScroll stickyStart="bottom" flex={1}>
  <For each={messages()}>
    {(msg) => <text>{msg}</text>}
  </For>
</scrollbox>
```

### Text Elements

#### `<text>`

A text display container. Can contain raw strings, numbers, and inline text modifier elements (`span`, `strong`, `em`, etc.).

```typescript
type TextProps = TextOptions & {
  children?: TextChildren | Array<TextChildren>
  style?: Partial<Omit<TextOptions, NonStyledProps | "content">>
  ref?: Ref<TextRenderable>
}

type TextChildren = string | number | boolean | null | undefined | JSX.Element
```

**Key TextOptions properties:**
- `content` -- Static text content (alternative to children)
- `fg`, `bg` -- Foreground/background color (hex string, named color, or RGB)
- `bold`, `italic`, `underline`, `strikethrough`, `dim`
- `wrap` -- Text wrapping mode
- All `BoxOptions` layout properties (text is also a layout node)

```tsx
<text fg="#cdd6f4" bold>
  Status: <span fg="#a6e3a1">Online</span>
</text>
```

```tsx
<text content={`Score: ${score()}`} fg="#f9e2af" />
```

### Input Elements

#### `<input>`

Single-line text input with cursor, placeholder, and event callbacks.

```typescript
type InputProps = InputRenderableOptions & {
  focused?: boolean
  onInput?: (value: string) => void
  onChange?: (value: string) => void
  onSubmit?: (value: string) => void
  style?: Partial<Omit<InputRenderableOptions, NonStyledProps | "placeholder" | "value">>
  ref?: Ref<InputRenderable>
}
```

| Event | Fires when |
|---|---|
| `onInput` | Text changes (every keystroke) |
| `onChange` | Value changes (debounced/committed) |
| `onSubmit` | Enter is pressed |

```tsx
function SearchInput() {
  const [query, setQuery] = createSignal("")

  return (
    <input
      value={query()}
      placeholder="Search..."
      focused
      onInput={setQuery}
      onSubmit={(v) => performSearch(v)}
    />
  )
}
```

#### `<textarea>`

Multi-line text editor with cursor tracking, word wrap, and key event handling.

```typescript
type TextareaProps = TextareaOptions & {
  focused?: boolean
  onSubmit?: () => void
  onContentChange?: (value: string) => void
  onCursorChange?: (value: { line: number; visualColumn: number }) => void
  onKeyDown?: (event: KeyEvent) => void
  onKeyPress?: (event: KeyEvent) => void
  style?: Partial<Omit<TextareaOptions, NonStyledProps>>
  ref?: Ref<TextareaRenderable>
}
```

```tsx
<textarea
  initialValue="Edit me"
  wrapMode="word"
  focused
  onContentChange={(text) => setDraft(text)}
  onCursorChange={({ line, visualColumn }) => {
    setStatus(`Ln ${line}, Col ${visualColumn}`)
  }}
/>
```

#### `<select>`

Single-selection list with keyboard navigation.

```typescript
type SelectProps = SelectRenderableOptions & {
  focused?: boolean
  onChange?: (index: number, option: SelectOption | null) => void
  onSelect?: (index: number, option: SelectOption | null) => void
  style?: Partial<Omit<SelectRenderableOptions, NonStyledProps>>
  ref?: Ref<SelectRenderable>
}
```

| Event | Fires when |
|---|---|
| `onChange` | Highlighted item changes (arrow keys) |
| `onSelect` | Item is selected (Enter) |

```tsx
<select
  focused
  options={[
    { name: "TypeScript", description: "Typed JavaScript", value: "ts" },
    { name: "Rust", description: "Systems language", value: "rs" },
    { name: "Go", description: "Simple and fast", value: "go" },
  ]}
  selectedIndex={selectedIdx()}
  onChange={(idx) => setSelectedIdx(idx)}
  onSelect={(idx, opt) => confirm(opt)}
/>
```

#### `<tab_select>`

Horizontal tab-style selector.

```typescript
type TabSelectProps = TabSelectRenderableOptions & {
  focused?: boolean
  onChange?: (index: number, option: TabSelectOption | null) => void
  onSelect?: (index: number, option: TabSelectOption | null) => void
  style?: Partial<Omit<TabSelectRenderableOptions, NonStyledProps>>
  ref?: Ref<TabSelectRenderable>
}
```

```tsx
<tab_select
  options={[
    { name: "Code" },
    { name: "Output" },
    { name: "Settings" },
  ]}
  showUnderline
  onChange={(idx) => setActiveTab(idx)}
/>
```

### Code and Display Elements

#### `<code>`

Syntax-highlighted code block with optional tree-sitter integration.

```typescript
type CodeProps = CodeOptions & {
  style?: Partial<Omit<CodeOptions, NonStyledProps | "content" | "filetype" | "syntaxStyle" | "treeSitterClient">>
  ref?: Ref<CodeRenderable>
}
```

```tsx
<code
  content={sourceCode}
  filetype="typescript"
  syntaxStyle={mySyntaxTheme}
/>
```

#### `<line_number>`

Line-numbered code display with diff highlighting and diagnostic support.

```tsx
<line_number
  content={fileContent}
  startLine={1}
  highlightLines={[5, 10, 15]}
/>
```

#### `<diff>`

Unified or split diff viewer.

```tsx
<diff
  diff={unifiedDiffString}
  view="split"
  filetype="typescript"
/>
```

#### `<markdown>`

Markdown renderer with syntax highlighting for code blocks. Supports streaming content.

```typescript
type MarkdownProps = MarkdownOptions & {
  style?: Partial<Omit<MarkdownOptions, NonStyledProps | "content" | "syntaxStyle" | "treeSitterClient" | "conceal" | "renderNode">>
  ref?: Ref<MarkdownRenderable>
}
```

```tsx
<markdown
  content={markdownText()}
  syntaxStyle={syntaxTheme}
  streaming={isStreaming()}
/>
```

#### `<ascii_font>`

Large ASCII art text using figlet-style fonts.

```typescript
type AsciiFontProps = ASCIIFontOptions & {
  style?: Partial<Omit<ASCIIFontOptions, NonStyledProps | "text" | "selectable">>
  ref?: Ref<ASCIIFontRenderable>
}
```

```tsx
<ascii_font text="HELLO" font="slant" color="#89b4fa" />
```

### Text Modifier Elements

These elements must appear inside a `<text>` parent. They modify the text attributes of their content.

#### `<span>`

Inline styled text segment. Accepts foreground/background color and text attributes via the `style` prop.

```typescript
type SpanProps = {} & {
  children?: TextChildren | Array<TextChildren>
  ref?: Ref<TextNodeRenderable>
}
```

```tsx
<text>
  Status: <span style={{ fg: "#a6e3a1" }}>Active</span>
</text>
```

#### `<strong>` / `<b>`

Bold text. Both tags produce the same renderable (`BoldSpanRenderable`).

```tsx
<text><strong>Important:</strong> Read carefully</text>
<text><b>Also bold</b></text>
```

#### `<em>` / `<i>`

Italic text. Both tags produce the same renderable (`ItalicSpanRenderable`).

```tsx
<text><em>Emphasized</em> and <i>italic</i></text>
```

#### `<u>`

Underlined text.

```tsx
<text><u>Underlined text</u></text>
```

#### `<br>`

Line break within a `<text>` element. Inserts a literal `"\n"`.

```tsx
<text>Line one<br />Line two</text>
```

Takes no props (empty props interface `{}`).

#### `<a>`

Hyperlink text. Renders with terminal link escape sequences (in supported terminals).

```typescript
type LinkProps = SpanProps & {
  href: string
}
```

```tsx
<text>
  Visit <a href="https://github.com/anomalyco/opentui">OpenTUI</a>
</text>
```

---

## Special Components

### Portal

Renders children into a different mount point in the renderable tree, bypassing the normal parent hierarchy. Useful for overlays, modals, and tooltips that need to escape clipping containers.

```typescript
declare function Portal(props: {
  mount?: DomNode      // Target mount node (default: renderer.root)
  ref?: (el: {}) => void
  children: JSX.Element
}): DomNode
```

When no `mount` is specified, the portal's content is rendered at the renderer's root node. The children are wrapped in a `<box>` container.

```tsx
import { Portal } from "@opentui/solid"

function Modal(props: { show: boolean; children: JSX.Element }) {
  const renderer = useRenderer()

  return (
    <Show when={props.show}>
      <Portal mount={renderer.root}>
        <box
          position="absolute"
          top={5}
          left={10}
          width={40}
          height={10}
          border
          borderColor="#f38ba8"
          backgroundColor="#1e1e2e"
        >
          {props.children}
        </box>
      </Portal>
    </Show>
  )
}
```

### Dynamic

Renders a component or intrinsic element dynamically based on a reactive value. Equivalent to Solid's `<Dynamic>` but works with OpenTUI elements.

```typescript
declare function Dynamic<T extends ValidComponent>(
  props: DynamicProps<T>
): JSX.Element

type DynamicProps<T extends ValidComponent, P = ComponentProps<T>> = {
  [K in keyof P]: P[K]
} & {
  component: T | undefined
}
```

```tsx
import { Dynamic } from "@opentui/solid"

function AdaptiveInput(props: { multiline: boolean }) {
  return (
    <Dynamic
      component={props.multiline ? "textarea" : "input"}
      value={value()}
      focused
    />
  )
}
```

### createDynamic (low-level)

A lower-level function for performance-critical dynamic component rendering. Takes a getter function for the component instead of a `component` prop.

```typescript
declare function createDynamic<T extends ValidComponent>(
  component: () => T | undefined,
  props: ComponentProps<T>
): JSX.Element
```

```tsx
const element = () => isMultiline() ? "textarea" : "input"
const node = createDynamic(element, { value: currentValue() })
```

---

## Component Extension System

You can register custom renderable classes as new JSX intrinsic elements using `extend()`. This adds them to the global component catalogue so `createElement` can instantiate them by tag name.

### Step 1: Create a custom renderable

```typescript
import { BoxRenderable, type RenderContext, type BoxOptions } from "@opentui/core"

interface CustomWidgetOptions extends BoxOptions {
  label?: string
}

class CustomWidgetRenderable extends BoxRenderable {
  constructor(ctx: RenderContext, options: CustomWidgetOptions) {
    super(ctx, options)
    // Custom initialization
  }
}
```

### Step 2: Register it

```typescript
import { extend } from "@opentui/solid"

extend({ custom_widget: CustomWidgetRenderable })
```

### Step 3: Augment the JSX types (TypeScript)

To get type checking for the new element, augment the `OpenTUIComponents` interface:

```typescript
import type { RenderableConstructor } from "@opentui/solid"

declare module "@opentui/solid/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      custom_widget: ExtendedComponentProps<typeof CustomWidgetRenderable>
    }
  }
}
```

Or augment `OpenTUIComponents` for automatic prop inference:

```typescript
declare module "@opentui/solid" {
  interface OpenTUIComponents {
    custom_widget: typeof CustomWidgetRenderable
  }
}
```

### Step 4: Use it

```tsx
<custom_widget label="My Widget" flex={1} border />
```

The type system uses `ExtendedComponentProps<TConstructor>` to automatically:
1. Extract the options type from the constructor's second parameter
2. Add `children?: JSX.Element`
3. Add `style?: Partial<Omit<TOptions, NonStyledProps>>` (excluding non-style properties)
4. Add `ref?: Ref<TRenderable>`

---

## Reconciler Internals

These are low-level primitives exported from the reconciler. They are used internally by the JSX transform and are generally not needed in application code. They may be useful for library authors or advanced use cases.

### Exported Reconciler Primitives

```typescript
// Core rendering
export const _render: (code: () => BaseRenderable, node: BaseRenderable) => () => void
export const insert: <T>(parent: any, accessor: T | (() => T), marker?: any, initial?: any) => BaseRenderable
export const spread: <T>(node: any, accessor: (() => T) | T, skipChildren?: boolean) => void

// Node creation
export const createElement: (tag: string) => BaseRenderable
export const createTextNode: (value: string) => BaseRenderable
export function createSlotNode(): SlotRenderable
export const insertNode: (parent: BaseRenderable, node: BaseRenderable, anchor?: BaseRenderable) => void

// Property management
export const setProp: <T>(node: BaseRenderable, name: string, value: T, prev?: T) => T

// Re-exports from solid-js (used by compiled JSX output)
export const effect: typeof createRenderEffect
export const memo: <T>(fn: () => T) => Accessor<T>
export const createComponent: <T>(Comp: (props: T) => BaseRenderable, props: T) => BaseRenderable
export const mergeProps: (...sources: unknown[]) => unknown
export const use: <A, T>(fn: (element: BaseRenderable, arg: A) => T, element: BaseRenderable, arg: A) => T
```

The `RendererContext` is also exported for use in custom providers:

```typescript
export const RendererContext: Context<CliRenderer | undefined>
```

---

## Utilities

### ID Counter

Generates unique element IDs in the format `"{type}-{n}"` (e.g., `"box-1"`, `"text-3"`).

```typescript
// src/utils/id-counter.ts
export function getNextId(elementType: string): string
```

The counter is a module-level `Map<string, number>` that increments per element type. IDs are globally unique within a process.

### Debug Logging

Conditional debug logging controlled by the `DEBUG` environment variable.

```typescript
// src/utils/log.ts
export const log: (...args: any[]) => void
```

When `process.env.DEBUG` is truthy, logs prefixed with `[Reconciler]` are written to `console.log`. This is useful for debugging element creation, insertion, removal, and property changes during development:

```bash
DEBUG=1 bun run index.tsx
```

---

## Complete JSX Elements Quick Reference

| Element | Renderable Class | Parent Constraint | Category |
|---|---|---|---|
| `box` | `BoxRenderable` | Any layout node | Layout |
| `text` | `TextRenderable` | Any layout node | Text |
| `scrollbox` | `ScrollBoxRenderable` | Any layout node | Layout |
| `input` | `InputRenderable` | Any layout node | Input |
| `textarea` | `TextareaRenderable` | Any layout node | Input |
| `select` | `SelectRenderable` | Any layout node | Input |
| `tab_select` | `TabSelectRenderable` | Any layout node | Input |
| `code` | `CodeRenderable` | Any layout node | Display |
| `line_number` | `LineNumberRenderable` | Any layout node | Display |
| `diff` | `DiffRenderable` | Any layout node | Display |
| `markdown` | `MarkdownRenderable` | Any layout node | Display |
| `ascii_font` | `ASCIIFontRenderable` | Any layout node | Display |
| `span` | `SpanRenderable` | `text` or text node | Text Modifier |
| `strong` | `BoldSpanRenderable` | `text` or text node | Text Modifier |
| `b` | `BoldSpanRenderable` | `text` or text node | Text Modifier |
| `em` | `ItalicSpanRenderable` | `text` or text node | Text Modifier |
| `i` | `ItalicSpanRenderable` | `text` or text node | Text Modifier |
| `u` | `UnderlineSpanRenderable` | `text` or text node | Text Modifier |
| `br` | `LineBreakRenderable` | `text` or text node | Text Modifier |
| `a` | `LinkRenderable` | `text` or text node | Text Modifier |
