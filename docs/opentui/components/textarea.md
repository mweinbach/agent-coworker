# Textarea Component

`TextareaRenderable` provides multi-line text editing with cursor navigation, selection, undo/redo, and customizable key bindings. It extends `EditBufferRenderable`.

**Import:** `import { TextareaRenderable } from "@opentui/core"`

## Constructor

```typescript
new TextareaRenderable(ctx: RenderContext, options: TextareaOptions)
```

## Props

```typescript
interface TextareaOptions extends EditBufferOptions {
  initialValue?: string
  backgroundColor?: ColorInput
  textColor?: ColorInput
  focusedBackgroundColor?: ColorInput
  focusedTextColor?: ColorInput
  placeholder?: StyledText | string | null
  placeholderColor?: ColorInput
  keyBindings?: KeyBinding[]
  keyAliasMap?: KeyAliasMap
  onSubmit?: (event: SubmitEvent) => void
}
```

`EditBufferOptions` provides:

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
| `initialValue` | `string` | `""` | Initial text content |
| `backgroundColor` | `ColorInput` | - | Background color (unfocused) |
| `textColor` | `ColorInput` | - | Text color (unfocused) |
| `focusedBackgroundColor` | `ColorInput` | - | Background color when focused |
| `focusedTextColor` | `ColorInput` | - | Text color when focused |
| `placeholder` | `StyledText \| string \| null` | - | Placeholder shown when empty |
| `placeholderColor` | `ColorInput` | - | Placeholder text color |
| `keyBindings` | `KeyBinding[]` | - | Custom key bindings |
| `keyAliasMap` | `KeyAliasMap` | - | Key alias mapping |
| `onSubmit` | `(event: SubmitEvent) => void` | - | Submit callback |
| `selectionBg` | `ColorInput` | - | Selection background |
| `selectionFg` | `ColorInput` | - | Selection foreground |
| `wrapMode` | `"none" \| "char" \| "word"` | `"none"` | Text wrapping mode |
| `scrollMargin` | `number` | - | Lines to keep visible around cursor |
| `scrollSpeed` | `number` | - | Scroll speed multiplier |
| `showCursor` | `boolean` | `true` | Show the cursor |
| `cursorColor` | `ColorInput` | - | Cursor color |
| `cursorStyle` | `CursorStyleOptions` | `{ style: "block", blinking: true }` | Cursor appearance |
| `syntaxStyle` | `SyntaxStyle` | - | Syntax highlighting style |
| `tabIndicator` | `string \| number` | - | Tab display character/width |
| `tabIndicatorColor` | `ColorInput` | - | Tab indicator color |
| `onCursorChange` | `(e: CursorChangeEvent) => void` | - | Cursor position changed |
| `onContentChange` | `(e: ContentChangeEvent) => void` | - | Content changed |

## Events

```typescript
interface CursorChangeEvent {
  line: number
  visualColumn: number
}

interface ContentChangeEvent {}

interface SubmitEvent {}
```

## Actions

All available key-bindable actions:

```typescript
type TextareaAction =
  | "move-left" | "move-right" | "move-up" | "move-down"
  | "select-left" | "select-right" | "select-up" | "select-down"
  | "line-home" | "line-end"
  | "select-line-home" | "select-line-end"
  | "visual-line-home" | "visual-line-end"
  | "select-visual-line-home" | "select-visual-line-end"
  | "buffer-home" | "buffer-end"
  | "select-buffer-home" | "select-buffer-end"
  | "delete-line" | "delete-to-line-end" | "delete-to-line-start"
  | "backspace" | "delete" | "newline"
  | "undo" | "redo"
  | "word-forward" | "word-backward"
  | "select-word-forward" | "select-word-backward"
  | "delete-word-forward" | "delete-word-backward"
  | "select-all" | "submit"
```

## Properties & Methods

```typescript
class TextareaRenderable extends EditBufferRenderable {
  // Placeholder
  get placeholder(): StyledText | string | null
  set placeholder(value: StyledText | string | null)
  get placeholderColor(): RGBA
  set placeholderColor(value: ColorInput)

  // Colors
  get backgroundColor(): RGBA
  set backgroundColor(value: RGBA | string | undefined)
  get textColor(): RGBA
  set textColor(value: RGBA | string | undefined)
  set focusedBackgroundColor(value: ColorInput)
  set focusedTextColor(value: ColorInput)

  // Cursor movement
  moveCursorLeft(options?: { select?: boolean }): boolean
  moveCursorRight(options?: { select?: boolean }): boolean
  moveCursorUp(options?: { select?: boolean }): boolean
  moveCursorDown(options?: { select?: boolean }): boolean
  gotoLine(line: number): void
  gotoLineHome(options?: { select?: boolean }): boolean
  gotoLineEnd(options?: { select?: boolean }): boolean
  gotoVisualLineHome(options?: { select?: boolean }): boolean
  gotoVisualLineEnd(options?: { select?: boolean }): boolean
  gotoBufferHome(options?: { select?: boolean }): boolean
  gotoBufferEnd(options?: { select?: boolean }): boolean
  moveWordForward(options?: { select?: boolean }): boolean
  moveWordBackward(options?: { select?: boolean }): boolean

  // Text editing
  insertChar(char: string): void
  insertText(text: string): void
  deleteChar(): boolean
  deleteCharBackward(): boolean
  newLine(): boolean
  deleteLine(): boolean
  deleteToLineEnd(): boolean
  deleteToLineStart(): boolean
  deleteWordForward(): boolean
  deleteWordBackward(): boolean
  selectAll(): boolean

  // Undo/Redo
  undo(): boolean
  redo(): boolean

  // Focus & submission
  focus(): void
  blur(): void
  submit(): boolean

  // Input handling
  handlePaste(event: PasteEvent): void
  handleKeyPress(key: KeyEvent): boolean

  // Configuration
  set initialValue(value: string)
  set onSubmit(handler: ((event: SubmitEvent) => void) | undefined)
  get onSubmit(): ((event: SubmitEvent) => void) | undefined
  set keyBindings(bindings: KeyBinding[])
  set keyAliasMap(aliases: KeyAliasMap)

  // Extmarks (decorations/highlights)
  get extmarks(): ExtmarksController

  // Inherited from EditBufferRenderable
  readonly editBuffer: EditBuffer
  readonly editorView: EditorView
  get plainText(): string
  get lineCount(): number
  get virtualLineCount(): number
  get scrollY(): number
  get logicalCursor(): LogicalCursor
  get visualCursor(): VisualCursor
  get cursorOffset(): number
  set cursorOffset(offset: number)
  getSelectedText(): string
  hasSelection(): boolean
  getSelection(): { start: number; end: number } | null
  setText(text: string): void         // Reset buffer completely
  replaceText(text: string): void     // Replace with undo support
  clear(): void
  deleteRange(startLine: number, startCol: number, endLine: number, endCol: number): void
  insertText(text: string): void
  getTextRange(startOffset: number, endOffset: number): string
  getTextRangeByCoords(startRow: number, startCol: number, endRow: number, endCol: number): string

  // Highlight management
  addHighlight(lineIdx: number, highlight: Highlight): void
  addHighlightByCharRange(highlight: Highlight): void
  removeHighlightsByRef(hlRef: number): void
  clearLineHighlights(lineIdx: number): void
  clearAllHighlights(): void
  getLineHighlights(lineIdx: number): Array<Highlight>
}
```

## Examples

### Basic Textarea

```tsx
<textarea initialValue="Initial content" placeholder="Type here..." />
```

### With Change Tracking

```tsx
<textarea
  onCursorChange={(e) => {
    console.log(`Line ${e.line}, Column ${e.visualColumn}`)
  }}
  onContentChange={() => {
    console.log("Content changed")
  }}
/>
```

### Word Wrapping

```tsx
<textarea wrapMode="word" width={60} />
```

### Custom Key Bindings

```tsx
const keyBindings = [
  { key: "s", ctrl: true, action: "submit" },
  { key: "d", ctrl: true, action: "select-all" },
]

<textarea keyBindings={keyBindings} />
```

### Imperative Usage

```typescript
import { TextareaRenderable } from "@opentui/core"

const textarea = new TextareaRenderable(ctx, {
  initialValue: "Hello\nWorld",
  wrapMode: "word",
  placeholder: "Enter text...",
})

textarea.onCursorChange = (e) => {
  console.log(`Cursor at line ${e.line}`)
}

// Get content
const text = textarea.plainText

// Insert at cursor
textarea.insertText("More text")

// Navigate
textarea.moveCursorDown()
textarea.gotoLine(5)

// Selection
textarea.selectAll()
const selected = textarea.getSelectedText()

// Undo/Redo
textarea.undo()
textarea.redo()

// Replace all text (undoable)
textarea.replaceText("New content entirely")

// Reset (clears undo history)
textarea.setText("Clean slate")
```

### Extmarks (Decorations)

```typescript
const extmarks = textarea.extmarks

// Add an extmark highlight
const id = extmarks.create({
  start: 0,
  end: 10,
  styleId: errorStyleId,
})

// Remove
extmarks.delete(id)
```

## Default Key Bindings

| Key | Action |
|-----|--------|
| Arrow keys | Move cursor |
| Shift + Arrows | Select while moving |
| Home/End | Line start/end |
| Ctrl+Home/End | Buffer start/end |
| Ctrl+Left/Right | Word navigation |
| Shift+Ctrl+Left/Right | Word selection |
| Backspace | Delete char backward |
| Delete | Delete char forward |
| Ctrl+Backspace | Delete word backward |
| Ctrl+Delete | Delete word forward |
| Ctrl+K | Delete to line end |
| Ctrl+U | Delete to line start |
| Ctrl+A | Select all |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Enter | New line |

## Related Components

- [Input](./input.md) -- single-line variant, extends TextareaRenderable
- [TextBuffer](./text-buffer.md) -- underlying EditBufferRenderable base class
- [Code](./code.md) -- code display using the same text buffer system
