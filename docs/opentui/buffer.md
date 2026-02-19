# Buffer Reference

The buffer system in `@opentui/core` provides the drawing surface for terminal rendering. It includes `OptimizedBuffer` for cell-level rendering, `EditBuffer` for editable text with cursor and undo support, `TextBufferView` for read-only wrapped text display, and `EditorView` for editable text with viewport scrolling.

## Table of Contents

- [OptimizedBuffer](#optimizedbuffer)
  - [Creation](#creation)
  - [Properties](#properties)
  - [Cell Operations](#cell-operations)
  - [Text Drawing](#text-drawing)
  - [Rectangle Operations](#rectangle-operations)
  - [Box Drawing](#box-drawing)
  - [Buffer Composition](#buffer-composition)
  - [Scissor Rects](#scissor-rects)
  - [Opacity Stack](#opacity-stack)
  - [Text Buffer Rendering](#text-buffer-rendering)
  - [Advanced Rendering](#advanced-rendering)
  - [Unicode Encoding](#unicode-encoding)
  - [Raw Buffer Access](#raw-buffer-access)
  - [Lifecycle](#lifecycle)
- [EditBuffer](#editbuffer)
  - [Creation](#editbuffer-creation)
  - [Text Operations](#text-operations)
  - [Cursor Movement](#cursor-movement)
  - [Cursor Position](#cursor-position)
  - [Word Navigation](#word-navigation)
  - [Text Ranges](#text-ranges)
  - [Undo / Redo](#undo--redo)
  - [Styling](#styling)
  - [Highlights](#highlights)
  - [Lifecycle](#editbuffer-lifecycle)
- [TextBufferView](#textbufferview)
  - [Creation](#textbufferview-creation)
  - [Viewport & Wrap](#viewport--wrap)
  - [Selection](#textbufferview-selection)
  - [Text Extraction](#text-extraction)
  - [Line Info](#line-info)
  - [Measurement](#measurement)
  - [Display Options](#display-options)
- [EditorView](#editorview)
  - [Creation](#editorview-creation)
  - [Viewport Management](#viewport-management)
  - [Cursor](#editorview-cursor)
  - [Selection](#editorview-selection)
  - [Navigation](#navigation)
  - [Line Info](#editorview-line-info)
  - [Placeholder Text](#placeholder-text)
  - [Display Options](#editorview-display-options)
  - [Measurement](#editorview-measurement)
- [NativeSpanFeed](#nativespanfeed)
- [Relationship Between Buffer Types](#relationship-between-buffer-types)
- [Related Documentation](#related-documentation)

---

## OptimizedBuffer

The primary rendering surface. Each cell stores a character (u32), foreground color (RGBA as 4 floats), background color (RGBA as 4 floats), and attributes (u32 bitmask). All operations are backed by native Zig code via FFI for performance.

### Creation

```typescript
class OptimizedBuffer {
  constructor(
    lib: RenderLib,
    ptr: Pointer,
    width: number,
    height: number,
    options: {
      respectAlpha?: boolean
      id?: string
      widthMethod?: WidthMethod
    }
  )

  static create(
    width: number,
    height: number,
    widthMethod: WidthMethod,
    options?: { respectAlpha?: boolean; id?: string }
  ): OptimizedBuffer
}
```

Typically you do not create buffers directly. The renderer creates them, and they are passed to `renderSelf()`. For off-screen rendering (frame buffers), use `OptimizedBuffer.create()`.

### Properties

```typescript
get ptr(): Pointer              // Native buffer pointer
get width(): number             // Buffer width in cells
get height(): number            // Buffer height in cells
get widthMethod(): WidthMethod  // "wcwidth" or "unicode"
respectAlpha: boolean           // Whether alpha blending is enabled
id: string                      // Buffer identifier

get buffers(): {
  char: Uint32Array             // Character codepoints (width * height)
  fg: Float32Array              // Foreground RGBA (width * height * 4)
  bg: Float32Array              // Background RGBA (width * height * 4)
  attributes: Uint32Array       // Attribute bitmasks (width * height)
}
```

### Cell Operations

```typescript
// Set a single cell (overwrites)
setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes?: number): void

// Set a cell with alpha blending against the existing background
setCellWithAlphaBlending(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes?: number): void

// Draw a single character by codepoint
drawChar(char: number, x: number, y: number, fg: RGBA, bg: RGBA, attributes?: number): void
```

### Text Drawing

```typescript
drawText(
  text: string,
  x: number,
  y: number,
  fg: RGBA,
  bg?: RGBA,
  attributes?: number,
  selection?: {
    start: number
    end: number
    bgColor?: RGBA
    fgColor?: RGBA
  } | null
): void
```

Draws a string starting at `(x, y)`. Handles wide characters (CJK), tab characters, and optional selection highlighting within the text.

### Rectangle Operations

```typescript
// Fill a rectangular region with a background color
fillRect(x: number, y: number, width: number, height: number, bg: RGBA): void

// Clear the entire buffer (optionally with a background color)
clear(bg?: RGBA): void
```

### Box Drawing

```typescript
drawBox(options: {
  x: number
  y: number
  width: number
  height: number
  borderStyle?: BorderStyle       // e.g., "single", "double", "rounded", "heavy"
  customBorderChars?: Uint32Array // Custom border character codepoints
  border: boolean | BorderSides[] // true for all sides, or specify ["top", "bottom", ...]
  borderColor: RGBA
  backgroundColor: RGBA
  shouldFill?: boolean            // Fill interior with backgroundColor
  title?: string                  // Title text in top border
  titleAlignment?: "left" | "center" | "right"
}): void
```

### Buffer Composition

```typescript
// Draw another buffer onto this buffer at the given position
drawFrameBuffer(
  destX: number,
  destY: number,
  frameBuffer: OptimizedBuffer,
  sourceX?: number,
  sourceY?: number,
  sourceWidth?: number,
  sourceHeight?: number
): void
```

### Scissor Rects

Scissor rects clip all drawing operations to a rectangular region. They use a stack.

```typescript
pushScissorRect(x: number, y: number, width: number, height: number): void
popScissorRect(): void
clearScissorRects(): void
```

### Opacity Stack

Opacity values are multiplied onto colors during drawing. They use a stack.

```typescript
pushOpacity(opacity: number): void
popOpacity(): void
getCurrentOpacity(): number
clearOpacity(): void
```

### Text Buffer Rendering

```typescript
// Render a TextBufferView (read-only text with wrapping) at the given position
drawTextBuffer(textBufferView: TextBufferView, x: number, y: number): void

// Render an EditorView (editable text with viewport) at the given position
drawEditorView(editorView: EditorView, x: number, y: number): void
```

### Advanced Rendering

For graphics and 3D content:

```typescript
// Draw a supersampled pixel buffer (e.g., from WebGPU)
drawSuperSampleBuffer(
  x: number, y: number,
  pixelDataPtr: Pointer,
  pixelDataLength: number,
  format: "bgra8unorm" | "rgba8unorm",
  alignedBytesPerRow: number
): void

// Draw a packed buffer (compressed terminal data)
drawPackedBuffer(
  dataPtr: Pointer, dataLen: number,
  posX: number, posY: number,
  terminalWidthCells: number, terminalHeightCells: number
): void

// Draw grayscale intensity data (normal resolution)
drawGrayscaleBuffer(
  posX: number, posY: number,
  intensities: Float32Array,
  srcWidth: number, srcHeight: number,
  fg?: RGBA | null, bg?: RGBA | null
): void

// Draw grayscale intensity data (2x2 supersampled using block characters)
drawGrayscaleBufferSupersampled(
  posX: number, posY: number,
  intensities: Float32Array,
  srcWidth: number, srcHeight: number,
  fg?: RGBA | null, bg?: RGBA | null
): void
```

### Unicode Encoding

```typescript
// Encode a string to native unicode representation with width info
encodeUnicode(text: string): {
  ptr: Pointer
  data: Array<{ width: number; char: number }>
} | null

// Free encoded unicode data
freeUnicode(encoded: {
  ptr: Pointer
  data: Array<{ width: number; char: number }>
}): void
```

### Raw Buffer Access

```typescript
// Get the raw byte representation of characters
getRealCharBytes(addLineBreaks?: boolean): Uint8Array

// Get styled span data for each line
getSpanLines(): CapturedLine[]

// Set alpha blending mode
setRespectAlpha(respectAlpha: boolean): void

// Get native buffer ID
getNativeId(): string
```

### Lifecycle

```typescript
resize(width: number, height: number): void
destroy(): void
```

---

## EditBuffer

A text editing buffer backed by a native rope data structure. Provides cursor management, incremental editing, grapheme-aware operations, undo/redo, and syntax highlighting support.

### EditBuffer Creation

```typescript
class EditBuffer extends EventEmitter {
  constructor(lib: RenderLib, ptr: Pointer)

  static create(widthMethod: WidthMethod): EditBuffer

  get ptr(): Pointer
  readonly id: number
}
```

### Text Operations

```typescript
// Set text and reset buffer state (clears history)
setText(text: string): void

// Set text using owned memory (native takes ownership, clears history)
setTextOwned(text: string): void

// Replace text while preserving undo history (creates undo point)
replaceText(text: string): void

// Replace text using owned memory while preserving undo history
replaceTextOwned(text: string): void

// Get the full text content
getText(): string

// Get line count
getLineCount(): number

// Insert a single character at cursor
insertChar(char: string): void

// Insert text at cursor
insertText(text: string): void

// Delete character at cursor (forward delete)
deleteChar(): void

// Delete character before cursor (backspace)
deleteCharBackward(): void

// Delete a range by line/column coordinates
deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void

// Insert a newline at cursor
newLine(): void

// Delete the current line
deleteLine(): void

// Clear all content
clear(): void
```

### Cursor Movement

```typescript
moveCursorLeft(): void
moveCursorRight(): void
moveCursorUp(): void
moveCursorDown(): void
gotoLine(line: number): void
setCursor(line: number, col: number): void
setCursorToLineCol(line: number, col: number): void
setCursorByOffset(offset: number): void
```

### Cursor Position

```typescript
getCursorPosition(): LogicalCursor
// Returns: { row: number; col: number; offset: number }
```

### Word Navigation

```typescript
getNextWordBoundary(): LogicalCursor
getPrevWordBoundary(): LogicalCursor
getEOL(): LogicalCursor
```

### Text Ranges

```typescript
// Convert between offsets and positions
offsetToPosition(offset: number): { row: number; col: number } | null
positionToOffset(row: number, col: number): number
getLineStartOffset(row: number): number

// Extract text by offset range
getTextRange(startOffset: number, endOffset: number): string

// Extract text by coordinate range
getTextRangeByCoords(startRow: number, startCol: number, endRow: number, endCol: number): string
```

### Undo / Redo

```typescript
undo(): string | null         // Returns the new text, or null if nothing to undo
redo(): string | null         // Returns the new text, or null if nothing to redo
canUndo(): boolean
canRedo(): boolean
clearHistory(): void
```

### Styling

```typescript
setDefaultFg(fg: RGBA | null): void
setDefaultBg(bg: RGBA | null): void
setDefaultAttributes(attributes: number | null): void
resetDefaults(): void
setSyntaxStyle(style: SyntaxStyle | null): void
getSyntaxStyle(): SyntaxStyle | null
```

### Highlights

```typescript
addHighlight(lineIdx: number, highlight: Highlight): void
addHighlightByCharRange(highlight: Highlight): void
removeHighlightsByRef(hlRef: number): void
clearLineHighlights(lineIdx: number): void
clearAllHighlights(): void
getLineHighlights(lineIdx: number): Array<Highlight>
```

### EditBuffer Lifecycle

```typescript
destroy(): void
debugLogRope(): void    // Debug: log the internal rope structure
```

---

## TextBufferView

A read-only view over a `TextBuffer` that provides text wrapping, viewport management, selection, and measurement. Used for displaying non-editable text content like log output or static text blocks.

### TextBufferView Creation

```typescript
class TextBufferView {
  constructor(lib: RenderLib, ptr: Pointer, textBuffer: TextBuffer)

  static create(textBuffer: TextBuffer): TextBufferView

  get ptr(): Pointer
}
```

### Viewport & Wrap

```typescript
// Set the viewport size (what area is visible)
setViewportSize(width: number, height: number): void

// Set the viewport position and size
setViewport(x: number, y: number, width: number, height: number): void

// Set wrap width (null to disable)
setWrapWidth(width: number | null): void

// Set wrap mode
setWrapMode(mode: "none" | "char" | "word"): void
```

### TextBufferView Selection

```typescript
// Set selection by character offsets
setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void

// Extend selection to new end point
updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void

// Clear selection
resetSelection(): void

// Get selection range
getSelection(): { start: number; end: number } | null

// Check if selection exists
hasSelection(): boolean

// Set selection by viewport-local coordinates
setLocalSelection(anchorX: number, anchorY: number, focusX: number, focusY: number,
  bgColor?: RGBA, fgColor?: RGBA): boolean

// Update viewport-local selection
updateLocalSelection(anchorX: number, anchorY: number, focusX: number, focusY: number,
  bgColor?: RGBA, fgColor?: RGBA): boolean

// Clear viewport-local selection
resetLocalSelection(): void
```

### Text Extraction

```typescript
getSelectedText(): string
getPlainText(): string
```

### Line Info

```typescript
get lineInfo(): LineInfo               // Visual (wrapped) line info
get logicalLineInfo(): LineInfo        // Logical (unwrapped) line info
getVirtualLineCount(): number          // Total visual line count
```

### Measurement

```typescript
// Measure how many lines and what max width a given viewport would produce
measureForDimensions(width: number, height: number): {
  lineCount: number
  maxWidth: number
} | null
```

### Display Options

```typescript
setTabIndicator(indicator: string | number): void
setTabIndicatorColor(color: RGBA): void
setTruncate(truncate: boolean): void
```

### TextBufferView Lifecycle

```typescript
destroy(): void
```

---

## EditorView

A viewport over an `EditBuffer` that provides scrolling, visual cursor tracking, selection, and word-level navigation. This is the primary component for building text editors.

### EditorView Creation

```typescript
class EditorView {
  constructor(lib: RenderLib, ptr: Pointer, editBuffer: EditBuffer)

  static create(editBuffer: EditBuffer, viewportWidth: number, viewportHeight: number): EditorView

  get ptr(): Pointer
}
```

### Viewport Management

```typescript
setViewportSize(width: number, height: number): void
setViewport(x: number, y: number, width: number, height: number, moveCursor?: boolean): void
getViewport(): Viewport    // { offsetY, offsetX, height, width }
setScrollMargin(margin: number): void
setWrapMode(mode: "none" | "char" | "word"): void
getVirtualLineCount(): number
getTotalVirtualLineCount(): number
```

### EditorView Cursor

```typescript
// Get logical cursor position
getCursor(): { row: number; col: number }

// Get visual cursor (viewport-relative + logical)
getVisualCursor(): VisualCursor

// Move cursor by visual lines (handles wrapped lines)
moveUpVisual(): void
moveDownVisual(): void

// Set cursor by byte offset
setCursorByOffset(offset: number): void
```

### EditorView Selection

```typescript
// Offset-based selection
setSelection(start: number, end: number, bgColor?: RGBA, fgColor?: RGBA): void
updateSelection(end: number, bgColor?: RGBA, fgColor?: RGBA): void
resetSelection(): void
getSelection(): { start: number; end: number } | null
hasSelection(): boolean

// Coordinate-based (local) selection
setLocalSelection(
  anchorX: number, anchorY: number,
  focusX: number, focusY: number,
  bgColor?: RGBA, fgColor?: RGBA,
  updateCursor?: boolean, followCursor?: boolean
): boolean

updateLocalSelection(
  anchorX: number, anchorY: number,
  focusX: number, focusY: number,
  bgColor?: RGBA, fgColor?: RGBA,
  updateCursor?: boolean, followCursor?: boolean
): boolean

resetLocalSelection(): void

// Get selected text content
getSelectedText(): string

// Delete selected text
deleteSelectedText(): void

// Get full text content via view
getText(): string
```

### Navigation

```typescript
getNextWordBoundary(): VisualCursor
getPrevWordBoundary(): VisualCursor
getEOL(): VisualCursor
getVisualSOL(): VisualCursor      // Start of visual (wrapped) line
getVisualEOL(): VisualCursor      // End of visual (wrapped) line
```

### EditorView Line Info

```typescript
getLineInfo(): LineInfo            // Visual (wrapped) line info
getLogicalLineInfo(): LineInfo     // Logical (unwrapped) line info
```

### Placeholder Text

```typescript
setPlaceholderStyledText(chunks: {
  text: string
  fg?: RGBA
  bg?: RGBA
  attributes?: number
}[]): void
```

### EditorView Display Options

```typescript
setTabIndicator(indicator: string | number): void
setTabIndicatorColor(color: RGBA): void
get extmarks(): any     // Extension marks controller (for inline decorations)
```

### EditorView Measurement

```typescript
measureForDimensions(width: number, height: number): {
  lineCount: number
  maxWidth: number
} | null
```

### EditorView Lifecycle

```typescript
destroy(): void
```

---

## NativeSpanFeed

A zero-copy wrapper over Zig-managed memory for streaming span data. Used for high-performance text streaming scenarios where data flows from native code to TypeScript handlers.

```typescript
class NativeSpanFeed {
  // Create a new NativeSpanFeed
  static create(options?: NativeSpanFeedOptions): NativeSpanFeed

  // Attach to an existing native stream pointer
  static attach(streamPtr: bigint | number, options?: NativeSpanFeedOptions): NativeSpanFeed

  readonly streamPtr: Pointer

  // Register a data handler. Returns an unsubscribe function.
  onData(handler: DataHandler): () => void

  // Register an error handler. Returns an unsubscribe function.
  onError(handler: (code: number) => void): () => void

  // Close the feed
  close(): void

  // Drain all pending data
  drainAll(): void
}

type DataHandler = (data: Uint8Array) => void | Promise<void>
```

Exported types from `zig-structs`:

```typescript
export type { GrowthPolicy, NativeSpanFeedOptions, NativeSpanFeedStats }
```

---

## Relationship Between Buffer Types

```
TextBuffer (native rope)
    |
    +-- TextBufferView (read-only, wrapping, viewport)
    |       |
    |       +-- buffer.drawTextBuffer(view, x, y)
    |
EditBuffer (editable, cursor, undo) -- wraps a TextBuffer internally
    |
    +-- EditorView (editable, viewport, scroll, visual cursor)
            |
            +-- buffer.drawEditorView(view, x, y)

OptimizedBuffer (cell grid)
    |
    +-- Used by renderSelf() to draw content
    +-- Supports drawTextBuffer() and drawEditorView()
    +-- Used by CliRenderer for double-buffered output
```

- **TextBuffer** is the underlying native text storage (rope-based). You do not typically use it directly.
- **TextBufferView** wraps a TextBuffer for read-only display with wrapping and selection.
- **EditBuffer** wraps a TextBuffer with editing capabilities (insert, delete, cursor, undo/redo).
- **EditorView** wraps an EditBuffer with viewport scrolling, visual cursor, and word navigation.
- **OptimizedBuffer** is the terminal cell grid. It can draw TextBufferView and EditorView contents.

---

## Related Documentation

- [Core API Reference](./core-api.md) -- Architecture overview and main concepts
- [Types Reference](./types.md) -- All shared types and interfaces
- [Renderer Reference](./renderer.md) -- Renderer pipeline and native layer
- [ANSI & Utilities Reference](./ansi-utils.md) -- ANSI codes, console, filters, utilities
