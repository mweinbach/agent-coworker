# Core API Reference

The `@opentui/core` package is the foundation of OpenTUI, a TypeScript framework for building terminal user interfaces. It provides a high-performance rendering pipeline backed by native Zig code, a Yoga-based flexbox layout system, and a composable tree of `Renderable` objects.

**Version:** 0.1.80
**Runtime:** Bun (uses `bun:ffi` for native interop)
**License:** MIT

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
- [Package Exports](#package-exports)
- [Core Concepts](#core-concepts)
  - [Renderer](#renderer)
  - [Renderable Lifecycle](#renderable-lifecycle)
  - [Layout System (Yoga)](#layout-system-yoga)
  - [Rendering Pipeline](#rendering-pipeline)
  - [Native Layer (Zig)](#native-layer-zig)
- [Renderer](#renderer-1)
  - [createCliRenderer()](#createclirenderer)
  - [CliRendererConfig](#clirendererconfig)
  - [CliRenderer Class](#clirenderer-class)
  - [Renderer Events](#renderer-events)
  - [Renderer Control States](#renderer-control-states)
- [Renderable Base Classes](#renderable-base-classes)
  - [BaseRenderable](#baserenderable)
  - [Renderable](#renderable)
  - [RootRenderable](#rootrenderable)
  - [RenderableOptions](#renderableoptions)
  - [Layout Properties](#layout-properties)
  - [Creating a Custom Renderable](#creating-a-custom-renderable)
- [Input Handling](#input-handling)
  - [KeyEvent](#keyevent)
  - [MouseEvent](#mouseevent)
  - [PasteEvent](#pasteevent)
  - [Kitty Keyboard Protocol](#kitty-keyboard-protocol)
- [Selection System](#selection-system)
- [Post-Processing Filters](#post-processing-filters)
- [Animation System](#animation-system)
- [Related Documentation](#related-documentation)

## Architecture Overview

```
                   CliRenderer
                       |
              +--------+--------+
              |                 |
        RootRenderable     OptimizedBuffer (double-buffered)
              |                 |
    Renderable Tree        Native Zig Lib (bun:ffi)
         (Yoga layout)         |
              |            Terminal Output
              v                 |
        renderSelf() -----> buffer.drawText / setCell / fillRect
```

The renderer maintains a tree of `Renderable` nodes. Each frame:

1. **Layout pass** -- Yoga calculates positions and sizes for the tree.
2. **Update pass** -- Each renderable runs `onUpdate(deltaTime)`.
3. **Render pass** -- The tree is walked in z-index order. Each renderable writes to the `OptimizedBuffer` via `renderSelf()`.
4. **Post-process pass** -- Optional filter functions transform the buffer (scanlines, blur, etc.).
5. **Native diff + output** -- The Zig layer diffs the current buffer against the previous frame and writes only the changed cells to stdout.

## Quick Start

```typescript
import { createCliRenderer, TextRenderable } from "@opentui/core"

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: true,
  backgroundColor: "#1e1e2e",
})

const text = new TextRenderable(renderer, {
  id: "hello",
  content: "Hello, OpenTUI!",
})

renderer.root.add(text)
```

## Package Exports

| Export Path | Description |
|---|---|
| `@opentui/core` | Main entry -- renderer, renderables, buffer, types |
| `@opentui/core/3d` | 3D rendering, physics, WebGPU integration |
| `@opentui/core/testing` | Test utilities, `TestRenderer`, snapshot helpers |
| `@opentui/core/parser.worker` | Tree-sitter parser worker for syntax highlighting |

## Core Concepts

### Renderer

The `CliRenderer` owns the render loop, terminal setup/teardown, input handling, and the root renderable. There is typically one renderer per application. It is created asynchronously with `createCliRenderer()` because it loads the native Zig library.

### Renderable Lifecycle

Every UI element is a `Renderable`. The lifecycle is:

1. **Construction** -- A `Renderable` receives a `RenderContext` and `RenderableOptions`. A Yoga node is created for layout.
2. **Attachment** -- `parent.add(child)` attaches the renderable to the tree and the Yoga layout.
3. **Layout** -- On each frame, `updateLayout()` walks the tree, calls `updateFromLayout()` to sync Yoga-computed positions, and builds a flat render list sorted by z-index and scissor rects.
4. **Rendering** -- `renderSelf(buffer, deltaTime)` is called for visible renderables. Override this to draw content.
5. **Destruction** -- `destroy()` removes the renderable from its parent and frees the Yoga node. `destroyRecursively()` also destroys all children.

### Layout System (Yoga)

OpenTUI uses [Yoga](https://yogalayout.dev/) for CSS Flexbox-compatible layout. Every `Renderable` has an associated `YogaNode`. Layout properties (flexDirection, padding, margin, etc.) are set as properties on the renderable and forwarded to Yoga.

String-based layout enums are used throughout the API (e.g., `"row"`, `"center"`, `"absolute"`) and parsed into Yoga constants internally via the `lib/yoga.options` module. See [Types Reference](./types.md) for all layout type aliases.

### Rendering Pipeline

OpenTUI uses double-buffered rendering. The `CliRenderer` holds two `OptimizedBuffer` instances (`nextRenderBuffer` and `currentRenderBuffer`). Each frame renders into the next buffer, then the native Zig layer diffs the two buffers and writes minimal ANSI escape sequences to stdout.

The buffer supports:
- Cell-level text and color operations
- Scissor rects (clipping regions) via a stack
- Opacity via a stack
- Alpha blending
- Box/border drawing
- TextBuffer and EditorView rendering (native text layout)

### Native Layer (Zig)

The `RenderLib` interface (see [Renderer Reference](./renderer.md)) defines all FFI bindings to the Zig native code. This includes buffer operations, renderer management, text buffer manipulation, edit buffer operations, hit grid management, and clipboard access. The native library is loaded at startup via `resolveRenderLib()` which finds the platform-specific binary.

## Renderer

### createCliRenderer()

```typescript
declare function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>
```

Factory function that initializes the native library, creates the renderer pointer, and returns a fully configured `CliRenderer`. This is the primary entry point for any OpenTUI application.

### CliRendererConfig

```typescript
interface CliRendererConfig {
  stdin?: NodeJS.ReadStream           // Default: process.stdin
  stdout?: NodeJS.WriteStream         // Default: process.stdout
  remote?: boolean                    // Remote rendering mode
  exitOnCtrlC?: boolean               // Exit process on Ctrl+C
  exitSignals?: NodeJS.Signals[]      // Additional exit signals to handle
  debounceDelay?: number              // Resize debounce delay (ms)
  targetFps?: number                  // Target frame rate
  maxFps?: number                     // Maximum frame rate cap
  memorySnapshotInterval?: number     // Interval for memory snapshots (ms)
  useThread?: boolean                 // Use native render thread
  gatherStats?: boolean               // Collect frame timing stats
  maxStatSamples?: number             // Max stat samples to keep
  consoleOptions?: ConsoleOptions     // Console overlay config
  postProcessFns?: ((buffer: OptimizedBuffer, deltaTime: number) => void)[]
  enableMouseMovement?: boolean       // Track mouse movement events
  useMouse?: boolean                  // Enable mouse input
  autoFocus?: boolean                 // Auto-focus first focusable
  useAlternateScreen?: boolean        // Switch to alternate screen buffer
  useConsole?: boolean                // Enable console overlay
  experimental_splitHeight?: number   // Split rendering height
  useKittyKeyboard?: KittyKeyboardOptions | null  // Kitty keyboard protocol
  backgroundColor?: ColorInput        // Default background color
  openConsoleOnError?: boolean        // Show console on error
  prependInputHandlers?: ((sequence: string) => boolean)[]  // Input interceptors
  onDestroy?: () => void              // Callback on destroy
}
```

### CliRenderer Class

The main renderer class. Implements `RenderContext` and `EventEmitter`.

```typescript
class CliRenderer extends EventEmitter implements RenderContext {
  // --- Core Properties ---
  readonly root: RootRenderable
  width: number
  height: number
  rendererPtr: Pointer
  stdin: NodeJS.ReadStream
  nextRenderBuffer: OptimizedBuffer
  currentRenderBuffer: OptimizedBuffer

  // --- State ---
  get controlState(): RendererControlState
  get isRunning(): boolean
  get isDestroyed(): boolean
  get terminalWidth(): number
  get terminalHeight(): number
  get resolution(): PixelResolution | null
  get themeMode(): ThemeMode | null
  get liveRequestCount(): number

  // --- Lifecycle ---
  setupTerminal(): Promise<void>
  start(): void
  auto(): void
  pause(): void
  suspend(): void
  resume(): void
  stop(): void
  destroy(): void
  idle(): Promise<void>

  // --- Rendering ---
  requestRender(): void
  intermediateRender(): void
  setBackgroundColor(color: ColorInput): void
  addPostProcessFn(fn: (buffer: OptimizedBuffer, deltaTime: number) => void): void
  removePostProcessFn(fn: (buffer: OptimizedBuffer, deltaTime: number) => void): void
  clearPostProcessFns(): void
  setFrameCallback(callback: (deltaTime: number) => Promise<void>): void
  removeFrameCallback(callback: (deltaTime: number) => Promise<void>): void
  clearFrameCallbacks(): void

  // --- Live Rendering ---
  requestLive(): void
  dropLive(): void

  // --- Cursor ---
  setCursorPosition(x: number, y: number, visible?: boolean): void
  setCursorStyle(options: CursorStyleOptions): void
  setCursorColor(color: RGBA): void
  getCursorState(): CursorState

  // --- Focus ---
  get currentFocusedRenderable(): Renderable | null
  focusRenderable(renderable: Renderable): void
  registerLifecyclePass(renderable: Renderable): void
  unregisterLifecyclePass(renderable: Renderable): void
  getLifecyclePasses(): Set<Renderable>

  // --- Mouse & Hit Testing ---
  get useMouse(): boolean
  set useMouse(value: boolean)
  setMousePointer(style: MousePointerStyle): void
  hitTest(x: number, y: number): number
  addToHitGrid(x: number, y: number, w: number, h: number, id: number): void
  pushHitGridScissorRect(x: number, y: number, w: number, h: number): void
  popHitGridScissorRect(): void
  clearHitGridScissorRects(): void

  // --- Selection ---
  get hasSelection(): boolean
  getSelection(): Selection | null
  clearSelection(): void
  startSelection(renderable: Renderable, x: number, y: number): void
  updateSelection(
    currentRenderable: Renderable | undefined,
    x: number, y: number,
    options?: { finishDragging?: boolean }
  ): void
  requestSelectionUpdate(): void

  // --- Clipboard ---
  copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean
  clearClipboardOSC52(target?: ClipboardTarget): boolean
  isOsc52Supported(): boolean

  // --- Terminal ---
  setTerminalTitle(title: string): void
  enableKittyKeyboard(flags?: number): void
  disableKittyKeyboard(): void
  get useKittyKeyboard(): boolean
  set useKittyKeyboard(use: boolean)

  // --- Input Handlers ---
  get keyInput(): KeyHandler
  get _internalKeyInput(): InternalKeyHandler
  addInputHandler(handler: (sequence: string) => boolean): void
  prependInputHandler(handler: (sequence: string) => boolean): void
  removeInputHandler(handler: (sequence: string) => boolean): void

  // --- Console ---
  get console(): TerminalConsole
  get useConsole(): boolean
  set useConsole(value: boolean)

  // --- Debug ---
  debugOverlay: { enabled: any; corner: DebugOverlayCorner }
  toggleDebugOverlay(): void
  configureDebugOverlay(options: { enabled?: boolean; corner?: DebugOverlayCorner }): void
  dumpHitGrid(): void
  dumpBuffers(timestamp?: number): void
  dumpStdoutBuffer(timestamp?: number): void
  getDebugInputs(): Array<{ timestamp: string; sequence: string }>

  // --- Stats ---
  getStats(): {
    fps: number
    frameCount: number
    frameTimes: number[]
    averageFrameTime: number
    minFrameTime: number
    maxFrameTime: number
  }
  resetStats(): void
  setGatherStats(enabled: boolean): void

  // --- Palette Detection ---
  get paletteDetectionStatus(): "idle" | "detecting" | "cached"
  clearPaletteCache(): void
  getPalette(options?: GetPaletteOptions): Promise<TerminalColors>

  // --- Split Height ---
  get experimental_splitHeight(): number
  set experimental_splitHeight(value: number)

  // --- Width Method ---
  get widthMethod(): WidthMethod
  get capabilities(): any | null
}
```

### Renderer Events

```typescript
interface RendererEvents {
  resize: (width: number, height: number) => void
  key: (data: Buffer) => void
  "memory:snapshot": (snapshot: {
    heapUsed: number; heapTotal: number; arrayBuffers: number
  }) => void
  selection: (selection: Selection) => void
  "debugOverlay:toggle": (enabled: boolean) => void
  theme_mode: (mode: ThemeMode) => void
}
```

Additional events on the `CliRenderer` EventEmitter:

```typescript
enum CliRenderEvents {
  DEBUG_OVERLAY_TOGGLE = "debugOverlay:toggle"
  DESTROY = "destroy"
}
```

### Renderer Control States

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

The control state machine governs the render loop:
- `IDLE` -- Renderer created but not started.
- `AUTO_STARTED` -- Started via `auto()` (only renders when live content exists).
- `EXPLICIT_STARTED` -- Started via `start()` (continuous rendering).
- `EXPLICIT_PAUSED` -- Rendering paused via `pause()`, can be resumed.
- `EXPLICIT_SUSPENDED` -- Terminal state saved and rendering fully suspended via `suspend()`.
- `EXPLICIT_STOPPED` -- Stopped via `stop()`, must call `start()` to resume.

## Renderable Base Classes

See [Buffer Reference](./buffer.md) for `OptimizedBuffer` details.
See [Types Reference](./types.md) for shared type definitions.

### BaseRenderable

The abstract base that provides the tree structure, event emitter, and dirty tracking.

```typescript
abstract class BaseRenderable extends EventEmitter {
  readonly num: number                 // Unique renderable number
  parent: BaseRenderable | null

  get id(): string
  set id(value: string)
  get isDirty(): boolean
  get visible(): boolean
  set visible(value: boolean)

  abstract add(obj: BaseRenderable | unknown, index?: number): number
  abstract remove(id: string): void
  abstract insertBefore(obj: BaseRenderable | unknown, anchor: BaseRenderable | unknown): void
  abstract getChildren(): BaseRenderable[]
  abstract getChildrenCount(): number
  abstract getRenderable(id: string): BaseRenderable | undefined
  abstract requestRender(): void
  abstract findDescendantById(id: string): BaseRenderable | undefined

  destroy(): void
  destroyRecursively(): void
}
```

### Renderable

The full renderable with layout, rendering, input handling, and focus.

```typescript
abstract class Renderable extends BaseRenderable {
  static renderablesByNumber: Map<number, Renderable>

  parent: Renderable | null
  selectable: boolean
  onLifecyclePass: (() => void) | null
  renderBefore?: (this: Renderable, buffer: OptimizedBuffer, deltaTime: number) => void
  renderAfter?: (this: Renderable, buffer: OptimizedBuffer, deltaTime: number) => void

  constructor(ctx: RenderContext, options: RenderableOptions<any>)

  // --- Properties ---
  get id(): string
  set id(value: string)
  get ctx(): RenderContext
  get visible(): boolean
  set visible(value: boolean)
  get opacity(): number
  set opacity(value: number)
  get focused(): boolean
  get focusable(): boolean
  set focusable(value: boolean)
  get live(): boolean
  set live(value: boolean)
  get liveCount(): number
  get isDestroyed(): boolean
  get primaryAxis(): "row" | "column"

  // --- Position & Size ---
  get x(): number
  set x(value: number)
  get y(): number
  set y(value: number)
  get width(): number
  set width(value: number | "auto" | `${number}%`)
  get height(): number
  set height(value: number | "auto" | `${number}%`)
  get translateX(): number
  set translateX(value: number)
  get translateY(): number
  set translateY(value: number)
  get zIndex(): number
  set zIndex(value: number)

  // --- Position edges ---
  get/set top, right, bottom, left: number | "auto" | `${number}%` | undefined

  // --- Layout setters ---
  set position(positionType: PositionTypeString | null | undefined)
  get/set overflow: OverflowString
  set flexGrow, flexShrink, flexDirection, flexWrap: ...
  set alignItems, justifyContent, alignSelf, flexBasis: ...
  set minWidth, maxWidth, minHeight, maxHeight: ...
  set margin, marginX, marginY, marginTop/Right/Bottom/Left: ...
  set padding, paddingX, paddingY, paddingTop/Right/Bottom/Left: ...

  setPosition(position: Position): void
  getLayoutNode(): YogaNode

  // --- Children ---
  add(obj: Renderable | VNode, index?: number): number
  insertBefore(obj: Renderable | VNode, anchor?: Renderable): number
  remove(id: string): void
  getChildren(): Renderable[]
  getChildrenCount(): number
  getRenderable(id: string): Renderable | undefined
  findDescendantById(id: string): Renderable | undefined
  getChildrenSortedByPrimaryAxis(): Renderable[]

  // --- Focus & Input ---
  focus(): void
  blur(): void
  handleKeyPress?(key: KeyEvent): boolean
  handlePaste?(event: PasteEvent): void

  // --- Selection ---
  hasSelection(): boolean
  onSelectionChanged(selection: Selection | null): boolean
  getSelectedText(): string
  shouldStartSelection(x: number, y: number): boolean

  // --- Rendering ---
  requestRender(): void
  updateLayout(deltaTime: number, renderList?: RenderCommand[]): void
  render(buffer: OptimizedBuffer, deltaTime: number): void
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void
  protected onUpdate(deltaTime: number): void
  protected onResize(width: number, height: number): void
  protected onRemove(): void
  protected onLayoutResize(width: number, height: number): void
  updateFromLayout(): void

  // --- Mouse ---
  processMouseEvent(event: MouseEvent): void
  set onMouse, onMouseDown, onMouseUp, onMouseMove: ...
  set onMouseDrag, onMouseDragEnd, onMouseDrop: ...
  set onMouseOver, onMouseOut, onMouseScroll: ...
  set onPaste, onKeyDown, onSizeChange: ...

  // --- Lifecycle ---
  destroy(): void
  destroyRecursively(): void
}
```

### RootRenderable

The top-level renderable owned by `CliRenderer`. It orchestrates layout calculation and the render pass.

```typescript
class RootRenderable extends Renderable {
  constructor(ctx: RenderContext)
  render(buffer: OptimizedBuffer, deltaTime: number): void
  calculateLayout(): void
  resize(width: number, height: number): void
}
```

### RenderableOptions

```typescript
interface RenderableOptions<T extends BaseRenderable = BaseRenderable> extends Partial<LayoutOptions> {
  width?: number | "auto" | `${number}%`
  height?: number | "auto" | `${number}%`
  zIndex?: number
  visible?: boolean
  buffered?: boolean        // Use an off-screen frame buffer
  live?: boolean            // Request continuous rendering
  opacity?: number          // 0.0 to 1.0
  renderBefore?: (this: T, buffer: OptimizedBuffer, deltaTime: number) => void
  renderAfter?: (this: T, buffer: OptimizedBuffer, deltaTime: number) => void
  onMouse?: (this: T, event: MouseEvent) => void
  onMouseDown?: (this: T, event: MouseEvent) => void
  onMouseUp?: (this: T, event: MouseEvent) => void
  onMouseMove?: (this: T, event: MouseEvent) => void
  onMouseDrag?: (this: T, event: MouseEvent) => void
  onMouseDragEnd?: (this: T, event: MouseEvent) => void
  onMouseDrop?: (this: T, event: MouseEvent) => void
  onMouseOver?: (this: T, event: MouseEvent) => void
  onMouseOut?: (this: T, event: MouseEvent) => void
  onMouseScroll?: (this: T, event: MouseEvent) => void
  onPaste?: (this: T, event: PasteEvent) => void
  onKeyDown?: (key: KeyEvent) => void
  onSizeChange?: (this: T) => void
}
```

### Layout Properties

All renderables accept Flexbox layout via `LayoutOptions`:

```typescript
interface LayoutOptions extends BaseRenderableOptions {
  flexGrow?: number
  flexShrink?: number
  flexDirection?: "column" | "column-reverse" | "row" | "row-reverse"
  flexWrap?: "no-wrap" | "wrap" | "wrap-reverse"
  alignItems?: AlignString
  justifyContent?: JustifyString
  alignSelf?: AlignString
  flexBasis?: number | "auto"
  position?: "static" | "relative" | "absolute"
  overflow?: "visible" | "hidden" | "scroll"
  top/right/bottom/left?: number | "auto" | `${number}%`
  minWidth/minHeight?: number | "auto" | `${number}%`
  maxWidth/maxHeight?: number | "auto" | `${number}%`
  margin/marginX/marginY?: number | "auto" | `${number}%`
  marginTop/Right/Bottom/Left?: number | "auto" | `${number}%`
  padding/paddingX/paddingY?: number | `${number}%`
  paddingTop/Right/Bottom/Left?: number | `${number}%`
  enableLayout?: boolean
}
```

### Creating a Custom Renderable

```typescript
import { Renderable, RenderableOptions, RenderContext, OptimizedBuffer, RGBA } from "@opentui/core"

interface MyWidgetOptions extends RenderableOptions<MyWidget> {
  label?: string
}

class MyWidget extends Renderable {
  private _label: string

  constructor(ctx: RenderContext, options: MyWidgetOptions = {}) {
    super(ctx, options)
    this._label = options.label ?? ""
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    const fg = RGBA.fromHex("#ffffff")
    buffer.drawText(this._label, this.x, this.y, fg)
  }

  set label(value: string) {
    this._label = value
    this.requestRender()
  }
}
```

Key hooks to override:
- `renderSelf(buffer, deltaTime)` -- Draw your content.
- `onUpdate(deltaTime)` -- Run logic each frame before rendering.
- `onResize(width, height)` -- React to size changes.
- `onRemove()` -- Clean up when removed from tree.
- `handleKeyPress(key)` -- Handle keyboard input when focused. Return `true` to consume.
- `handlePaste(event)` -- Handle paste events when focused.

## Input Handling

### KeyEvent

```typescript
class KeyEvent {
  name: string                // "return", "escape", "tab", "up", "a", etc.
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean             // Alt key
  sequence: string            // Raw escape sequence
  raw: string                 // Original input
  eventType: "press" | "repeat" | "release"
  source: "raw" | "kitty"
  code?: string               // Key code (Kitty protocol)
  repeated?: boolean
  super?: boolean
  hyper?: boolean
  capsLock?: boolean
  numLock?: boolean

  preventDefault(): void
  stopPropagation(): void
}
```

### MouseEvent

```typescript
class MouseEvent {
  readonly type: MouseEventType
  readonly button: number         // 0=left, 1=middle, 2=right, 4=wheel-up, 5=wheel-down
  readonly x: number
  readonly y: number
  readonly source?: Renderable
  readonly target: Renderable | null
  readonly modifiers: { shift: boolean; alt: boolean; ctrl: boolean }
  readonly scroll?: ScrollInfo
  readonly isDragging?: boolean

  get propagationStopped(): boolean
  get defaultPrevented(): boolean

  stopPropagation(): void
  preventDefault(): void
}

enum MouseButton {
  LEFT = 0,
  MIDDLE = 1,
  RIGHT = 2,
  WHEEL_UP = 4,
  WHEEL_DOWN = 5,
}
```

### PasteEvent

```typescript
class PasteEvent {
  text: string
  preventDefault(): void
  stopPropagation(): void
}
```

### Kitty Keyboard Protocol

```typescript
interface KittyKeyboardOptions {
  disambiguate?: boolean      // Fix ESC timing, alt+key ambiguity. Default: true
  alternateKeys?: boolean     // Report numpad, shifted, base layout keys. Default: true
  events?: boolean            // Report press/repeat/release. Default: false
  allKeysAsEscapes?: boolean  // All keys as escape codes. Default: false
  reportText?: boolean        // Report associated text. Default: false
}

function buildKittyKeyboardFlags(config: KittyKeyboardOptions | null | undefined): number
```

## Selection System

The renderer manages text selection across renderables. Renderables opt in via `selectable = true`.

- `renderer.startSelection(renderable, x, y)` -- Begin a selection.
- `renderer.updateSelection(renderable, x, y, options?)` -- Extend the selection.
- `renderer.clearSelection()` -- Clear the selection.
- `renderer.getSelection()` -- Get the current `Selection` object.
- `renderable.onSelectionChanged(selection)` -- Called when selection changes. Return `true` if handled.
- `renderable.getSelectedText()` -- Return selected text within this renderable.

## Post-Processing Filters

Post-process functions run after the render pass on the buffer. See [ANSI & Utilities Reference](./ansi-utils.md) for the full filter API.

```typescript
renderer.addPostProcessFn((buffer, deltaTime) => {
  applyScanlines(buffer, 0.3)
})
```

Available filters: `applyScanlines`, `applyGrayscale`, `applySepia`, `applyInvert`, `applyNoise`, `applyChromaticAberration`, `applyAsciiArt`, and effect classes `DistortionEffect`, `VignetteEffect`, `BrightnessEffect`, `BlurEffect`, `BloomEffect`.

## Animation System

The `Timeline` system provides property animation with easing. See [ANSI & Utilities Reference](./ansi-utils.md) for details.

```typescript
import { createTimeline, engine } from "@opentui/core"

engine.attach(renderer)

const tl = createTimeline({ loop: true })
tl.add([myRenderable], { duration: 1000, opacity: 0, ease: "inOutSine" })
tl.play()
```

## Related Documentation

- [Types Reference](./types.md) -- All shared types, enums, and interfaces
- [Renderer Reference](./renderer.md) -- Renderer system, draw loop, native layer
- [Buffer Reference](./buffer.md) -- OptimizedBuffer, EditBuffer, TextBufferView, EditorView
- [ANSI & Utilities Reference](./ansi-utils.md) -- ANSI codes, console, filters, animation, utilities
