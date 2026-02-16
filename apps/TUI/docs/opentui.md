# OpenTUI + Solid.js Reference

This document is the canonical reference for the OpenTUI framework as used in our TUI.
It was derived directly from the `@opentui/core` and `@opentui/solid` source code
in `node_modules/`. Read this before writing any TUI component.

---

## Architecture

OpenTUI is a three-layer stack:

| Layer | Package | Role |
|---|---|---|
| Core | `@opentui/core` | Native renderer (Zig/Bun FFI), Yoga flexbox layout, renderables, keyboard/mouse/paste dispatch |
| Solid bindings | `@opentui/solid` | JSX reconciler, hooks (`useKeyboard`, `useRenderer`, ...), `render()` / `testRender()` |
| Our app | `apps/TUI/` | Context providers, routes, components, dialogs |

The Solid.js reconciler translates JSX into calls on OpenTUI renderable objects.
Layout is Yoga-based flexbox. Rendering happens on an internal buffer that is
flushed to the terminal at the configured FPS.

---

## JSX Elements

Every JSX tag maps to an OpenTUI renderable class via the component catalogue.

### Layout & Display

#### `<box>` &mdash; BoxRenderable

Container with optional border, flexbox layout, and background.

| Prop | Type | Notes |
|---|---|---|
| **Layout** | | |
| `flexDirection` | `"row"` \| `"column"` \| `"row-reverse"` \| `"column-reverse"` | |
| `alignItems` | `"flex-start"` \| `"center"` \| `"flex-end"` \| `"stretch"` \| `"baseline"` | |
| `justifyContent` | `"flex-start"` \| `"center"` \| `"flex-end"` \| `"space-between"` \| `"space-around"` \| `"space-evenly"` | |
| `flexGrow` | `number` | Default 0 |
| `flexShrink` | `number` | Default 1 |
| `flexBasis` | `number` \| `"auto"` \| `string%` | |
| `flexWrap` | `"nowrap"` \| `"wrap"` \| `"wrap-reverse"` | |
| `gap` | `number` | Shorthand for both axes |
| `rowGap` / `columnGap` | `number` | |
| **Sizing** | | |
| `width` / `height` | `number` \| `"auto"` \| `string%` | In terminal columns/rows |
| `minWidth` / `minHeight` | `number` \| `string%` | |
| `maxWidth` / `maxHeight` | `number` \| `string%` | |
| **Spacing** | | |
| `padding` | `number` | Shorthand for all sides |
| `paddingTop` / `paddingRight` / `paddingBottom` / `paddingLeft` | `number` | |
| `margin` | `number` | Shorthand |
| `marginTop` / `marginRight` / `marginBottom` / `marginLeft` | `number` | |
| **Position** | | |
| `position` | `"relative"` \| `"absolute"` | Default `"relative"` |
| `top` / `right` / `bottom` / `left` | `number` \| `"auto"` \| `string%` | For absolute positioning |
| `zIndex` | `number` | Stacking order |
| `overflow` | `"visible"` \| `"hidden"` \| `"scroll"` | |
| **Border** | | |
| `border` | `boolean` | Enable all borders |
| `borderTop` / `borderRight` / `borderBottom` / `borderLeft` | `boolean` | Individual sides |
| `borderStyle` | `"single"` \| `"double"` \| `"rounded"` \| `"bold"` \| `"classic"` \| ... | |
| `borderColor` | `string` (hex/name) | |
| `focusedBorderColor` | `string` | Active when focused |
| `title` | `string` | Text in top border |
| `titleAlignment` | `"left"` \| `"center"` \| `"right"` | |
| **Appearance** | | |
| `backgroundColor` | `string` | |
| `shouldFill` | `boolean` | Fill with background color |
| `visible` | `boolean` | |
| `opacity` | `number` (0-1) | |
| **Behavior** | | |
| `focused` | `boolean` | Receive keyboard events |
| `children` | `JSX.Element` | |
| `ref` | `Ref` | Access underlying renderable |
| **Events** | | |
| `onKeyDown` | `(e: KeyEvent) => void` | Via native setter (default case) |
| `onMouseDown` | `(e: MouseEvent) => void` | |
| `onMouseUp` / `onMouseMove` / `onMouseDrag` / `onMouseScroll` | `(e: MouseEvent) => void` | |

```tsx
<box flexDirection="column" width="100%" height="100%" padding={1} gap={2}>
  <box flexShrink={0} height={3} border borderStyle="rounded" borderColor="#555">
    <text fg="#fff">Header</text>
  </box>
  <box flexGrow={1}>
    <text>Content fills remaining space</text>
  </box>
</box>
```

#### `<text>` &mdash; TextRenderable

Styled text content. Accepts inline children for formatting.

| Prop | Type | Notes |
|---|---|---|
| `content` | `string` | Alternative to children |
| `fg` | `string` | Foreground/text color |
| `bg` | `string` | Background color |
| `attributes` | `number` | Bitmask: `BOLD \| ITALIC \| ...` |
| `wrapMode` | `"none"` \| `"char"` \| `"word"` | |
| `truncate` | `boolean` | Truncate overflow |
| `children` | `string \| number \| JSX.Element` | |

**Text modifier children** (must be inside `<text>`):

| Element | Effect |
|---|---|
| `<strong>` / `<b>` | **Bold** |
| `<em>` / `<i>` | *Italic* |
| `<u>` | Underline |
| `<span>` | Styled inline container (`fg`, `bg` props) |
| `<br />` | Line break |
| `<a href="...">` | Link (sets `link: { url }` on renderable) |

```tsx
<text fg={theme.text}>
  Hello <strong>world</strong> and <span fg="#ff0">yellow</span>
</text>
```

#### `<scrollbox>` &mdash; ScrollBoxRenderable

Scrollable container with scrollbars.

| Prop | Type | Notes |
|---|---|---|
| `stickyScroll` | `boolean` | Auto-scroll to new content |
| `stickyStart` | `"bottom"` \| `"top"` \| `"left"` \| `"right"` | Which edge to stick to |
| `scrollX` / `scrollY` | `boolean` | Enable axes |
| `maxHeight` | `number` | Useful for bounded scroll areas |
| `focused` | `boolean` | Receive keyboard scroll events |
| `viewportCulling` | `boolean` | Only render visible children |

Internally composed of: root `<box>` > wrapper > viewport (clips) > content + scrollbars.

```tsx
<scrollbox stickyScroll stickyStart="bottom" flexGrow={1}>
  <For each={messages()}>{(msg) => <MessageView msg={msg} />}</For>
</scrollbox>
```

#### `<ascii_font>` &mdash; ASCIIFontRenderable

Large ASCII art text.

| Prop | Type | Notes |
|---|---|---|
| `text` | `string` | Text to render |
| `font` | `"tiny"` \| `"small"` \| `"block"` \| `"slick"` \| `"shade"` \| ... | |
| `color` | `string \| string[]` | Single or per-row colors |
| `backgroundColor` | `string` | |
| `selectable` | `boolean` | |

```tsx
<ascii_font text="cowork" font="block" color={theme.text} />
```

### Input Elements

#### `<input>` &mdash; InputRenderable

Single-line text input. Extends TextareaRenderable.

| Prop | Type | Notes |
|---|---|---|
| `value` | `string` | Controlled value |
| `placeholder` | `string` | |
| `placeholderColor` | `string` | |
| `textColor` | `string` | |
| `maxLength` | `number` | |
| `focused` | `boolean` | **Required** to receive keyboard events |
| `onInput` | `(value: string) => void` | Every keystroke |
| `onChange` | `(value: string) => void` | Value committed |
| `onSubmit` | `(value: string) => void` | **Enter key pressed** |
| `onKeyDown` | `(e: KeyEvent) => void` | Via native setter |

**Reconciler wiring:**
- `onInput` &rarr; `InputRenderableEvents.INPUT`
- `onChange` &rarr; `InputRenderableEvents.CHANGE`
- `onSubmit` &rarr; `InputRenderableEvents.ENTER`

Enter fires `submit()` which emits the `ENTER` event. Newlines are stripped from input and paste.

```tsx
<input
  value={query()}
  onChange={(v) => setQuery(v)}
  onSubmit={handleSubmit}
  placeholder="Search..."
  focused
  flexGrow={1}
/>
```

#### `<textarea>` &mdash; TextareaRenderable

Multi-line text editor with undo/redo, key bindings, and cursor.

| Prop | Type | Notes |
|---|---|---|
| `initialValue` | `string` | |
| `placeholder` | `string` | |
| `focused` | `boolean` | |
| `onSubmit` | `() => void` | Submit action (configurable binding) |
| `onContentChange` | `(value: string) => void` | Text changed |
| `onCursorChange` | `(pos: { line, visualColumn }) => void` | Cursor moved |
| `onKeyDown` | `(e: KeyEvent) => void` | Runs before built-in `handleKeyPress` |
| `onKeyPress` | `(e: KeyEvent) => void` | |
| `keyBindings` | `KeyBinding[]` | Custom key bindings |
| `keyAliasMap` | `KeyAliasMap` | Key name aliases |

**Built-in actions:**
`move-left`, `move-right`, `move-up`, `move-down`,
`line-home`, `line-end`, `buffer-home`, `buffer-end`,
`backspace`, `delete`, `newline`, `undo`, `redo`,
`word-forward`, `word-backward`, `select-all`, `submit`,
`delete-line`, `delete-to-line-end`, `delete-to-line-start`,
`delete-word-forward`, `delete-word-backward`,
and all `select-*` variants.

#### `<select>` &mdash; SelectRenderable

Keyboard/mouse navigable list.

| Prop | Type | Notes |
|---|---|---|
| `options` | `SelectOption[]` | `{ name, description?, value? }` |
| `selectedIndex` | `number` | |
| `focused` | `boolean` | |
| `onChange` | `(index, option) => void` | Selection moved |
| `onSelect` | `(index, option) => void` | Item confirmed |
| `wrapSelection` | `boolean` | Wrap at edges |
| `showDescription` | `boolean` | |
| `showScrollIndicator` | `boolean` | |
| `itemSpacing` | `number` | |
| `fastScrollStep` | `number` | Ctrl+Up/Down step |

#### `<tab_select>` &mdash; TabSelectRenderable

Horizontal tab selector. Same event model as `<select>`.

| Prop | Type | Notes |
|---|---|---|
| `options` | `TabSelectOption[]` | `{ name, description?, value? }` |
| `tabWidth` | `number` | |
| `showScrollArrows` | `boolean` | |
| `showUnderline` | `boolean` | |

### Code & Content

#### `<code>` &mdash; CodeRenderable

Syntax-highlighted code display.

| Prop | Type | Notes |
|---|---|---|
| `content` | `string` | Source code |
| `filetype` | `string` | Language for highlighting |
| `syntaxStyle` | `SyntaxStyle` | Color scheme |
| `treeSitterClient` | `TreeSitterClient?` | Advanced parser |
| `conceal` | `boolean` | Hide markup |
| `streaming` | `boolean` | Support incomplete content |

#### `<markdown>` &mdash; MarkdownRenderable

| Prop | Type | Notes |
|---|---|---|
| `content` | `string` | Markdown source |
| `syntaxStyle` | `SyntaxStyle` | Color scheme |
| `conceal` | `boolean` | Hide markdown syntax |
| `streaming` | `boolean` | Support incomplete markdown |
| `renderNode` | `(token, ctx) => Renderable?` | Custom node renderer |

#### `<diff>` &mdash; DiffRenderable

Unified or split diff view.

| Prop | Type | Notes |
|---|---|---|
| `diff` | `string` | Unified diff content |
| `view` | `"unified"` \| `"split"` | Display mode |
| `filetype` | `string` | Language |
| `showLineNumbers` | `boolean` | |
| `addedBg` / `removedBg` / `contextBg` | `string` | Line colors |

#### `<line_number>` &mdash; LineNumberRenderable

Line number gutter, pairs with a `<code>` or `<textarea>` target.

#### `<progress_bar>` &mdash; SliderRenderable

Range slider (horizontal or vertical).

---

## Hooks

### `useKeyboard(callback, options?)`

Subscribe to **global** keyboard events. Fires before focused-element handlers.

```typescript
useKeyboard((e: KeyEvent) => {
  if (e.repeated) return;          // Skip key repeats
  if (e.defaultPrevented) return;  // Skip already-handled events
  const key = e.name;              // "a", "return", "escape", "up", etc.
  const { ctrl, shift, meta } = e;
  // ...
  e.preventDefault();              // Blocks focused-element handlers
}, { release: false });            // Set true to also get key release events
```

**CRITICAL:** Calling `e.preventDefault()` in a `useKeyboard` callback **blocks the focused element from receiving the event at all** &mdash; including built-in input handling (`handleKeyPress`), submit, etc. Only prevent keys you actually handle.

### `useRenderer()`

Access the `CliRenderer` instance.

```typescript
const renderer = useRenderer();
renderer.width;   // Terminal columns
renderer.height;  // Terminal rows
renderer.root;    // Root renderable
```

### `useTerminalDimensions()`

Reactive terminal size.

```typescript
const dims = useTerminalDimensions();
// dims().width, dims().height
```

### `onResize(callback)`

```typescript
onResize((width: number, height: number) => { ... });
```

### `usePaste(callback)`

```typescript
usePaste((event: PasteEvent) => {
  console.log(event.text);
});
```

### `useSelectionHandler(callback)`

```typescript
useSelectionHandler((selection) => { ... });
```

### `useTimeline(options?)`

Animation timeline. Returns a `Timeline` instance.

```typescript
const tl = useTimeline({ autoplay: true });
tl.pause(); tl.play();
```

---

## Event System

### Keyboard Event Flow

```
Raw terminal input
  -> KeyHandler.processInput()
  -> emit("keypress", new KeyEvent(...))
     |
     1. Global listeners (useKeyboard callbacks) run in registration order
        - If any calls stopPropagation(), remaining globals + renderables skipped
     |
     2. defaultPrevented gate
        - If any global listener called preventDefault(), renderable handlers SKIPPED
     |
     3. Focused element's keypressHandler runs:
        a. _keyListeners["down"]?.(key)    // <-- onKeyDown handler
        b. if (!key.defaultPrevented)
             this.handleKeyPress(key)      // <-- built-in behavior (input, submit, cursor)
```

**Implications:**
- `useKeyboard` runs BEFORE any element's `onKeyDown` or `onSubmit`.
- `preventDefault()` in `useKeyboard` prevents the focused element from seeing the event entirely.
- `onKeyDown` on a focused element runs BEFORE built-in `handleKeyPress`. If `onKeyDown` calls `preventDefault()`, built-in behavior (like `submit()`) is skipped.
- The built-in `submit()` on InputRenderable is what emits `InputRenderableEvents.ENTER` (which fires `onSubmit`).

### KeyEvent Properties

| Property | Type | Notes |
|---|---|---|
| `name` | `string` | Normalized key name: `"return"`, `"escape"`, `"up"`, `"a"`, etc. |
| `ctrl` | `boolean` | Ctrl modifier |
| `shift` | `boolean` | Shift modifier |
| `meta` | `boolean` | Meta/Cmd modifier |
| `option` | `boolean` | Option/Alt modifier |
| `super` | `boolean` | Super/Win modifier |
| `hyper` | `boolean` | Hyper modifier |
| `sequence` | `string` | Raw escape sequence |
| `code` | `string?` | Key code |
| `repeated` | `boolean` | Key repeat (held down) |
| `source` | `"raw"` \| `"kitty"` | Input protocol |
| `defaultPrevented` | `boolean` | (getter) |
| `propagationStopped` | `boolean` | (getter) |

**Key name note:** OpenTUI uses `"return"` internally for Enter. Always normalize with `keyNameFromEvent(e)` from `apps/TUI/util/keyboard.ts` which maps `"return"` &rarr; `"enter"`.

### MouseEvent Properties

| Property | Type | Notes |
|---|---|---|
| `type` | `MouseEventType` | `"down"`, `"up"`, `"move"`, `"scroll"`, ... |
| `button` | `number` | 0=left, 1=middle, 2=right, 4=wheelUp, 5=wheelDown |
| `x` / `y` | `number` | Screen coordinates |
| `target` | `Renderable?` | Hit-tested target |
| `modifiers` | `{ shift, alt, ctrl }` | |
| `scroll` | `ScrollInfo?` | Scroll data |
| `isDragging` | `boolean?` | |

Mouse handlers on elements: `onMouseDown`, `onMouseUp`, `onMouseMove`, `onMouseDrag`, `onMouseDragEnd`, `onMouseDrop`, `onMouseOver`, `onMouseOut`, `onMouseScroll`.

---

## Reconciler Property Handling

When a JSX prop is set on an element, the Solid reconciler's `setProperty()` processes it:

| Prop pattern | Handling |
|---|---|
| `on:eventName` | `node.on(eventName, handler)` &mdash; custom EventEmitter event |
| `focused` | `node.focus()` / `node.blur()` |
| `onChange` | Wired to element-specific change event (Input: `CHANGE`, Select: `SELECTION_CHANGED`) |
| `onInput` | `InputRenderable` only &rarr; `InputRenderableEvents.INPUT` |
| `onSubmit` | `InputRenderable` &rarr; `InputRenderableEvents.ENTER`; other elements: `node.onSubmit = value` |
| `onSelect` | `SelectRenderable` / `TabSelectRenderable` &rarr; `ITEM_SELECTED` |
| `style` | Iterates object keys, sets each as `node[key] = val` |
| `text` / `content` | Converts to string, sets on node |
| `id` | `node.id = value` |
| **everything else** | `node[name] = value` (default case) |

The **default case** is how `onKeyDown`, `onMouseDown`, `backgroundColor`, `border`, etc. work &mdash; they fall through to `node[name] = value` and rely on native getters/setters on the renderable class. For example, `Renderable` has `set onKeyDown(handler)` which stores it in `_keyListeners["down"]`.

---

## Focus System

- Only ONE renderable can be focused at a time.
- Set via the `focused` JSX prop (triggers `node.focus()`) or programmatically.
- When focused, a `keypressHandler` is registered on `_internalKeyInput` that:
  1. Calls `onKeyDown` (if set)
  2. If `!defaultPrevented`, calls `handleKeyPress()` (built-in key behavior)
- When blurred, the handler is unregistered.
- `"focused"` and `"blurred"` events are emitted on the renderable.

---

## Renderer Configuration

```typescript
interface CliRendererConfig {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  exitOnCtrlC?: boolean;
  exitSignals?: NodeJS.Signals[];
  targetFps?: number;
  maxFps?: number;
  useMouse?: boolean;
  enableMouseMovement?: boolean;
  autoFocus?: boolean;
  useAlternateScreen?: boolean;
  useConsole?: boolean;
  backgroundColor?: string;
  useKittyKeyboard?: KittyKeyboardOptions | null;
  onDestroy?: () => void;
  // ... more advanced options
}
```

Kitty keyboard protocol provides precise key events (disambiguated escape codes, press/release):

```typescript
interface KittyKeyboardOptions {
  disambiguate?: boolean;   // Fix ESC timing, alt+key ambiguity
  alternateKeys?: boolean;  // Report numpad, shifted, base layout keys
  events?: boolean;         // Report press/repeat/release
  allKeysAsEscapes?: boolean;
  reportText?: boolean;
}
```

---

## Test Harness

```typescript
import { testRender } from "@opentui/solid";

const setup = await testRender(() => <MyComponent />, { width: 80, height: 24 });

// Simulate input
await setup.mockInput.type("hello");
await setup.mockInput.press("enter");

// Capture output
await setup.renderOnce();
const frame = setup.captureCharFrame(); // string snapshot

// Resize
setup.resize(120, 40);
```

Returns: `{ renderer, mockInput, mockMouse, renderOnce, captureCharFrame, captureSpans, resize }`

---

## Color System

Colors are accepted as strings everywhere:

| Format | Example |
|---|---|
| Hex (3/6 digit) | `"#f00"`, `"#FF0000"` |
| Named | `"red"`, `"blue"`, `"green"`, `"yellow"`, ... |
| RGB | Via `RGBA` class internally |

Our TUI uses semantic theme colors from `useTheme()`:
`theme.background`, `theme.text`, `theme.textMuted`, `theme.border`, `theme.borderActive`,
`theme.accent`, `theme.success`, `theme.error`, `theme.warning`, etc.

---

## Special Components

### `<Portal mount={renderable}>`

Render children into an alternate parent (outside the current component tree).
Useful for modals and overlays. Default mount: `renderer.root`.

### `<Dynamic component={tagOrFn}>`

Dynamically render an element by tag name string or component function.

```tsx
<Dynamic component={isMultiline() ? "textarea" : "input"} value={val()} />
```

### `extend(catalogue)`

Register custom renderables as JSX elements:

```typescript
import { extend } from "@opentui/solid";
extend({ myWidget: MyWidgetRenderable });
// Now <myWidget ... /> works in JSX
```

---

## Text Attributes Bitmask

```typescript
const TextAttributes = {
  NONE:          0,
  BOLD:          1,
  DIM:           2,
  ITALIC:        4,
  UNDERLINE:     8,
  BLINK:        16,
  INVERSE:      32,
  HIDDEN:       64,
  STRIKETHROUGH: 128,
};
```

Used with `<text attributes={TextAttributes.BOLD | TextAttributes.ITALIC}>`.

---

## Layout Quick Reference

OpenTUI uses **Yoga** (Facebook's flexbox engine). Think CSS flexbox but in terminal characters.

```
<box flexDirection="column" width="100%" height="100%">

  ┌─ header: flexShrink={0} height={3} ─────────────────┐
  │ Fixed-height header                                   │
  └───────────────────────────────────────────────────────┘

  ┌─ body: flexGrow={1} flexDirection="row" gap={1} ─────┐
  │ ┌─ sidebar ──┐ ┌─ main ───────────────────────────┐  │
  │ │ width={20}  │ │ flexGrow={1}                     │  │
  │ │ flexShrink  │ │                                  │  │
  │ │ ={0}        │ │                                  │  │
  │ └─────────────┘ └──────────────────────────────────┘  │
  └───────────────────────────────────────────────────────┘

  ┌─ footer: flexShrink={0} height={1} ──────────────────┐
  │ Fixed-height footer                                   │
  └───────────────────────────────────────────────────────┘

</box>
```

**Absolute positioning** for overlays:

```tsx
<box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={100}>
  {/* Covers entire screen */}
</box>
```

---

## Common Patterns in Our TUI

### Dialog overlay

```tsx
<box position="absolute" left={0} top={0} width="100%" height="100%"
     zIndex={100} justifyContent="center" alignItems="center">
  {/* Backdrop */}
  <box position="absolute" left={0} top={0} width="100%" height="100%"
       backgroundColor={theme.background} onMouseDown={dismiss} />
  {/* Content */}
  <box border borderStyle="rounded" borderColor={theme.border}
       backgroundColor={theme.backgroundPanel} padding={1} width="60%" zIndex={101}>
    {children}
  </box>
</box>
```

### Input with focused + onSubmit

```tsx
<input
  value={query()}
  onChange={(v) => setQuery(typeof v === "string" ? v : v?.value ?? "")}
  onKeyDown={handleKeyDown}
  onSubmit={handleSubmit}
  placeholder="Search..."
  focused
  flexGrow={1}
/>
```

### Scrollable message feed

```tsx
<scrollbox stickyScroll stickyStart="bottom" maxHeight={termHeight - 6}>
  <For each={messages()}>
    {(msg) => <MessageView message={msg} />}
  </For>
</scrollbox>
```

### Theme-aware component

```tsx
function MyComponent() {
  const theme = useTheme();
  return (
    <box backgroundColor={theme.backgroundPanel} border borderColor={theme.border}>
      <text fg={theme.text}>Hello</text>
    </box>
  );
}
```
