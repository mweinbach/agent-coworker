# Types Reference

All shared types, interfaces, enums, and constants exported by `@opentui/core`.

## Table of Contents

- [Text Attributes](#text-attributes)
  - [TextAttributes Constant](#textattributes-constant)
  - [Attribute Bit Manipulation](#attribute-bit-manipulation)
  - [createTextAttributes()](#createtextattributes)
  - [attributesWithLink()](#attributeswithlink)
  - [getLinkId()](#getlinkid)
- [Cursor Types](#cursor-types)
  - [CursorStyle](#cursorstyle)
  - [CursorStyleOptions](#cursorstyleoptions)
  - [CursorState](#cursorstate)
  - [VisualCursor](#visualcursor)
  - [LogicalCursor](#logicalcursor)
- [Mouse Types](#mouse-types)
  - [MousePointerStyle](#mousepointerstyle)
  - [MouseEvent](#mouseevent)
  - [MouseButton](#mousebutton)
- [Theme & Display](#theme--display)
  - [ThemeMode](#thememode)
  - [WidthMethod](#widthmethod)
  - [DebugOverlayCorner](#debugoverlaycorner)
- [Renderer Interfaces](#renderer-interfaces)
  - [RenderContext](#rendercontext)
  - [RendererEvents](#rendererevents)
  - [RendererControlState](#renderercontrolstate)
  - [PixelResolution](#pixelresolution)
- [Renderable Types](#renderable-types)
  - [LayoutEvents](#layoutevents)
  - [RenderableEvents](#renderableevents)
  - [Position](#position)
  - [BaseRenderableOptions](#baserenderableoptions)
  - [LayoutOptions](#layoutoptions)
  - [RenderableOptions](#renderableoptions)
  - [RenderCommand](#rendercommand)
- [Buffer & Frame Types](#buffer--frame-types)
  - [ViewportBounds](#viewportbounds)
  - [Viewport](#viewport)
  - [CapturedSpan](#capturedspan)
  - [CapturedLine](#capturedline)
  - [CapturedFrame](#capturedframe)
- [Text Types](#text-types)
  - [Highlight](#highlight)
  - [LineInfo](#lineinfo)
  - [LineInfoProvider](#lineinfoprovider)
- [Yoga Layout String Types](#yoga-layout-string-types)
  - [AlignString](#alignstring)
  - [FlexDirectionString](#flexdirectionstring)
  - [JustifyString](#justifystring)
  - [PositionTypeString](#positiontypestring)
  - [OverflowString](#overflowstring)
  - [WrapString](#wrapstring)
  - [Other Yoga Types](#other-yoga-types)
  - [Yoga Parse Functions](#yoga-parse-functions)
- [Utility Types](#utility-types)

---

## Text Attributes

### TextAttributes Constant

Bitmask constants for text styling. Combine with bitwise OR.

```typescript
declare const TextAttributes: {
  NONE: number           // 0
  BOLD: number           // 1
  DIM: number            // 2
  ITALIC: number         // 4
  UNDERLINE: number      // 8
  BLINK: number          // 16
  INVERSE: number        // 32
  HIDDEN: number         // 64
  STRIKETHROUGH: number  // 128
}
```

Usage:

```typescript
const attrs = TextAttributes.BOLD | TextAttributes.ITALIC
buffer.drawText("Bold italic", 0, 0, fg, bg, attrs)
```

### Attribute Bit Manipulation

```typescript
declare const ATTRIBUTE_BASE_BITS: 8
declare const ATTRIBUTE_BASE_MASK: 255
```

The lower 8 bits of a `u32` attribute value store the standard text attributes listed above. The upper bits can store additional data such as hyperlink IDs.

```typescript
/**
 * Extract the base 8 bits of attributes from a u32 attribute value.
 */
declare function getBaseAttributes(attr: number): number
```

### createTextAttributes()

Convenience function to create a bitmask from named boolean flags.

```typescript
declare function createTextAttributes(options?: {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  blink?: boolean
  inverse?: boolean
  hidden?: boolean
  strikethrough?: boolean
}): number
```

**Example:**

```typescript
const attrs = createTextAttributes({ bold: true, underline: true })
// equivalent to: TextAttributes.BOLD | TextAttributes.UNDERLINE
```

### attributesWithLink()

Encodes a hyperlink ID into the upper bits of an attribute value.

```typescript
declare function attributesWithLink(baseAttributes: number, linkId: number): number
```

### getLinkId()

Extracts the hyperlink ID from an attribute value.

```typescript
declare function getLinkId(attributes: number): number
```

---

## Cursor Types

### CursorStyle

```typescript
type CursorStyle = "block" | "line" | "underline"
```

### CursorStyleOptions

Configuration for the terminal cursor appearance.

```typescript
interface CursorStyleOptions {
  style?: CursorStyle
  blinking?: boolean
  color?: RGBA
  cursor?: MousePointerStyle
}
```

### CursorState

Full cursor state as returned by `CliRenderer.getCursorState()`.

```typescript
interface CursorState {
  x: number
  y: number
  visible: boolean
  style: CursorStyle
  blinking: boolean
  color: RGBA
}
```

### VisualCursor

Cursor position with both viewport-relative visual coordinates and document-absolute logical coordinates. Used by `EditorView`.

```typescript
interface VisualCursor {
  visualRow: number    // Row within visible viewport (0 = first visible line)
  visualCol: number    // Column within visible viewport
  logicalRow: number   // Absolute row in document
  logicalCol: number   // Absolute column in document
  offset: number       // Byte offset in underlying text buffer
}
```

### LogicalCursor

Document-absolute cursor position. Used by `EditBuffer`.

```typescript
interface LogicalCursor {
  row: number
  col: number
  offset: number
}
```

---

## Mouse Types

### MousePointerStyle

```typescript
type MousePointerStyle = "default" | "pointer" | "text" | "crosshair" | "move" | "not-allowed"
```

### MouseEvent

See [Core API Reference](./core-api.md#mouseevent) for the full `MouseEvent` class documentation.

### MouseButton

```typescript
enum MouseButton {
  LEFT = 0,
  MIDDLE = 1,
  RIGHT = 2,
  WHEEL_UP = 4,
  WHEEL_DOWN = 5,
}
```

---

## Theme & Display

### ThemeMode

```typescript
type ThemeMode = "dark" | "light"
```

Detected from the terminal's reported background color.

### WidthMethod

```typescript
type WidthMethod = "wcwidth" | "unicode"
```

Controls how character widths are calculated:
- `"wcwidth"` -- Uses the classic wcwidth algorithm (POSIX-compatible).
- `"unicode"` -- Uses Unicode character width tables (more accurate for modern terminals).

### DebugOverlayCorner

```typescript
enum DebugOverlayCorner {
  topLeft = 0,
  topRight = 1,
  bottomLeft = 2,
  bottomRight = 3,
}
```

---

## Renderer Interfaces

### RenderContext

The interface that the `CliRenderer` implements. Passed to every `Renderable` constructor as `ctx`. This is the contract between renderables and the renderer.

```typescript
interface RenderContext extends EventEmitter {
  // --- Dimensions ---
  width: number
  height: number

  // --- Rendering ---
  requestRender(): void
  widthMethod: WidthMethod
  capabilities: any | null

  // --- Live Rendering ---
  requestLive(): void
  dropLive(): void

  // --- Cursor ---
  setCursorPosition(x: number, y: number, visible: boolean): void
  setCursorStyle(options: CursorStyleOptions): void
  setCursorColor(color: RGBA): void
  setMousePointer(shape: MousePointerStyle): void

  // --- Focus ---
  currentFocusedRenderable: Renderable | null
  focusRenderable(renderable: Renderable): void

  // --- Lifecycle Passes ---
  registerLifecyclePass(renderable: Renderable): void
  unregisterLifecyclePass(renderable: Renderable): void
  getLifecyclePasses(): Set<Renderable>

  // --- Input ---
  keyInput: KeyHandler
  _internalKeyInput: InternalKeyHandler

  // --- Hit Grid ---
  addToHitGrid(x: number, y: number, width: number, height: number, id: number): void
  pushHitGridScissorRect(x: number, y: number, width: number, height: number): void
  popHitGridScissorRect(): void
  clearHitGridScissorRects(): void

  // --- Selection ---
  hasSelection: boolean
  getSelection(): Selection | null
  requestSelectionUpdate(): void
  clearSelection(): void
  startSelection(renderable: Renderable, x: number, y: number): void
  updateSelection(
    currentRenderable: Renderable | undefined,
    x: number, y: number,
    options?: { finishDragging?: boolean }
  ): void
}
```

### RendererEvents

Event signatures for the renderer's EventEmitter.

```typescript
interface RendererEvents {
  resize: (width: number, height: number) => void
  key: (data: Buffer) => void
  "memory:snapshot": (snapshot: {
    heapUsed: number
    heapTotal: number
    arrayBuffers: number
  }) => void
  selection: (selection: Selection) => void
  "debugOverlay:toggle": (enabled: boolean) => void
  theme_mode: (mode: ThemeMode) => void
}
```

### RendererControlState

```typescript
enum RendererControlState {
  IDLE = "idle"
  AUTO_STARTED = "auto_started"
  EXPLICIT_STARTED = "explicit_started"
  EXPLICIT_PAUSED = "explicit_paused"
  EXPLICIT_SUSPENDED = "explicit_suspended"
  EXPLICIT_STOPPED = "explicit_stopped"
}
```

### PixelResolution

Physical pixel size of the terminal window (if detectable).

```typescript
type PixelResolution = {
  width: number
  height: number
}
```

---

## Renderable Types

### LayoutEvents

```typescript
enum LayoutEvents {
  LAYOUT_CHANGED = "layout-changed"
  ADDED = "added"
  REMOVED = "removed"
  RESIZED = "resized"
}
```

### RenderableEvents

```typescript
enum RenderableEvents {
  FOCUSED = "focused"
  BLURRED = "blurred"
}
```

### Position

```typescript
interface Position {
  top?: number | "auto" | `${number}%`
  right?: number | "auto" | `${number}%`
  bottom?: number | "auto" | `${number}%`
  left?: number | "auto" | `${number}%`
}
```

### BaseRenderableOptions

```typescript
interface BaseRenderableOptions {
  id?: string
}
```

### LayoutOptions

Full layout configuration. See [Core API Reference](./core-api.md#layout-properties) for the complete listing.

```typescript
interface LayoutOptions extends BaseRenderableOptions {
  flexGrow?: number
  flexShrink?: number
  flexDirection?: FlexDirectionString
  flexWrap?: WrapString
  alignItems?: AlignString
  justifyContent?: JustifyString
  alignSelf?: AlignString
  flexBasis?: number | "auto" | undefined
  position?: PositionTypeString
  overflow?: OverflowString
  top?: number | "auto" | `${number}%`
  right?: number | "auto" | `${number}%`
  bottom?: number | "auto" | `${number}%`
  left?: number | "auto" | `${number}%`
  minWidth?: number | "auto" | `${number}%`
  minHeight?: number | "auto" | `${number}%`
  maxWidth?: number | "auto" | `${number}%`
  maxHeight?: number | "auto" | `${number}%`
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
  enableLayout?: boolean
}
```

### RenderableOptions

See [Core API Reference](./core-api.md#renderableoptions) for the full `RenderableOptions` interface.

### RenderCommand

Internal union type used by the render pipeline to build a flat, ordered list of render operations.

```typescript
type RenderCommand =
  | { action: "render"; renderable: Renderable }
  | { action: "pushScissorRect"; x: number; y: number; width: number; height: number; screenX: number; screenY: number }
  | { action: "popScissorRect" }
  | { action: "pushOpacity"; opacity: number }
  | { action: "popOpacity" }
```

---

## Buffer & Frame Types

### ViewportBounds

```typescript
interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}
```

### Viewport

Used by `EditorView` to describe the visible area.

```typescript
interface Viewport {
  offsetY: number
  offsetX: number
  height: number
  width: number
}
```

### CapturedSpan

A single styled span within a captured line.

```typescript
interface CapturedSpan {
  text: string
  fg: RGBA
  bg: RGBA
  attributes: number
  width: number
}
```

### CapturedLine

```typescript
interface CapturedLine {
  spans: CapturedSpan[]
}
```

### CapturedFrame

A complete snapshot of the rendered terminal frame. Useful for testing.

```typescript
interface CapturedFrame {
  cols: number
  rows: number
  cursor: [number, number]
  lines: CapturedLine[]
}
```

---

## Text Types

### Highlight

Represents a highlighted range within a text buffer.

```typescript
interface Highlight {
  start: number           // Start offset (character position)
  end: number             // End offset (character position)
  styleId: number         // ID of the syntax style to apply
  priority?: number | null // Priority for overlapping highlights
  hlRef?: number | null   // Reference ID for removal via removeHighlightsByRef
}
```

### LineInfo

Metadata about wrapped lines in a text buffer view.

```typescript
interface LineInfo {
  lineStarts: number[]    // Byte offsets where each visual line starts
  lineWidths: number[]    // Display width of each visual line
  maxLineWidth: number    // Width of the widest visual line
  lineSources: number[]   // Logical source line index for each visual line
  lineWraps: number[]     // Whether each visual line is a wrap continuation
}
```

### LineInfoProvider

Interface for objects that provide line information.

```typescript
interface LineInfoProvider {
  get lineInfo(): LineInfo
  get lineCount(): number
  get virtualLineCount(): number
  get scrollY(): number
}
```

---

## Yoga Layout String Types

These string literal types map to the Yoga layout engine's enum values. The `lib/yoga.options` module provides parse functions to convert them.

### AlignString

```typescript
type AlignString = "auto" | "flex-start" | "center" | "flex-end" | "stretch"
  | "baseline" | "space-between" | "space-around" | "space-evenly"
```

### FlexDirectionString

```typescript
type FlexDirectionString = "column" | "column-reverse" | "row" | "row-reverse"
```

### JustifyString

```typescript
type JustifyString = "flex-start" | "center" | "flex-end"
  | "space-between" | "space-around" | "space-evenly"
```

### PositionTypeString

```typescript
type PositionTypeString = "static" | "relative" | "absolute"
```

### OverflowString

```typescript
type OverflowString = "visible" | "hidden" | "scroll"
```

### WrapString

```typescript
type WrapString = "no-wrap" | "wrap" | "wrap-reverse"
```

### Other Yoga Types

```typescript
type BoxSizingString = "border-box" | "content-box"
type DimensionString = "width" | "height"
type DirectionString = "inherit" | "ltr" | "rtl"
type DisplayString = "flex" | "none" | "contents"
type EdgeString = "left" | "top" | "right" | "bottom" | "start" | "end" | "horizontal" | "vertical" | "all"
type GutterString = "column" | "row" | "all"
type LogLevelString = "error" | "warn" | "info" | "debug" | "verbose" | "fatal"
type MeasureModeString = "undefined" | "exactly" | "at-most"
type UnitString = "undefined" | "point" | "percent" | "auto"
```

### Yoga Parse Functions

These convert string values to Yoga enum constants. They accept `string | null | undefined` and return the corresponding Yoga enum value.

```typescript
declare function parseAlign(value: string | null | undefined): Align
declare function parseAlignItems(value: string | null | undefined): Align
declare function parseBoxSizing(value: string): BoxSizing
declare function parseDimension(value: string): Dimension
declare function parseDirection(value: string): Direction
declare function parseDisplay(value: string): Display
declare function parseEdge(value: string): Edge
declare function parseFlexDirection(value: string | null | undefined): FlexDirection
declare function parseGutter(value: string): Gutter
declare function parseJustify(value: string | null | undefined): Justify
declare function parseLogLevel(value: string): LogLevel
declare function parseMeasureMode(value: string): MeasureMode
declare function parseOverflow(value: string | null | undefined): Overflow
declare function parsePositionType(value: string | null | undefined): PositionType
declare function parseUnit(value: string): Unit
declare function parseWrap(value: string | null | undefined): Wrap
```

---

## Utility Types

### Timeout

```typescript
type Timeout = ReturnType<typeof setTimeout> | undefined
```

### isRenderable()

Type guard to check if an object is a `Renderable`.

```typescript
declare function isRenderable(obj: any): obj is Renderable
```

### visualizeRenderableTree()

Debug utility that prints the renderable tree to the console.

```typescript
declare function visualizeRenderableTree(renderable: Renderable, maxDepth?: number): void
```

---

## Related Documentation

- [Core API Reference](./core-api.md) -- Architecture overview and main concepts
- [Renderer Reference](./renderer.md) -- Renderer pipeline and native layer
- [Buffer Reference](./buffer.md) -- Buffer, edit buffer, and text buffer systems
- [ANSI & Utilities Reference](./ansi-utils.md) -- ANSI codes, console, filters, utilities
