# TextBuffer and EditBuffer Components

`TextBufferRenderable` and `EditBufferRenderable` are abstract base classes for text display and text editing, respectively. They are not used directly but serve as the foundation for `TextRenderable`, `CodeRenderable`, `TextareaRenderable`, and `InputRenderable`.

**Import:** `import { TextBufferRenderable, EditBufferRenderable } from "@opentui/core"`

## TextBufferRenderable

Abstract base class for read-only text display with scroll, selection, and line wrapping. Extends `Renderable` and implements `LineInfoProvider`.

### Constructor

```typescript
// Abstract -- cannot be instantiated directly
new TextBufferRenderable(ctx: RenderContext, options: TextBufferOptions)
```

### Props

```typescript
interface TextBufferOptions extends RenderableOptions<TextBufferRenderable> {
  fg?: string | RGBA                   // Default foreground color
  bg?: string | RGBA                   // Default background color
  selectionBg?: string | RGBA          // Selection highlight background
  selectionFg?: string | RGBA          // Selection highlight foreground
  selectable?: boolean                 // Enable text selection (default: true)
  attributes?: number                  // Default text attributes bitmask
  wrapMode?: "none" | "char" | "word"  // Text wrapping mode
  tabIndicator?: string | number       // Tab display character or width
  tabIndicatorColor?: string | RGBA    // Color for tab indicators
  truncate?: boolean                   // Truncate overflowing text (default: false)
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fg` | `string \| RGBA` | Default fg | Foreground text color |
| `bg` | `string \| RGBA` | Default bg | Background color |
| `selectionBg` | `string \| RGBA` | - | Background when text selected |
| `selectionFg` | `string \| RGBA` | - | Foreground when text selected |
| `selectable` | `boolean` | `true` | Enable mouse text selection |
| `attributes` | `number` | `0` | Text attributes (bold, italic, etc.) |
| `wrapMode` | `"none" \| "char" \| "word"` | `"none"` | Text wrapping behavior |
| `tabIndicator` | `string \| number` | - | Tab display character or space count |
| `tabIndicatorColor` | `string \| RGBA` | - | Color of tab indicator |
| `truncate` | `boolean` | `false` | Truncate text at boundary |

### Properties & Methods

```typescript
abstract class TextBufferRenderable extends Renderable implements LineInfoProvider {
  selectable: boolean

  // Internal buffers
  protected textBuffer: TextBuffer
  protected textBufferView: TextBufferView

  // Text content
  get plainText(): string
  get textLength(): number

  // Line info
  get lineInfo(): LineInfo
  get lineCount(): number
  get virtualLineCount(): number    // Includes wrapped lines

  // Scroll
  get scrollY(): number
  set scrollY(value: number)
  get scrollX(): number
  set scrollX(value: number)
  get scrollWidth(): number
  get scrollHeight(): number
  get maxScrollY(): number
  get maxScrollX(): number

  // Colors
  get fg(): RGBA
  set fg(value: RGBA | string | undefined)
  get bg(): RGBA
  set bg(value: RGBA | string | undefined)

  // Selection colors
  get selectionBg(): RGBA | undefined
  set selectionBg(value: RGBA | string | undefined)
  get selectionFg(): RGBA | undefined
  set selectionFg(value: RGBA | string | undefined)

  // Attributes
  get attributes(): number
  set attributes(value: number)

  // Wrap & display
  get wrapMode(): "none" | "char" | "word"
  set wrapMode(value: "none" | "char" | "word")
  get tabIndicator(): string | number | undefined
  set tabIndicator(value: string | number | undefined)
  get tabIndicatorColor(): RGBA | undefined
  set tabIndicatorColor(value: RGBA | string | undefined)
  get truncate(): boolean
  set truncate(value: boolean)

  // Selection
  shouldStartSelection(x: number, y: number): boolean
  onSelectionChanged(selection: Selection | null): boolean
  getSelectedText(): string
  hasSelection(): boolean
  getSelection(): { start: number; end: number } | null

  // Hooks for subclasses
  protected onFgChanged(newColor: RGBA): void
  protected onBgChanged(newColor: RGBA): void
  protected onAttributesChanged(newAttributes: number): void
}
```

### Subclasses

- **TextRenderable** -- adds StyledText content and TextNode tree
- **CodeRenderable** -- adds syntax highlighting via Tree-sitter

---

## EditBufferRenderable

Abstract base class for editable text with cursor, selection, undo/redo, and highlight management. Extends `Renderable` and implements `LineInfoProvider`.

### Constructor

```typescript
// Abstract -- cannot be instantiated directly
new EditBufferRenderable(ctx: RenderContext, options: EditBufferOptions)
```

### Props

```typescript
interface EditBufferOptions extends RenderableOptions<EditBufferRenderable> {
  textColor?: string | RGBA
  backgroundColor?: string | RGBA
  selectionBg?: string | RGBA
  selectionFg?: string | RGBA
  selectable?: boolean
  attributes?: number
  wrapMode?: "none" | "char" | "word"
  scrollMargin?: number
  scrollSpeed?: number
  showCursor?: boolean
  cursorColor?: string | RGBA
  cursorStyle?: CursorStyleOptions
  syntaxStyle?: SyntaxStyle
  tabIndicator?: string | number
  tabIndicatorColor?: string | RGBA
  onCursorChange?: (event: CursorChangeEvent) => void
  onContentChange?: (event: ContentChangeEvent) => void
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `textColor` | `string \| RGBA` | Default fg | Text color |
| `backgroundColor` | `string \| RGBA` | `""` | Background color |
| `selectionBg` | `string \| RGBA` | - | Selection background |
| `selectionFg` | `string \| RGBA` | - | Selection foreground |
| `selectable` | `boolean` | `true` | Enable mouse text selection |
| `attributes` | `number` | `0` | Default text attributes |
| `wrapMode` | `"none" \| "char" \| "word"` | `"none"` | Text wrapping |
| `scrollMargin` | `number` | - | Lines to keep visible around cursor |
| `scrollSpeed` | `number` | - | Scroll speed multiplier |
| `showCursor` | `boolean` | `true` | Show the cursor |
| `cursorColor` | `string \| RGBA` | Default | Cursor color |
| `cursorStyle` | `CursorStyleOptions` | `{ style: "block", blinking: true }` | Cursor appearance |
| `syntaxStyle` | `SyntaxStyle` | - | Syntax highlighting theme |
| `tabIndicator` | `string \| number` | - | Tab display |
| `tabIndicatorColor` | `string \| RGBA` | - | Tab indicator color |
| `onCursorChange` | `(e: CursorChangeEvent) => void` | - | Cursor moved callback |
| `onContentChange` | `(e: ContentChangeEvent) => void` | - | Content changed callback |

### Events

```typescript
interface CursorChangeEvent {
  line: number
  visualColumn: number
}

interface ContentChangeEvent {}
```

### Properties & Methods

```typescript
abstract class EditBufferRenderable extends Renderable implements LineInfoProvider {
  // Internal buffers (read-only access)
  readonly editBuffer: EditBuffer
  readonly editorView: EditorView

  // Content
  get plainText(): string
  get lineCount(): number
  get virtualLineCount(): number
  get scrollY(): number
  get lineInfo(): LineInfo

  // Cursor
  get logicalCursor(): LogicalCursor
  get visualCursor(): VisualCursor
  get cursorOffset(): number
  set cursorOffset(offset: number)

  // Colors
  get textColor(): RGBA
  set textColor(value: RGBA | string | undefined)
  get backgroundColor(): RGBA
  set backgroundColor(value: RGBA | string | undefined)
  get selectionBg(): RGBA | undefined
  set selectionBg(value: RGBA | string | undefined)
  get selectionFg(): RGBA | undefined
  set selectionFg(value: RGBA | string | undefined)
  get attributes(): number
  set attributes(value: number)

  // Cursor display
  get showCursor(): boolean
  set showCursor(value: boolean)
  get cursorColor(): RGBA
  set cursorColor(value: RGBA | string)
  get cursorStyle(): CursorStyleOptions
  set cursorStyle(style: CursorStyleOptions)

  // Wrap & display
  get wrapMode(): "none" | "char" | "word"
  set wrapMode(value: "none" | "char" | "word")
  get tabIndicator(): string | number | undefined
  set tabIndicator(value: string | number | undefined)
  get tabIndicatorColor(): RGBA | undefined
  set tabIndicatorColor(value: RGBA | string | undefined)

  // Scroll
  get scrollSpeed(): number
  set scrollSpeed(value: number)

  // Selection
  shouldStartSelection(x: number, y: number): boolean
  onSelectionChanged(selection: Selection | null): boolean
  getSelectedText(): string
  hasSelection(): boolean
  getSelection(): { start: number; end: number } | null

  // Text manipulation
  setText(text: string): void           // Reset completely (clears undo history)
  replaceText(text: string): void       // Replace with undo support
  clear(): void
  insertText(text: string): void        // Insert at cursor
  deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void
  getTextRange(startOffset: number, endOffset: number): string
  getTextRangeByCoords(startRow: number, startCol: number, endRow: number, endCol: number): string

  // Highlight management
  addHighlight(lineIdx: number, highlight: Highlight): void
  addHighlightByCharRange(highlight: Highlight): void
  removeHighlightsByRef(hlRef: number): void
  clearLineHighlights(lineIdx: number): void
  clearAllHighlights(): void
  getLineHighlights(lineIdx: number): Array<Highlight>

  // Syntax style
  get syntaxStyle(): SyntaxStyle | null
  set syntaxStyle(style: SyntaxStyle | null)

  // Event callbacks
  set onCursorChange(handler: ((event: CursorChangeEvent) => void) | undefined)
  get onCursorChange(): ((event: CursorChangeEvent) => void) | undefined
  set onContentChange(handler: ((event: ContentChangeEvent) => void) | undefined)
  get onContentChange(): ((event: ContentChangeEvent) => void) | undefined

  // Focus
  focus(): void
  blur(): void
}
```

### Subclasses

- **TextareaRenderable** -- adds placeholder, key bindings, color states, submit action
- **InputRenderable** -- extends TextareaRenderable with single-line constraints

## Key Differences

| Feature | TextBufferRenderable | EditBufferRenderable |
|---------|---------------------|---------------------|
| Content | Read-only display | Editable with cursor |
| Cursor | No cursor | Full cursor with styles |
| Undo/Redo | No | Yes (via EditBuffer) |
| Highlights | No | Yes (addHighlight, etc.) |
| Scroll | Yes (scrollX, scrollY) | Yes (with scrollMargin) |
| Selection | Mouse selection | Mouse + keyboard selection |
| Used by | TextRenderable, CodeRenderable | TextareaRenderable, InputRenderable |

## Related Components

- [Text](./text.md) -- extends TextBufferRenderable
- [Code](./code.md) -- extends TextBufferRenderable
- [Textarea](./textarea.md) -- extends EditBufferRenderable
- [Input](./input.md) -- extends TextareaRenderable (which extends EditBufferRenderable)
- [LineNumbers](./line-numbers.md) -- consumes LineInfoProvider
