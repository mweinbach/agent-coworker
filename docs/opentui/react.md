# React Integration

`@opentui/react` provides a full React renderer for building terminal UIs with OpenTUI. It uses `react-reconciler` to bridge React's virtual DOM diffing into OpenTUI's renderable tree, giving you familiar React patterns -- hooks, refs, context, error boundaries -- all targeting the terminal.

**Version:** 0.1.77 | **License:** MIT | **Peer dependencies:** `react >=19.0.0`

## Table of Contents

- [Architecture](#architecture)
  - [How JSX Maps to OpenTUI Renderables](#how-jsx-maps-to-opentui-renderables)
  - [Reconciler and Host Config](#reconciler-and-host-config)
  - [JSX Runtime](#jsx-runtime)
  - [JSX Namespace and Type Definitions](#jsx-namespace-and-type-definitions)
- [Setup Guide](#setup-guide)
  - [Installation](#installation)
  - [TypeScript Configuration](#typescript-configuration)
  - [Quick Start](#quick-start)
  - [Scaffolding with create-tui](#scaffolding-with-create-tui)
- [API Reference](#api-reference)
  - [createRoot(renderer)](#createrootrenderer)
  - [flushSync()](#flushsync)
  - [createPortal()](#createportal)
  - [extend(components)](#extendcomponents)
  - [AppContext](#appcontext)
  - [ErrorBoundary](#errorboundary)
- [Hooks](#hooks)
  - [useRenderer()](#userenderer)
  - [useKeyboard(handler, options?)](#usekeyboardhandler-options)
  - [useOnResize(callback)](#useonresizecallback)
  - [useTerminalDimensions()](#useterminaldimensions)
  - [useTimeline(options?)](#usetimelineoptions)
  - [useEffectEvent(handler)](#useeffecteventhandler)
- [JSX Elements Reference](#jsx-elements-reference)
  - [Layout Components](#layout-components)
    - [box](#box)
    - [scrollbox](#scrollbox)
    - [line-number](#line-number)
  - [Text Components](#text-components)
    - [text](#text)
    - [span](#span)
    - [Text Modifiers: b, strong, i, em, u](#text-modifiers-b-strong-i-em-u)
    - [a (Link)](#a-link)
    - [br (Line Break)](#br-line-break)
  - [Input Components](#input-components)
    - [input](#input)
    - [textarea](#textarea)
    - [select](#select)
    - [tab-select](#tab-select)
  - [Display Components](#display-components)
    - [code](#code)
    - [markdown](#markdown)
    - [diff](#diff)
    - [ascii-font](#ascii-font)
- [Styling](#styling)
  - [Direct Props](#direct-props)
  - [Style Object](#style-object)
  - [Style Type Safety](#style-type-safety)
- [Component Extension](#component-extension)
  - [Creating Custom Components](#creating-custom-components)
  - [Module Augmentation for TypeScript](#module-augmentation-for-typescript)
- [Refs](#refs)
- [Test Utilities](#test-utilities)
- [React DevTools](#react-devtools)
- [Examples](#examples)
  - [Login Form](#login-form)
  - [Counter with Timer](#counter-with-timer)
  - [System Monitor Animation](#system-monitor-animation)
  - [Styled Text Showcase](#styled-text-showcase)
- [Comparison with @opentui/solid](#comparison-with-opentuisolid)

---

## Architecture

### How JSX Maps to OpenTUI Renderables

When you write `<box padding={1}>` in JSX, the React binding translates it through several layers:

1. **JSX Transform** -- The TypeScript/Bun compiler sees `jsxImportSource: "@opentui/react"` and rewrites JSX into `jsx()` / `jsxs()` calls from `@opentui/react/jsx-runtime`.
2. **React Runtime** -- The `jsx-runtime.js` re-exports React's own `jsx`, `jsxs`, and `Fragment`. The JSX calls produce standard React elements.
3. **React Reconciler** -- The custom `react-reconciler` host config receives these elements and creates/updates OpenTUI core renderable instances (`BoxRenderable`, `TextRenderable`, etc.).
4. **Renderable Tree** -- Each JSX element type maps to a renderable constructor in the component catalogue. The reconciler creates instances via `new Constructor(renderContext, props)` and attaches them to a `RootRenderable` container.
5. **Render Loop** -- OpenTUI's `CliRenderer` takes over from here, laying out the renderable tree with flexbox, rendering to an optimized buffer, and writing ANSI output to the terminal.

```
JSX Element          React Element         Reconciler            OpenTUI Core
-----------          -------------         ----------            ------------
<box padding={1}>  -> jsx("box", {...})  -> new BoxRenderable()  -> flexbox layout
  <text>Hello</text>  jsx("text", {...})    new TextRenderable()    text rendering
</box>                                      parent.add(child)       buffer -> ANSI
```

The key insight is that **type checking happens at the JSX namespace level** (compile time), while **instance creation happens at the reconciler level** (runtime). The `jsx-namespace.d.ts` file defines what props each element accepts; the `baseComponents` map controls which renderable class is instantiated.

### Reconciler and Host Config

The package uses `react-reconciler` (v0.32+) with a custom `HostConfig`. The host types are defined in `src/types/host.d.ts`:

| Host Type | Maps To |
|-----------|---------|
| `Type` | `keyof typeof baseComponents` -- string tag names like `"box"`, `"text"`, etc. |
| `Container` | `RootRenderable` -- the top-level renderable that owns the tree |
| `Instance` | `BaseRenderable` -- any OpenTUI renderable node |
| `TextInstance` | `TextNodeRenderable` -- inline text content |
| `PublicInstance` | `BaseRenderable` -- what `ref` exposes to user code |
| `HostContext` | `Record<string, any> & { isInsideText?: boolean }` |

The host config (`src/reconciler/host-config.d.ts`) implements all required reconciler methods: `createInstance`, `createTextInstance`, `appendInitialChild`, `appendChild`, `removeChild`, `prepareUpdate`, `commitUpdate`, and so on. The utility functions `setInitialProperties` and `updateProperties` in `src/utils/index.d.ts` handle mapping React props to renderable option mutations.

An auto-incrementing ID generator (`src/utils/id.d.ts`) provides unique IDs per element type (e.g., `box-0`, `box-1`, `text-0`).

### JSX Runtime

The JSX runtime files are thin re-exports:

**`jsx-runtime.d.ts`** (production):
```typescript
export { Fragment, jsx, jsxs } from "react/jsx-runtime"
export type * from "./jsx-namespace.d.ts"
```

**`jsx-dev-runtime.d.ts`** (development):
```typescript
export { Fragment, jsxDEV } from "react/jsx-dev-runtime"
export type * from "./jsx-namespace.d.ts"
```

**`jsx-runtime.js`** (implementation):
```javascript
export { Fragment, jsx, jsxs } from "react/jsx-runtime"
```

The runtime delegates entirely to React's own JSX functions. The type information comes from the separate `jsx-namespace.d.ts` file, which defines the `JSX` namespace with OpenTUI-specific intrinsic elements.

### JSX Namespace and Type Definitions

The `jsx-namespace.d.ts` file defines the complete `JSX` namespace:

```typescript
export namespace JSX {
  type Element = React.ReactNode

  interface ElementClass extends React.ComponentClass<any> {
    render(): React.ReactNode
  }

  interface ElementAttributesProperty { props: {} }
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes extends React.Attributes {}

  interface IntrinsicElements
    extends React.JSX.IntrinsicElements,
            ExtendedIntrinsicElements<OpenTUIComponents> {
    box: BoxProps
    text: TextProps
    span: SpanProps
    code: CodeProps
    diff: DiffProps
    markdown: MarkdownProps
    input: InputProps
    textarea: TextareaProps
    select: SelectProps
    scrollbox: ScrollBoxProps
    "ascii-font": AsciiFontProps
    "tab-select": TabSelectProps
    "line-number": LineNumberProps
    b: SpanProps
    i: SpanProps
    u: SpanProps
    strong: SpanProps
    em: SpanProps
    br: LineBreakProps
    a: LinkProps
  }
}
```

Key design choices:
- `JSX.Element` is `React.ReactNode`, so components can return strings, numbers, arrays, and fragments.
- `IntrinsicElements` extends **both** `React.JSX.IntrinsicElements` (for HTML-like elements in type-checking contexts) and `ExtendedIntrinsicElements<OpenTUIComponents>` (for user-registered custom components).
- Hyphenated element names (`ascii-font`, `tab-select`, `line-number`) work naturally in JSX.
- Text modifier elements (`b`, `strong`, `i`, `em`, `u`) use `SpanProps`, while `br` uses a minimal `LineBreakProps` (just `id`).

---

## Setup Guide

### Installation

```bash
bun install @opentui/react @opentui/core react
```

Optional peer dependencies for DevTools support:
```bash
bun install --dev react-devtools-core@7 ws
```

### TypeScript Configuration

Configure `tsconfig.json` to use the OpenTUI React JSX runtime:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "strict": true,
    "skipLibCheck": true
  }
}
```

The critical settings are:
- `"jsx": "react-jsx"` -- uses the automatic JSX transform (no manual `import React` needed).
- `"jsxImportSource": "@opentui/react"` -- tells TypeScript to load JSX types from `@opentui/react/jsx-runtime` and `@opentui/react/jsx-namespace`.

### Quick Start

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return (
    <box flex flexDirection="column" padding={1}>
      <text>Hello, Terminal!</text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

### Scaffolding with create-tui

For a pre-configured project:

```bash
bun create tui --template react
```

---

## API Reference

### createRoot(renderer)

Creates a root for rendering a React tree into the terminal. This is the primary entry point.

```typescript
import { CliRenderer } from "@opentui/core"
import { ReactNode } from "react"

type Root = {
  render: (node: ReactNode) => void
  unmount: () => void
}

function createRoot(renderer: CliRenderer): Root
```

**Parameters:**
- `renderer` -- A `CliRenderer` instance, typically created with `createCliRenderer()` from `@opentui/core`.

**Returns:** A `Root` object with:
- `render(node)` -- Render a React element tree into the terminal.
- `unmount()` -- Tear down the React tree and clean up.

**Usage:**
```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

const renderer = await createCliRenderer({ exitOnCtrlC: true })
const root = createRoot(renderer)

root.render(<App />)

// Later, to clean up:
root.unmount()
```

**Import path:** `@opentui/react` or `@opentui/react/renderer`

### flushSync()

Synchronously flush pending React updates. Useful in tests or when you need to ensure the renderable tree is up-to-date before reading state.

```typescript
function flushSync(): void
function flushSync<R>(fn: () => R): R
```

**Import path:** `@opentui/react/renderer`

### createPortal()

Create a React portal to render children into a different container renderable.

```typescript
function createPortal(
  children: ReactNode,
  containerInfo: any,
  implementation: any,
  key?: string | null
): ReactPortal
```

**Import path:** `@opentui/react/renderer`

### extend(components)

Register custom renderable classes so they can be used as JSX elements.

```typescript
type ComponentCatalogue = Record<string, RenderableConstructor>

function extend<T extends ComponentCatalogue>(objects: T): void
```

See [Component Extension](#component-extension) for full details.

### AppContext

React context that provides access to the `KeyHandler` and `CliRenderer` at the application level.

```typescript
interface AppContext {
  keyHandler: KeyHandler | null
  renderer: CliRenderer | null
}

const AppContext: React.Context<AppContext>
const useAppContext: () => AppContext
```

### ErrorBoundary

A built-in error boundary component that catches rendering errors in the React tree.

```tsx
import { ErrorBoundary } from "@opentui/react"

function App() {
  return (
    <ErrorBoundary>
      <RiskyComponent />
    </ErrorBoundary>
  )
}
```

When a child throws during render, `ErrorBoundary` captures the error via `getDerivedStateFromError` and sets `{ hasError: true, error }` in its state.

---

## Hooks

All hooks are exported from `@opentui/react`.

### useRenderer()

Access the underlying `CliRenderer` instance.

```tsx
import { useRenderer } from "@opentui/react"

function App() {
  const renderer = useRenderer()

  useEffect(() => {
    renderer.setTerminalTitle("My App")
    renderer.console.show()
  }, [])

  return <box />
}
```

**Returns:** `CliRenderer` from `@opentui/core`.

### useKeyboard(handler, options?)

Subscribe to keyboard events. By default, receives press events only (including key repeats with `repeated: true`). Set `options.release` to also receive release events.

```typescript
interface UseKeyboardOptions {
  release?: boolean  // Include release events (default: false)
}

function useKeyboard(
  handler: (key: KeyEvent) => void,
  options?: UseKeyboardOptions
): void
```

**KeyEvent properties:**

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Key name (`"return"`, `"escape"`, `"a"`, etc.) |
| `ctrl` | `boolean` | Ctrl key pressed |
| `shift` | `boolean` | Shift key pressed |
| `meta` | `boolean` | Meta/Command key pressed |
| `option` | `boolean` | Alt/Option key pressed |
| `eventType` | `string` | `"press"` or `"repeat"` or `"release"` |
| `repeated` | `boolean` | Is a key repeat |

**Example with release tracking:**
```tsx
import { useKeyboard } from "@opentui/react"
import { useState } from "react"

function App() {
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set())

  useKeyboard((event) => {
    setPressedKeys((keys) => {
      const next = new Set(keys)
      if (event.eventType === "release") next.delete(event.name)
      else next.add(event.name)
      return next
    })
  }, { release: true })

  return <text>Pressed: {Array.from(pressedKeys).join(", ") || "none"}</text>
}
```

### useOnResize(callback)

Subscribe to terminal resize events.

```typescript
function useOnResize(
  callback: (width: number, height: number) => void
): CliRenderer
```

**Returns:** The `CliRenderer` instance (for convenience chaining).

```tsx
function App() {
  useOnResize((width, height) => {
    console.log(`Resized to ${width}x${height}`)
  })
  return <box />
}
```

### useTerminalDimensions()

Get current terminal dimensions. Automatically re-renders when the terminal is resized.

```typescript
function useTerminalDimensions(): { width: number; height: number }
```

```tsx
function App() {
  const { width, height } = useTerminalDimensions()
  return <text>Terminal: {width}x{height}</text>
}
```

### useTimeline(options?)

Create and manage animations using OpenTUI's timeline system. The timeline is automatically registered and unregistered with the animation engine.

```typescript
import { Timeline, type TimelineOptions } from "@opentui/core"

function useTimeline(options?: TimelineOptions): Timeline
```

**TimelineOptions:**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `duration` | `number` | `1000` | Duration in milliseconds |
| `loop` | `boolean` | `false` | Loop the timeline |
| `autoplay` | `boolean` | `true` | Start automatically |
| `onComplete` | `() => void` | -- | Called when timeline completes |
| `onPause` | `() => void` | -- | Called when timeline pauses |

**Timeline methods:**
- `add(target, properties, startTime?)` -- Add animation to timeline
- `play()` -- Start playback
- `pause()` -- Pause playback
- `restart()` -- Restart from beginning

```tsx
function AnimatedBox() {
  const [width, setWidth] = useState(0)
  const timeline = useTimeline({ duration: 2000 })

  useEffect(() => {
    timeline.add(
      { width },
      {
        width: 50,
        duration: 2000,
        ease: "linear",
        onUpdate: (anim) => setWidth(anim.targets[0].width),
      }
    )
  }, [])

  return <box style={{ width, backgroundColor: "#6a5acd" }} />
}
```

### useEffectEvent(handler)

Returns a stable callback that always calls the latest version of the provided handler. Prevents unnecessary re-renders and effect re-runs while ensuring the callback has access to the latest props and state.

```typescript
function useEffectEvent<T extends (...args: any[]) => any>(handler: T): T
```

This is useful for event handlers that need to be passed to effects with empty dependency arrays or to memoized child components.

```tsx
function Chat({ onMessage }) {
  const stableOnMessage = useEffectEvent(onMessage)

  useEffect(() => {
    // This effect never re-runs, but stableOnMessage
    // always calls the latest onMessage prop
    socket.on("message", stableOnMessage)
    return () => socket.off("message", stableOnMessage)
  }, [])

  return <box />
}
```

---

## JSX Elements Reference

### Layout Components

#### box

Container component with flexbox layout. Maps to `BoxRenderable`.

```tsx
<box
  flex={1}
  flexDirection="column"
  justifyContent="center"
  alignItems="center"
  padding={2}
  backgroundColor="#1e1e2e"
  border
  borderStyle="single"    // "single" | "double" | "round" | "bold"
  borderColor="#89b4fa"
  title="My Box"
  focused={false}
>
  <text>Content</text>
</box>
```

**Props:** `BoxProps` -- all `BoxOptions` from `@opentui/core` plus:

| Prop | Type | Description |
|------|------|-------------|
| `focused` | `boolean` | Whether this box has focus |
| `title` | `string` | Title displayed in border |
| `border` | `boolean` | Enable border |
| `borderStyle` | `string` | Border style variant |
| `borderColor` | `string` | Border color |
| `flex` | `number \| boolean` | Flex grow factor |
| `flexDirection` | `"row" \| "column"` | Layout direction |
| `justifyContent` | `string` | Main axis alignment |
| `alignItems` | `string` | Cross axis alignment |
| `padding` | `number` | Padding on all sides |
| `paddingLeft/Right/Top/Bottom` | `number` | Individual padding |
| `margin` | `number` | Margin on all sides |
| `gap` | `number` | Gap between children |
| `width` / `height` | `number \| string` | Dimensions (number for cells, string like `"100%"`) |
| `minWidth` / `minHeight` | `number` | Minimum dimensions |
| `maxWidth` / `maxHeight` | `number` | Maximum dimensions |
| `backgroundColor` | `string` | Background color |
| `opacity` | `number` | Opacity (0-1) |
| `children` | `ReactNode` | Child elements |
| `style` | `Partial<...>` | Style object (excludes `title` and non-styled props) |
| `ref` | `Ref<BoxRenderable>` | Ref to underlying renderable |

#### scrollbox

Scrollable container. Maps to `ScrollBoxRenderable`.

```tsx
<scrollbox
  scrollY={true}
  scrollX={false}
  stickyScroll={true}
  viewportCulling={true}
  focused
  style={{
    rootOptions: { backgroundColor: "#24283b" },
    wrapperOptions: { backgroundColor: "#1f2335" },
    viewportOptions: { backgroundColor: "#1a1b26" },
    contentOptions: { backgroundColor: "#16161e" },
    scrollbarOptions: {
      showArrows: true,
      trackOptions: {
        foregroundColor: "#7aa2f7",
        backgroundColor: "#414868",
      },
    },
  }}
>
  {items.map((item, i) => (
    <box key={i}><text>{item}</text></box>
  ))}
</scrollbox>
```

**Props:** `ScrollBoxProps` -- all `ScrollBoxOptions` plus `focused`, `children`, `style`, `ref`.

#### line-number

Container that displays line numbers alongside child content (typically `<code>`). Maps to `LineNumberRenderable`.

```tsx
<line-number
  ref={lineNumberRef}
  fg="#6b7280"
  bg="#161b22"
  minWidth={3}
  paddingRight={1}
  showLineNumbers={true}
  width="100%"
  height="100%"
  focused={false}
>
  <code content={source} filetype="typescript" syntaxStyle={style} />
</line-number>
```

**Ref methods** (via `LineNumberRenderable`):
- `setLineColor(line, color)` -- Set background color for a line (e.g., diff highlighting)
- `setLineSign(line, { before?, after?, beforeColor?, afterColor? })` -- Add gutter signs

### Text Components

#### text

Text display with optional styling and inline children. Maps to `TextRenderable`.

```tsx
<text fg="#cdd6f4" bg="#1e1e2e">Plain text</text>

<text>
  Text with <strong>bold</strong> and <em>italic</em> parts
</text>

<text content="Can also use content prop" />
```

**Props:** `TextProps` -- all `TextOptions` plus:

| Prop | Type | Description |
|------|------|-------------|
| `content` | `string` | Text content (alternative to children) |
| `fg` | `string` | Foreground color |
| `bg` | `string` | Background color |
| `attributes` | `TextAttributes` | Text attributes (bold, dim, etc.) |
| `children` | `TextChildren` | String, number, boolean, or ReactNode children |
| `style` | `Partial<...>` | Style object (excludes `content`) |
| `ref` | `Ref<TextRenderable>` | Ref to underlying renderable |

**Valid children types:** `string | number | boolean | null | undefined | ReactNode`

#### span

Inline text node, typically used inside `<text>`. Maps to `SpanRenderable` (extends `TextNodeRenderable`).

```tsx
<text>
  <span fg="red">Red</span> and <span fg="blue">blue</span>
</text>
```

**Props:** `SpanProps` -- all `TextNodeOptions` plus `children`, `style`, `ref`.

#### Text Modifiers: b, strong, i, em, u

Text formatting elements that must be used inside `<text>`. Each maps to a specialized renderable:

| Element | Renderable | Effect |
|---------|------------|--------|
| `<b>`, `<strong>` | `BoldSpanRenderable` | Bold text |
| `<i>`, `<em>` | `ItalicSpanRenderable` | Italic text |
| `<u>` | `UnderlineSpanRenderable` | Underlined text |

All accept `SpanProps` and can include additional styling:

```tsx
<text>
  <strong fg="red">Bold red</strong>
  <em bg="#333">Italic with background</em>
</text>
```

#### a (Link)

Hyperlink element. Maps to `LinkRenderable` (extends `SpanRenderable`).

```tsx
<text>
  Visit <a href="https://example.com">our site</a>
</text>
```

**Props:** `LinkProps` = `SpanProps & { href: string }`

#### br (Line Break)

Line break element. Maps to `LineBreakRenderable`.

```tsx
<text>
  First line<br />Second line
</text>
```

**Props:** `LineBreakProps` = `Pick<SpanProps, "id">` (only accepts an `id` prop)

### Input Components

#### input

Single-line text input. Maps to `InputRenderable`.

```tsx
<input
  value={value}
  placeholder="Enter text..."
  onInput={(v) => setValue(v)}
  onChange={(v) => console.log("Changed:", v)}
  onSubmit={(v) => console.log("Submitted:", v)}
  maxLength={100}
  focused
/>
```

**Props:** `InputProps` -- all `InputRenderableOptions` plus:

| Prop | Type | Description |
|------|------|-------------|
| `focused` | `boolean` | Whether the input has focus |
| `value` | `string` | Current value |
| `placeholder` | `string` | Placeholder text |
| `onInput` | `(value: string) => void` | Fires on every keystroke |
| `onChange` | `(value: string) => void` | Fires on value change |
| `onSubmit` | `(value: string) => void` | Fires on Enter |
| `ref` | `Ref<InputRenderable>` | Ref to underlying renderable |

#### textarea

Multi-line text input. Maps to `TextareaRenderable`.

```tsx
<textarea
  initialValue="Initial content"
  placeholder="Type here..."
  onSubmit={(e) => console.log(e)}
  onCursorChange={(e) => console.log(e.line, e.visualColumn)}
  wrapMode="word"
  focused
  ref={textareaRef}
/>
```

**Props:** `TextareaProps` -- all `TextareaOptions` plus `focused`, `style`, `ref`.

**Ref access:** The `TextareaRenderable` ref exposes properties like `plainText` for reading the current content.

#### select

List selection component. Maps to `SelectRenderable`.

```tsx
const options = [
  { name: "Option 1", description: "First option", value: 1 },
  { name: "Option 2", description: "Second option", value: 2 },
]

<select
  options={options}
  selectedIndex={0}
  onChange={(index, option) => console.log(index, option)}
  onSelect={(index, option) => console.log("Selected:", option)}
  showScrollIndicator
  wrapSelection
  focused
/>
```

**Props:** `SelectProps` -- all `SelectRenderableOptions` plus:

| Prop | Type | Description |
|------|------|-------------|
| `focused` | `boolean` | Whether the select has focus |
| `options` | `SelectOption[]` | Array of `{ name, description?, value? }` |
| `selectedIndex` | `number` | Currently selected index |
| `onChange` | `(index: number, option: SelectOption \| null) => void` | Fires on highlight change |
| `onSelect` | `(index: number, option: SelectOption \| null) => void` | Fires on Enter |
| `showScrollIndicator` | `boolean` | Show scroll indicator |
| `wrapSelection` | `boolean` | Wrap around at list boundaries |

#### tab-select

Tab-based selection component. Maps to `TabSelectRenderable`.

```tsx
<tab-select
  options={[
    { name: "Tab 1", value: "t1" },
    { name: "Tab 2", value: "t2" },
  ]}
  showUnderline
  showScrollArrows
  onChange={(index, option) => setCurrentTab(index)}
  onSelect={(index, option) => console.log("Selected tab:", option)}
  focused
/>
```

**Props:** `TabSelectProps` -- all `TabSelectRenderableOptions` plus `focused`, `onChange`, `onSelect`, `style`, `ref`.

### Display Components

#### code

Syntax-highlighted code display. Maps to `CodeRenderable`.

```tsx
import { RGBA, SyntaxStyle } from "@opentui/core"

const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { fg: RGBA.fromHex("#ff6b6b"), bold: true },
  string: { fg: RGBA.fromHex("#51cf66") },
  comment: { fg: RGBA.fromHex("#868e96"), italic: true },
  number: { fg: RGBA.fromHex("#ffd43b") },
  default: { fg: RGBA.fromHex("#ffffff") },
})

<code
  content={codeString}
  filetype="typescript"
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
  streaming={false}
/>
```

**Props:** `CodeProps` -- all `CodeOptions` plus `style`, `ref`. Key content-related props (`content`, `filetype`, `syntaxStyle`, `treeSitterClient`, `conceal`, `drawUnstyledText`) are excluded from the `style` object type.

#### markdown

Markdown renderer with syntax highlighting. Maps to `MarkdownRenderable`.

```tsx
<markdown
  content="# Hello\n\n**Bold** text with `code`"
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
  streaming={true}
/>
```

**Props:** `MarkdownProps` -- all `MarkdownOptions` plus `style`, `ref`. Props `content`, `syntaxStyle`, `treeSitterClient`, `conceal`, and `renderNode` are excluded from the `style` type.

#### diff

Unified or split diff viewer with syntax highlighting. Maps to `DiffRenderable`.

```tsx
<diff
  diff={unifiedDiffString}
  view="unified"      // or "split"
  filetype="typescript"
  syntaxStyle={syntaxStyle}
  showLineNumbers
/>
```

**Props:** `DiffProps` -- all `DiffRenderableOptions` plus `style`, `ref`.

#### ascii-font

ASCII art text display. Maps to `ASCIIFontRenderable`.

```tsx
<ascii-font
  text="HELLO"
  font="slant"       // "block" | "shade" | "slick" | "tiny" | "slant"
  color="#89b4fa"
/>
```

**Props:** `AsciiFontProps` -- all `ASCIIFontOptions` plus `style`, `ref`. Props `text` and `selectable` are excluded from `style`.

---

## Styling

### Direct Props

Pass layout and visual properties directly as JSX props:

```tsx
<box
  backgroundColor="#1e1e2e"
  borderColor="#89b4fa"
  padding={1}
  margin={2}
  flex={1}
/>
```

### Style Object

Use the `style` prop for grouped styling. The `style` type automatically excludes non-styleable props like `id`, `content`, `title`, event handlers (`on*`), and component-specific props:

```tsx
<box style={{
  backgroundColor: "#1e1e2e",
  padding: 1,
  flexDirection: "column",
  border: true,
}}>
  <text style={{ fg: "#cdd6f4" }}>Styled content</text>
</box>
```

### Style Type Safety

The type system ensures that props which are semantic (not visual) cannot appear in the `style` object. This is controlled by `GetNonStyledProperties<TConstructor>`, which excludes:

- **All components:** `id`, `buffered`, `live`, `enableLayout`, `selectable`, `renderAfter`, `renderBefore`, and any `on*` handlers
- **TextRenderable:** additionally excludes `content`
- **BoxRenderable:** additionally excludes `title`
- **ASCIIFontRenderable:** additionally excludes `text`, `selectable`
- **InputRenderable:** additionally excludes `placeholder`, `value`
- **TextareaRenderable:** additionally excludes `placeholder`, `initialValue`
- **CodeRenderable:** additionally excludes `content`, `filetype`, `syntaxStyle`, `treeSitterClient`, `conceal`, `drawUnstyledText`
- **MarkdownRenderable:** additionally excludes `content`, `syntaxStyle`, `treeSitterClient`, `conceal`, `renderNode`

When both a direct prop and a `style` entry exist, the direct prop takes precedence.

---

## Component Extension

### Creating Custom Components

Extend OpenTUI by creating custom renderable classes and registering them:

```tsx
import {
  BoxRenderable,
  OptimizedBuffer,
  RGBA,
  type BoxOptions,
  type RenderContext,
} from "@opentui/core"
import { extend } from "@opentui/react"

class ButtonRenderable extends BoxRenderable {
  private _label = "Button"

  constructor(ctx: RenderContext, options: BoxOptions & { label?: string }) {
    super(ctx, { border: true, borderStyle: "single", minHeight: 3, ...options })
    if (options.label) this._label = options.label
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)
    const cx = this.x + Math.floor(this.width / 2 - this._label.length / 2)
    const cy = this.y + Math.floor(this.height / 2)
    buffer.drawText(this._label, cx, cy, RGBA.fromInts(255, 255, 255, 255))
  }

  set label(value: string) {
    this._label = value
    this.requestRender()
  }
}

// Register
extend({ consoleButton: ButtonRenderable })
```

### Module Augmentation for TypeScript

To get type-safe JSX for custom components, augment the `OpenTUIComponents` interface:

```tsx
declare module "@opentui/react" {
  interface OpenTUIComponents {
    consoleButton: typeof ButtonRenderable
  }
}

// Now this is fully typed:
<consoleButton label="Click me!" style={{ backgroundColor: "blue" }} />
```

The `ExtendedIntrinsicElements<OpenTUIComponents>` type in the JSX namespace automatically picks up augmentations and generates the correct prop types using `ExtendedComponentProps`, which:
1. Extracts the options type from the renderable constructor
2. Adds `children?: ReactNode`
3. Adds a `style` prop with proper non-styled-property exclusions
4. Adds `key` and `ref` props

---

## Refs

All intrinsic elements support `ref` via `ReactProps<TRenderable>`. The ref resolves to the underlying OpenTUI renderable instance, giving direct access to the renderable API:

```tsx
import { useRef, useEffect } from "react"
import type { TextareaRenderable } from "@opentui/core"

function Editor() {
  const ref = useRef<TextareaRenderable>(null)

  useEffect(() => {
    console.log("Content:", ref.current?.plainText)
  }, [])

  return <textarea ref={ref} focused placeholder="Type..." />
}
```

---

## Test Utilities

Import from `@opentui/react/test-utils`:

```typescript
import { testRender } from "@opentui/react/test-utils"
import { type TestRendererOptions } from "@opentui/core/testing"

async function testRender(
  node: ReactNode,
  testRendererOptions: TestRendererOptions
): Promise<{
  renderer: TestRenderer
  mockInput: MockInput
  mockMouse: MockMouse
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
  captureSpans: () => CapturedFrame
  resize: (width: number, height: number) => void
}>
```

**Returned utilities:**

| Name | Description |
|------|-------------|
| `renderer` | The `TestRenderer` instance |
| `mockInput` | Simulated keyboard input (`typeText()`, `pressKey()`, etc.) |
| `mockMouse` | Simulated mouse input |
| `renderOnce()` | Trigger a single render pass |
| `captureCharFrame()` | Capture the terminal output as a string |
| `captureSpans()` | Capture the frame as styled spans (`CapturedFrame`) |
| `resize(w, h)` | Simulate terminal resize |

**Example test:**
```tsx
import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"

test("input component", async () => {
  const { mockInput, captureCharFrame, renderOnce } =
    await testRender(<input focused placeholder="Type..." />, {
      width: 40,
      height: 10,
    })

  await renderOnce()
  expect(captureCharFrame()).toContain("Type...")

  mockInput.typeText("hello")
  await renderOnce()
  expect(captureCharFrame()).toContain("hello")
})
```

---

## React DevTools

OpenTUI React supports React DevTools for inspecting and debugging terminal applications.

**Setup:**

1. Install the optional peer dependencies:
```bash
bun add --dev react-devtools-core@7 ws
```

2. Start the standalone React DevTools:
```bash
npx react-devtools@7
```

3. Run your app with the `DEV` environment variable:
```bash
DEV=true bun run your-app.tsx
```

The component tree appears in React DevTools. You can inspect props and modify them in real-time -- changes are reflected immediately in the terminal.

**Note:** When DevTools is connected, the WebSocket connection may prevent your process from exiting naturally. The `devtools-polyfill.d.ts` provides a global polyfill required for the DevTools WebSocket connection.

---

## Examples

### Login Form

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useCallback, useState } from "react"

function App() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [focused, setFocused] = useState<"username" | "password">("username")
  const [status, setStatus] = useState("idle")

  useKeyboard((key) => {
    if (key.name === "tab") {
      setFocused((prev) => (prev === "username" ? "password" : "username"))
    }
  })

  const handleSubmit = useCallback(() => {
    if (username === "admin" && password === "secret") {
      setStatus("success")
    } else {
      setStatus("error")
    }
  }, [username, password])

  return (
    <box style={{ border: true, padding: 2, flexDirection: "column", gap: 1 }}>
      <text fg="#FFFF00">Login Form</text>

      <box title="Username" style={{ border: true, width: 40, height: 3 }}>
        <input
          placeholder="Enter username..."
          onInput={setUsername}
          onSubmit={handleSubmit}
          focused={focused === "username"}
        />
      </box>

      <box title="Password" style={{ border: true, width: 40, height: 3 }}>
        <input
          placeholder="Enter password..."
          onInput={setPassword}
          onSubmit={handleSubmit}
          focused={focused === "password"}
        />
      </box>

      <text style={{
        fg: status === "success" ? "green" : status === "error" ? "red" : "#999",
      }}>
        {status.toUpperCase()}
      </text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

### Counter with Timer

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { useEffect, useState } from "react"

function App() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setCount((p) => p + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <box title="Counter" style={{ padding: 2 }}>
      <text fg="#00FF00">{`Count: ${count}`}</text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

### System Monitor Animation

```tsx
import { createCliRenderer, TextAttributes } from "@opentui/core"
import { createRoot, useTimeline } from "@opentui/react"
import { useEffect, useState } from "react"

type Stats = { cpu: number; memory: number; network: number; disk: number }

function App() {
  const [stats, setStats] = useState<Stats>({
    cpu: 0, memory: 0, network: 0, disk: 0,
  })

  const timeline = useTimeline({ duration: 3000, loop: false })

  useEffect(() => {
    timeline.add(stats, {
      cpu: 85, memory: 70, network: 95, disk: 60,
      duration: 3000, ease: "linear",
      onUpdate: (values) => setStats({ ...values.targets[0] }),
    }, 0)
  }, [])

  const meters = [
    { name: "CPU", key: "cpu", color: "#6a5acd" },
    { name: "Memory", key: "memory", color: "#4682b4" },
    { name: "Network", key: "network", color: "#20b2aa" },
    { name: "Disk", key: "disk", color: "#daa520" },
  ]

  return (
    <box title="System Monitor" style={{
      margin: 1, padding: 1, border: true,
      borderStyle: "single", borderColor: "#4a4a4a",
    }}>
      {meters.map((m) => (
        <box key={m.key}>
          <box flexDirection="row" justifyContent="space-between">
            <text>{m.name}</text>
            <text attributes={TextAttributes.DIM}>
              {Math.round(stats[m.key as keyof Stats])}%
            </text>
          </box>
          <box style={{ backgroundColor: "#333333" }}>
            <box style={{
              width: `${stats[m.key as keyof Stats]}%`,
              height: 1,
              backgroundColor: m.color,
            }} />
          </box>
        </box>
      ))}
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

### Styled Text Showcase

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return (
    <>
      <text>Simple text</text>
      <text><strong>Bold text</strong></text>
      <text><u>Underlined text</u></text>
      <text><span fg="red">Red text</span></text>
      <text><span fg="blue">Blue text</span></text>
      <text><strong fg="red">Bold red text</strong></text>
      <text>
        <strong>Bold</strong> and <span fg="blue">blue</span> combined
      </text>
    </>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

---

## Comparison with @opentui/solid

Both `@opentui/react` and `@opentui/solid` target the same OpenTUI core renderable tree and share the same component set. The differences stem from the underlying framework:

| Aspect | React (`@opentui/react`) | Solid (`@opentui/solid`) |
|--------|--------------------------|--------------------------|
| **Rendering** | `createRoot(renderer).render(<App />)` | `render(() => <App />)` |
| **JSX Import** | `"jsxImportSource": "@opentui/react"` | `"jsxImportSource": "@opentui/solid"` |
| **JSX Transform** | `"jsx": "react-jsx"` | `"jsx": "preserve"` + Bun preload |
| **State** | `useState()` | `createSignal()` |
| **Effects** | `useEffect()` | `createEffect()` |
| **Memos** | `useMemo()` | `createMemo()` |
| **Context** | React Context API | Solid Context API |
| **Refs** | `useRef()` + `ref={ref}` | Direct `ref={el}` assignment |
| **Re-rendering** | Virtual DOM diffing (full component re-render) | Fine-grained reactivity (surgical updates) |
| **Keys** | Required for list items | Not required |
| **Reconciler** | `react-reconciler` (fiber-based) | Custom Solid.js renderer |
| **Hyphenated elements** | `<tab-select>`, `<ascii-font>` | `<tab_select>`, `<ascii_font>` (underscores) |
| **Portals** | `createPortal()` | `<Portal mount={...}>` |
| **Dynamic components** | Standard JSX + ternary | `<Dynamic component={...}>` |
| **Build plugin** | Not needed (React JSX works natively) | `@opentui/solid/bun-plugin` for production |
| **DevTools** | React DevTools support | No DevTools equivalent |
| **Dependencies** | `react`, `react-reconciler` | `solid-js` |
| **Peer React version** | `>=19.0.0` | N/A |

**When to choose React:** If your team already knows React, wants DevTools support, or needs to share code with React web/native projects.

**When to choose Solid:** If you want fine-grained reactivity (no unnecessary re-renders), smaller bundle size, or are building a performance-critical TUI where surgical DOM updates matter.

Both bindings produce the same terminal output for the same UI structure -- the choice is about developer experience and runtime characteristics.
