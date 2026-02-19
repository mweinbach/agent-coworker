# Renderer Reference

The renderer system in `@opentui/core` manages the draw loop, terminal I/O, native Zig interop, and the double-buffered rendering pipeline.

## Table of Contents

- [Overview](#overview)
- [createCliRenderer()](#createclirenderer)
- [CliRendererConfig](#clirendererconfig)
- [CliRenderer Class](#clirenderer-class)
  - [Core Properties](#core-properties)
  - [Lifecycle Methods](#lifecycle-methods)
  - [Render Loop](#render-loop)
  - [Live Rendering](#live-rendering)
  - [Cursor Management](#cursor-management)
  - [Focus System](#focus-system)
  - [Mouse & Hit Testing](#mouse--hit-testing)
  - [Selection](#selection)
  - [Clipboard](#clipboard)
  - [Terminal Control](#terminal-control)
  - [Input Handling](#input-handling)
  - [Console Overlay](#console-overlay)
  - [Debug Tools](#debug-tools)
  - [Performance Stats](#performance-stats)
  - [Palette Detection](#palette-detection)
- [Renderer Control State Machine](#renderer-control-state-machine)
- [Render Pipeline Detail](#render-pipeline-detail)
- [RenderLib (Native Zig Interface)](#renderlib-native-zig-interface)
  - [Renderer Management](#renderer-management)
  - [Buffer Operations](#buffer-operations)
  - [Text Buffer Operations](#text-buffer-operations)
  - [Edit Buffer Operations](#edit-buffer-operations)
  - [Editor View Operations](#editor-view-operations)
  - [Hit Grid Operations](#hit-grid-operations)
  - [Clipboard Operations](#clipboard-operations)
  - [NativeSpanFeed Operations](#nativespanfeed-operations)
  - [Syntax Style Operations](#syntax-style-operations)
  - [Utility Operations](#utility-operations)
- [Related Documentation](#related-documentation)

---

## Overview

The renderer is the heart of OpenTUI. It:

1. Loads the platform-specific native Zig library via `bun:ffi`.
2. Creates a native renderer pointer that manages the terminal state.
3. Owns the `RootRenderable` -- the top of the renderable tree.
4. Runs the render loop: layout calculation, tree rendering, buffer diffing, and terminal output.
5. Handles all terminal I/O: stdin parsing, resize events, mouse events, keyboard events.
6. Provides double-buffered rendering with minimal terminal writes via native diffing.

## createCliRenderer()

```typescript
declare function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>
```

Async factory that:
1. Calls `resolveRenderLib()` to load the native Zig library.
2. Creates a native renderer pointer via `lib.createRenderer()`.
3. Constructs the `CliRenderer` instance.
4. Sets up the terminal (alternate screen, mouse, keyboard protocols).

Returns a fully initialized renderer ready for use.

## CliRendererConfig

```typescript
interface CliRendererConfig {
  // --- I/O ---
  stdin?: NodeJS.ReadStream                // Default: process.stdin
  stdout?: NodeJS.WriteStream              // Default: process.stdout
  remote?: boolean                         // Enable remote rendering mode

  // --- Exit Behavior ---
  exitOnCtrlC?: boolean                    // Process.exit on Ctrl+C
  exitSignals?: NodeJS.Signals[]           // Signals to listen for exit

  // --- Frame Rate ---
  targetFps?: number                       // Target frames per second
  maxFps?: number                          // Hard cap on FPS
  debounceDelay?: number                   // Resize event debounce (ms)

  // --- Memory ---
  memorySnapshotInterval?: number          // Memory snapshot interval (ms)

  // --- Threading ---
  useThread?: boolean                      // Use native render thread

  // --- Stats ---
  gatherStats?: boolean                    // Collect frame timing data
  maxStatSamples?: number                  // Max stat samples to store

  // --- Console ---
  consoleOptions?: ConsoleOptions          // Console overlay configuration
  useConsole?: boolean                     // Enable console overlay
  openConsoleOnError?: boolean             // Auto-show console on error

  // --- Post-Processing ---
  postProcessFns?: ((buffer: OptimizedBuffer, deltaTime: number) => void)[]

  // --- Mouse ---
  enableMouseMovement?: boolean            // Track mouse movement (not just clicks)
  useMouse?: boolean                       // Enable mouse input at all

  // --- Focus ---
  autoFocus?: boolean                      // Auto-focus first focusable renderable

  // --- Terminal ---
  useAlternateScreen?: boolean             // Switch to alternate screen buffer
  experimental_splitHeight?: number        // Split rendering height
  backgroundColor?: ColorInput             // Default background color

  // --- Keyboard ---
  useKittyKeyboard?: KittyKeyboardOptions | null   // Kitty keyboard protocol config

  // --- Input ---
  prependInputHandlers?: ((sequence: string) => boolean)[]  // Priority input handlers

  // --- Cleanup ---
  onDestroy?: () => void                   // Callback when renderer is destroyed
}
```

## CliRenderer Class

The main renderer. Extends `EventEmitter` and implements `RenderContext`.

### Core Properties

```typescript
readonly root: RootRenderable        // The root of the renderable tree
width: number                        // Current terminal width in cells
height: number                       // Current terminal height in cells
rendererPtr: Pointer                 // Native renderer pointer (bun:ffi)
stdin: NodeJS.ReadStream             // Stdin stream
nextRenderBuffer: OptimizedBuffer    // Buffer being rendered into
currentRenderBuffer: OptimizedBuffer // Last-rendered buffer (for diffing)
```

### Lifecycle Methods

```typescript
// Set up terminal (alternate screen, raw mode, mouse, etc.)
setupTerminal(): Promise<void>

// Start continuous render loop
start(): void

// Start in auto mode (only renders when live content exists)
auto(): void

// Pause rendering (keeps terminal state)
pause(): void

// Suspend rendering (saves and restores terminal state)
suspend(): void

// Resume from pause or suspend
resume(): void

// Stop the render loop
stop(): void

// Clean up everything and restore terminal
destroy(): void

// Returns a promise that resolves when no renders are pending
idle(): Promise<void>
```

### Render Loop

```typescript
// Request a new frame to be rendered
requestRender(): void

// Force an intermediate render outside the normal loop
intermediateRender(): void

// Set the terminal background color
setBackgroundColor(color: ColorInput): void

// Post-process functions run after rendering, before output
addPostProcessFn(fn: (buffer: OptimizedBuffer, deltaTime: number) => void): void
removePostProcessFn(fn: (buffer: OptimizedBuffer, deltaTime: number) => void): void
clearPostProcessFns(): void

// Frame callbacks run at the start of each frame
setFrameCallback(callback: (deltaTime: number) => Promise<void>): void
removeFrameCallback(callback: (deltaTime: number) => Promise<void>): void
clearFrameCallbacks(): void
```

### Live Rendering

The "live" system allows renderables to request continuous rendering. When no renderables are live, the renderer in `auto` mode stops the loop to save resources.

```typescript
// Increment the live request counter (starts render loop if auto)
requestLive(): void

// Decrement the live request counter (stops loop if auto and count reaches 0)
dropLive(): void

// Current number of live requests
get liveRequestCount(): number
```

### Cursor Management

```typescript
setCursorPosition(x: number, y: number, visible?: boolean): void
setCursorStyle(options: CursorStyleOptions): void
setCursorColor(color: RGBA): void
getCursorState(): CursorState

// Static versions (for use without instance)
static setCursorPosition(renderer: CliRenderer, x: number, y: number, visible?: boolean): void
static setCursorStyle(renderer: CliRenderer, options: CursorStyleOptions): void
static setCursorColor(renderer: CliRenderer, color: RGBA): void
```

### Focus System

```typescript
get currentFocusedRenderable(): Renderable | null
focusRenderable(renderable: Renderable): void

// Lifecycle passes: renderables that need per-frame updates
registerLifecyclePass(renderable: Renderable): void
unregisterLifecyclePass(renderable: Renderable): void
getLifecyclePasses(): Set<Renderable>
```

### Mouse & Hit Testing

The hit grid is a spatial index that maps screen coordinates to renderable IDs for mouse event dispatch.

```typescript
get useMouse(): boolean
set useMouse(value: boolean)
setMousePointer(style: MousePointerStyle): void

// Hit testing: returns the renderable number at the given coordinates
hitTest(x: number, y: number): number

// Hit grid management (used internally by the render pipeline)
addToHitGrid(x: number, y: number, width: number, height: number, id: number): void
pushHitGridScissorRect(x: number, y: number, width: number, height: number): void
popHitGridScissorRect(): void
clearHitGridScissorRects(): void
```

### Selection

```typescript
get hasSelection(): boolean
getSelection(): Selection | null
getSelectionContainer(): Renderable | null
clearSelection(): void
startSelection(renderable: Renderable, x: number, y: number): void
updateSelection(
  currentRenderable: Renderable | undefined,
  x: number, y: number,
  options?: { finishDragging?: boolean }
): void
requestSelectionUpdate(): void
```

### Clipboard

OSC 52 clipboard support (works in many modern terminals).

```typescript
copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean
clearClipboardOSC52(target?: ClipboardTarget): boolean
isOsc52Supported(): boolean
```

### Terminal Control

```typescript
setTerminalTitle(title: string): void
enableKittyKeyboard(flags?: number): void
disableKittyKeyboard(): void
get useKittyKeyboard(): boolean
set useKittyKeyboard(use: boolean)
get experimental_splitHeight(): number
set experimental_splitHeight(value: number)
get widthMethod(): WidthMethod
get capabilities(): any | null
get terminalWidth(): number
get terminalHeight(): number
get resolution(): PixelResolution | null
get themeMode(): ThemeMode | null
disableStdoutInterception(): void
```

### Input Handling

```typescript
get keyInput(): KeyHandler
get _internalKeyInput(): InternalKeyHandler

// Register custom input handlers that intercept raw escape sequences
// Return true from handler to consume the input
addInputHandler(handler: (sequence: string) => boolean): void
prependInputHandler(handler: (sequence: string) => boolean): void
removeInputHandler(handler: (sequence: string) => boolean): void
```

### Console Overlay

```typescript
get console(): TerminalConsole
get useConsole(): boolean
set useConsole(value: boolean)
```

See [ANSI & Utilities Reference](./ansi-utils.md#terminalconsole) for `TerminalConsole` details.

### Debug Tools

```typescript
debugOverlay: { enabled: any; corner: DebugOverlayCorner }
toggleDebugOverlay(): void
configureDebugOverlay(options: { enabled?: boolean; corner?: DebugOverlayCorner }): void

dumpHitGrid(): void                       // Dump hit grid to console
dumpBuffers(timestamp?: number): void      // Dump buffer contents
dumpStdoutBuffer(timestamp?: number): void // Dump stdout output buffer

getDebugInputs(): Array<{ timestamp: string; sequence: string }>
```

### Performance Stats

```typescript
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
```

### Palette Detection

```typescript
get paletteDetectionStatus(): "idle" | "detecting" | "cached"
clearPaletteCache(): void
getPalette(options?: GetPaletteOptions): Promise<TerminalColors>
```

---

## Renderer Control State Machine

```
         createCliRenderer()
                |
                v
             [IDLE]
            /      \
       auto()     start()
          |          |
          v          v
  [AUTO_STARTED]  [EXPLICIT_STARTED]
        |               |        \
        |          pause()     suspend()
        |               |          \
        |               v           v
        |     [EXPLICIT_PAUSED]  [EXPLICIT_SUSPENDED]
        |               |           |
        |          resume()    resume()
        |               |           |
        |               v           v
        |     [EXPLICIT_STARTED]  [EXPLICIT_STARTED]
        |
        +----------> stop() ------> [EXPLICIT_STOPPED]
                                         |
                                      start()
                                         |
                                         v
                                  [EXPLICIT_STARTED]
```

---

## Render Pipeline Detail

Each frame executes the following:

1. **Frame callbacks** -- Async callbacks registered via `setFrameCallback()`.
2. **Lifecycle passes** -- Registered renderables get `onLifecyclePass()` called.
3. **Layout calculation** -- `root.calculateLayout()` invokes Yoga.
4. **Update + Render** -- `root.render(buffer, deltaTime)` calls:
   - `updateLayout()` -- Walks the tree, syncs Yoga positions, builds render command list.
   - Execute render commands in order:
     - `pushScissorRect` / `popScissorRect` -- Manage clipping.
     - `pushOpacity` / `popOpacity` -- Manage opacity stack.
     - `render` -- Calls `renderable.renderSelf(buffer, deltaTime)`.
5. **Post-processing** -- Each registered post-process function runs on the buffer.
6. **Native diff + output** -- The native Zig layer diffs `nextRenderBuffer` against `currentRenderBuffer` and writes only changed cells as ANSI escape sequences to stdout.
7. **Buffer swap** -- The buffers are swapped for the next frame.
8. **Hit grid check** -- If the hit grid changed, recheck hover state for mouse events.

---

## RenderLib (Native Zig Interface)

The `RenderLib` interface defines all FFI bindings to the native Zig rendering library. It is loaded via `resolveRenderLib()` and used internally by all buffer, renderer, and text operations.

```typescript
declare function setRenderLibPath(libPath: string): void
declare function resolveRenderLib(): RenderLib
```

### Renderer Management

```typescript
interface RenderLib {
  createRenderer(width: number, height: number, options?: {
    testing?: boolean; remote?: boolean
  }): Pointer | null
  destroyRenderer(renderer: Pointer): void
  setUseThread(renderer: Pointer, useThread: boolean): void
  setBackgroundColor(renderer: Pointer, color: RGBA): void
  setRenderOffset(renderer: Pointer, offset: number): void
  updateStats(renderer: Pointer, time: number, fps: number, frameCallbackTime: number): void
  updateMemoryStats(renderer: Pointer, heapUsed: number, heapTotal: number, arrayBuffers: number): void
  render(renderer: Pointer, force: boolean): void
  getNextBuffer(renderer: Pointer): OptimizedBuffer
  getCurrentBuffer(renderer: Pointer): OptimizedBuffer
  resizeRenderer(renderer: Pointer, width: number, height: number): void
  setupTerminal(renderer: Pointer, useAlternateScreen: boolean): void
  suspendRenderer(renderer: Pointer): void
  resumeRenderer(renderer: Pointer): void
  clearTerminal(renderer: Pointer): void
  restoreTerminalModes(renderer: Pointer): void
  writeOut(renderer: Pointer, data: string | Uint8Array): void
  queryPixelResolution(renderer: Pointer): void
}
```

### Buffer Operations

```typescript
interface RenderLib {
  createOptimizedBuffer(width: number, height: number, widthMethod: WidthMethod,
    respectAlpha?: boolean, id?: string): OptimizedBuffer
  destroyOptimizedBuffer(bufferPtr: Pointer): void
  drawFrameBuffer(targetBufferPtr: Pointer, destX: number, destY: number,
    bufferPtr: Pointer, sourceX?: number, sourceY?: number,
    sourceWidth?: number, sourceHeight?: number): void
  getBufferWidth(buffer: Pointer): number
  getBufferHeight(buffer: Pointer): number
  bufferClear(buffer: Pointer, color: RGBA): void
  bufferSetCell(buffer: Pointer, x: number, y: number, char: string,
    color: RGBA, bgColor: RGBA, attributes?: number): void
  bufferSetCellWithAlphaBlending(buffer: Pointer, x: number, y: number,
    char: string, color: RGBA, bgColor: RGBA, attributes?: number): void
  bufferDrawText(buffer: Pointer, text: string, x: number, y: number,
    color: RGBA, bgColor?: RGBA, attributes?: number): void
  bufferFillRect(buffer: Pointer, x: number, y: number,
    width: number, height: number, color: RGBA): void
  bufferDrawBox(buffer: Pointer, x: number, y: number, width: number, height: number,
    borderChars: Uint32Array, packedOptions: number,
    borderColor: RGBA, backgroundColor: RGBA, title: string | null): void
  bufferResize(buffer: Pointer, width: number, height: number): void
  bufferDrawChar(buffer: Pointer, char: number, x: number, y: number,
    fg: RGBA, bg: RGBA, attributes?: number): void

  // Raw buffer access
  bufferGetCharPtr(buffer: Pointer): Pointer
  bufferGetFgPtr(buffer: Pointer): Pointer
  bufferGetBgPtr(buffer: Pointer): Pointer
  bufferGetAttributesPtr(buffer: Pointer): Pointer
  bufferGetRespectAlpha(buffer: Pointer): boolean
  bufferSetRespectAlpha(buffer: Pointer, respectAlpha: boolean): void
  bufferGetId(buffer: Pointer): string
  bufferGetRealCharSize(buffer: Pointer): number
  bufferWriteResolvedChars(buffer: Pointer, outputBuffer: Uint8Array, addLineBreaks: boolean): number

  // Super-sample and packed buffer rendering
  bufferDrawSuperSampleBuffer(buffer: Pointer, x: number, y: number,
    pixelDataPtr: Pointer, pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm", alignedBytesPerRow: number): void
  bufferDrawPackedBuffer(buffer: Pointer, dataPtr: Pointer, dataLen: number,
    posX: number, posY: number,
    terminalWidthCells: number, terminalHeightCells: number): void
  bufferDrawGrayscaleBuffer(buffer: Pointer, posX: number, posY: number,
    intensitiesPtr: Pointer, srcWidth: number, srcHeight: number,
    fg: RGBA | null, bg: RGBA | null): void
  bufferDrawGrayscaleBufferSupersampled(buffer: Pointer, posX: number, posY: number,
    intensitiesPtr: Pointer, srcWidth: number, srcHeight: number,
    fg: RGBA | null, bg: RGBA | null): void

  // Scissor and opacity
  bufferPushScissorRect(buffer: Pointer, x: number, y: number, width: number, height: number): void
  bufferPopScissorRect(buffer: Pointer): void
  bufferClearScissorRects(buffer: Pointer): void
  bufferPushOpacity(buffer: Pointer, opacity: number): void
  bufferPopOpacity(buffer: Pointer): void
  bufferGetCurrentOpacity(buffer: Pointer): number
  bufferClearOpacity(buffer: Pointer): void

  // Text buffer rendering
  bufferDrawTextBufferView(buffer: Pointer, view: Pointer, x: number, y: number): void
  bufferDrawEditorView(buffer: Pointer, view: Pointer, x: number, y: number): void
}
```

### Text Buffer Operations

```typescript
interface RenderLib {
  createTextBuffer(widthMethod: WidthMethod): TextBuffer
  destroyTextBuffer(buffer: Pointer): void
  textBufferGetLength(buffer: Pointer): number
  textBufferGetByteSize(buffer: Pointer): number
  textBufferReset(buffer: Pointer): void
  textBufferClear(buffer: Pointer): void

  // Memory management
  textBufferRegisterMemBuffer(buffer: Pointer, bytes: Uint8Array, owned?: boolean): number
  textBufferReplaceMemBuffer(buffer: Pointer, memId: number, bytes: Uint8Array, owned?: boolean): boolean
  textBufferClearMemRegistry(buffer: Pointer): void
  textBufferSetTextFromMem(buffer: Pointer, memId: number): void
  textBufferAppend(buffer: Pointer, bytes: Uint8Array): void
  textBufferAppendFromMemId(buffer: Pointer, memId: number): void
  textBufferLoadFile(buffer: Pointer, path: string): boolean

  // Styled text
  textBufferSetStyledText(buffer: Pointer, chunks: Array<{
    text: string; fg?: RGBA | null; bg?: RGBA | null;
    attributes?: number; link?: { url: string }
  }>): void

  // Defaults
  textBufferSetDefaultFg(buffer: Pointer, fg: RGBA | null): void
  textBufferSetDefaultBg(buffer: Pointer, bg: RGBA | null): void
  textBufferSetDefaultAttributes(buffer: Pointer, attributes: number | null): void
  textBufferResetDefaults(buffer: Pointer): void
  textBufferGetTabWidth(buffer: Pointer): number
  textBufferSetTabWidth(buffer: Pointer, width: number): void
  textBufferGetLineCount(buffer: Pointer): number

  // Text extraction
  getPlainTextBytes(buffer: Pointer, maxLength: number): Uint8Array | null
  textBufferGetTextRange(buffer: Pointer, startOffset: number, endOffset: number,
    maxLength: number): Uint8Array | null
  textBufferGetTextRangeByCoords(buffer: Pointer, startRow: number, startCol: number,
    endRow: number, endCol: number, maxLength: number): Uint8Array | null

  // Highlights
  textBufferAddHighlightByCharRange(buffer: Pointer, highlight: Highlight): void
  textBufferAddHighlight(buffer: Pointer, lineIdx: number, highlight: Highlight): void
  textBufferRemoveHighlightsByRef(buffer: Pointer, hlRef: number): void
  textBufferClearLineHighlights(buffer: Pointer, lineIdx: number): void
  textBufferClearAllHighlights(buffer: Pointer): void
  textBufferSetSyntaxStyle(buffer: Pointer, style: Pointer | null): void
  textBufferGetLineHighlights(buffer: Pointer, lineIdx: number): Array<Highlight>
  textBufferGetHighlightCount(buffer: Pointer): number

  // Text buffer views
  createTextBufferView(textBuffer: Pointer): Pointer
  destroyTextBufferView(view: Pointer): void
  textBufferViewSetSelection(...): void
  textBufferViewResetSelection(view: Pointer): void
  textBufferViewGetSelection(view: Pointer): { start: number; end: number } | null
  textBufferViewSetLocalSelection(...): boolean
  textBufferViewUpdateSelection(...): void
  textBufferViewUpdateLocalSelection(...): boolean
  textBufferViewResetLocalSelection(view: Pointer): void
  textBufferViewSetWrapWidth(view: Pointer, width: number): void
  textBufferViewSetWrapMode(view: Pointer, mode: "none" | "char" | "word"): void
  textBufferViewSetViewportSize(view: Pointer, width: number, height: number): void
  textBufferViewSetViewport(view: Pointer, x: number, y: number, width: number, height: number): void
  textBufferViewGetLineInfo(view: Pointer): LineInfo
  textBufferViewGetLogicalLineInfo(view: Pointer): LineInfo
  textBufferViewGetSelectedTextBytes(view: Pointer, maxLength: number): Uint8Array | null
  textBufferViewGetPlainTextBytes(view: Pointer, maxLength: number): Uint8Array | null
  textBufferViewSetTabIndicator(view: Pointer, indicator: number): void
  textBufferViewSetTabIndicatorColor(view: Pointer, color: RGBA): void
  textBufferViewSetTruncate(view: Pointer, truncate: boolean): void
  textBufferViewMeasureForDimensions(view: Pointer, width: number, height: number): {
    lineCount: number; maxWidth: number
  } | null
  textBufferViewGetVirtualLineCount(view: Pointer): number
}
```

### Edit Buffer Operations

```typescript
interface RenderLib {
  createEditBuffer(widthMethod: WidthMethod): Pointer
  destroyEditBuffer(buffer: Pointer): void
  editBufferSetText(buffer: Pointer, textBytes: Uint8Array): void
  editBufferSetTextFromMem(buffer: Pointer, memId: number): void
  editBufferReplaceText(buffer: Pointer, textBytes: Uint8Array): void
  editBufferReplaceTextFromMem(buffer: Pointer, memId: number): void
  editBufferGetText(buffer: Pointer, maxLength: number): Uint8Array | null
  editBufferInsertChar(buffer: Pointer, char: string): void
  editBufferInsertText(buffer: Pointer, text: string): void
  editBufferDeleteChar(buffer: Pointer): void
  editBufferDeleteCharBackward(buffer: Pointer): void
  editBufferDeleteRange(buffer: Pointer, startLine: number, startCol: number,
    endLine: number, endCol: number): void
  editBufferNewLine(buffer: Pointer): void
  editBufferDeleteLine(buffer: Pointer): void
  editBufferMoveCursorLeft/Right/Up/Down(buffer: Pointer): void
  editBufferGotoLine(buffer: Pointer, line: number): void
  editBufferSetCursor(buffer: Pointer, line: number, col: number): void
  editBufferSetCursorToLineCol(buffer: Pointer, line: number, col: number): void
  editBufferSetCursorByOffset(buffer: Pointer, offset: number): void
  editBufferGetCursorPosition(buffer: Pointer): LogicalCursor
  editBufferGetId(buffer: Pointer): number
  editBufferGetTextBuffer(buffer: Pointer): Pointer
  editBufferDebugLogRope(buffer: Pointer): void
  editBufferUndo/Redo(buffer: Pointer, maxLength: number): Uint8Array | null
  editBufferCanUndo/CanRedo(buffer: Pointer): boolean
  editBufferClearHistory(buffer: Pointer): void
  editBufferClear(buffer: Pointer): void
  editBufferGetNextWordBoundary/GetPrevWordBoundary/GetEOL(buffer: Pointer): LogicalCursor
  editBufferOffsetToPosition(buffer: Pointer, offset: number): LogicalCursor | null
  editBufferPositionToOffset(buffer: Pointer, row: number, col: number): number
  editBufferGetLineStartOffset(buffer: Pointer, row: number): number
  editBufferGetTextRange(buffer: Pointer, startOffset: number, endOffset: number,
    maxLength: number): Uint8Array | null
  editBufferGetTextRangeByCoords(buffer: Pointer, startRow: number, startCol: number,
    endRow: number, endCol: number, maxLength: number): Uint8Array | null
}
```

### Editor View Operations

```typescript
interface RenderLib {
  createEditorView(editBufferPtr: Pointer, viewportWidth: number, viewportHeight: number): Pointer
  destroyEditorView(view: Pointer): void
  editorViewSetViewportSize(view: Pointer, width: number, height: number): void
  editorViewSetViewport(view: Pointer, x: number, y: number, width: number, height: number,
    moveCursor: boolean): void
  editorViewGetViewport(view: Pointer): Viewport
  editorViewSetScrollMargin(view: Pointer, margin: number): void
  editorViewSetWrapMode(view: Pointer, mode: "none" | "char" | "word"): void
  editorViewGetVirtualLineCount/GetTotalVirtualLineCount(view: Pointer): number
  editorViewGetTextBufferView(view: Pointer): Pointer
  editorViewSetSelection/UpdateSelection/ResetSelection(view: Pointer, ...): void
  editorViewGetSelection(view: Pointer): { start: number; end: number } | null
  editorViewSetLocalSelection/UpdateLocalSelection/ResetLocalSelection(view: Pointer, ...): ...
  editorViewGetSelectedTextBytes(view: Pointer, maxLength: number): Uint8Array | null
  editorViewGetCursor(view: Pointer): { row: number; col: number }
  editorViewGetText(view: Pointer, maxLength: number): Uint8Array | null
  editorViewGetVisualCursor(view: Pointer): VisualCursor
  editorViewMoveUpVisual/MoveDownVisual(view: Pointer): void
  editorViewDeleteSelectedText(view: Pointer): void
  editorViewSetCursorByOffset(view: Pointer, offset: number): void
  editorViewGetNextWordBoundary/GetPrevWordBoundary/GetEOL(view: Pointer): VisualCursor
  editorViewGetVisualSOL/GetVisualEOL(view: Pointer): VisualCursor
  editorViewGetLineInfo/GetLogicalLineInfo(view: Pointer): LineInfo
  editorViewSetPlaceholderStyledText(view: Pointer, chunks: Array<{
    text: string; fg?: RGBA | null; bg?: RGBA | null; attributes?: number
  }>): void
  editorViewSetTabIndicator(view: Pointer, indicator: number): void
  editorViewSetTabIndicatorColor(view: Pointer, color: RGBA): void
}
```

### Hit Grid Operations

```typescript
interface RenderLib {
  addToHitGrid(renderer: Pointer, x: number, y: number, width: number, height: number, id: number): void
  clearCurrentHitGrid(renderer: Pointer): void
  hitGridPushScissorRect(renderer: Pointer, x: number, y: number, width: number, height: number): void
  hitGridPopScissorRect(renderer: Pointer): void
  hitGridClearScissorRects(renderer: Pointer): void
  addToCurrentHitGridClipped(renderer: Pointer, x: number, y: number, width: number, height: number, id: number): void
  checkHit(renderer: Pointer, x: number, y: number): number
  getHitGridDirty(renderer: Pointer): boolean
  dumpHitGrid(renderer: Pointer): void
}
```

### Clipboard Operations

```typescript
interface RenderLib {
  copyToClipboardOSC52(renderer: Pointer, target: number, payload: Uint8Array): boolean
  clearClipboardOSC52(renderer: Pointer, target: number): boolean
}
```

### NativeSpanFeed Operations

```typescript
interface RenderLib {
  registerNativeSpanFeedStream(stream: Pointer, handler: NativeSpanFeedEventHandler): void
  unregisterNativeSpanFeedStream(stream: Pointer): void
  createNativeSpanFeed(options?: NativeSpanFeedOptions | null): Pointer
  attachNativeSpanFeed(stream: Pointer): number
  destroyNativeSpanFeed(stream: Pointer): void
  streamWrite(stream: Pointer, data: Uint8Array | string): number
  streamCommit(stream: Pointer): number
  streamDrainSpans(stream: Pointer, outBuffer: Uint8Array, maxSpans: number): number
  streamClose(stream: Pointer): number
  streamSetOptions(stream: Pointer, options: NativeSpanFeedOptions): number
  streamGetStats(stream: Pointer): NativeSpanFeedStats | null
  streamReserve(stream: Pointer, minLen: number): {
    status: number; info: ReserveInfo | null
  }
  streamCommitReserved(stream: Pointer, length: number): number
}
```

### Syntax Style Operations

```typescript
interface RenderLib {
  createSyntaxStyle(): Pointer
  destroySyntaxStyle(style: Pointer): void
  syntaxStyleRegister(style: Pointer, name: string, fg: RGBA | null, bg: RGBA | null, attributes: number): number
  syntaxStyleResolveByName(style: Pointer, name: string): number | null
  syntaxStyleGetStyleCount(style: Pointer): number
}
```

### Utility Operations

```typescript
interface RenderLib {
  readonly encoder: TextEncoder
  readonly decoder: TextDecoder
  getArenaAllocatedBytes(): number
  getTerminalCapabilities(renderer: Pointer): any
  processCapabilityResponse(renderer: Pointer, response: string): void
  encodeUnicode(text: string, widthMethod: WidthMethod): {
    ptr: Pointer; data: Array<{ width: number; char: number }>
  } | null
  freeUnicode(encoded: { ptr: Pointer; data: Array<{ width: number; char: number }> }): void

  // Mouse
  enableMouse(renderer: Pointer, enableMovement: boolean): void
  disableMouse(renderer: Pointer): void

  // Kitty keyboard
  enableKittyKeyboard(renderer: Pointer, flags: number): void
  disableKittyKeyboard(renderer: Pointer): void
  setKittyKeyboardFlags(renderer: Pointer, flags: number): void
  getKittyKeyboardFlags(renderer: Pointer): number

  // Native events
  onNativeEvent(name: string, handler: (data: ArrayBuffer) => void): void
  onceNativeEvent(name: string, handler: (data: ArrayBuffer) => void): void
  offNativeEvent(name: string, handler: (data: ArrayBuffer) => void): void
  onAnyNativeEvent(handler: (name: string, data: ArrayBuffer) => void): void

  // Terminal
  setTerminalTitle(renderer: Pointer, title: string): void
  setDebugOverlay(renderer: Pointer, enabled: boolean, corner: DebugOverlayCorner): void
  setCursorPosition(renderer: Pointer, x: number, y: number, visible: boolean): void
  setCursorColor(renderer: Pointer, color: RGBA): void
  getCursorState(renderer: Pointer): CursorState
  setCursorStyleOptions(renderer: Pointer, options: CursorStyleOptions): void
  dumpBuffers(renderer: Pointer, timestamp?: number): void
  dumpStdoutBuffer(renderer: Pointer, timestamp?: number): void
}
```

---

## Related Documentation

- [Core API Reference](./core-api.md) -- Architecture overview and main concepts
- [Types Reference](./types.md) -- All shared types and interfaces
- [Buffer Reference](./buffer.md) -- Buffer, edit buffer, and text buffer systems
- [ANSI & Utilities Reference](./ansi-utils.md) -- ANSI codes, console, filters, utilities
