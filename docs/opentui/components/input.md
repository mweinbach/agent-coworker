# Input Component

`InputRenderable` provides a single-line text input. It extends `TextareaRenderable` with single-line constraints: height is always 1, newlines are stripped, and Enter submits instead of inserting a newline.

**Import:** `import { InputRenderable, InputRenderableEvents } from "@opentui/core"`

## Constructor

```typescript
new InputRenderable(ctx: RenderContext, options: InputRenderableOptions)
```

## Props

```typescript
interface InputRenderableOptions extends Omit<TextareaOptions, "height" | "minHeight" | "maxHeight" | "initialValue"> {
  value?: string           // Initial text value (newlines stripped)
  maxLength?: number       // Maximum character count
  placeholder?: string     // Placeholder text (string only, not StyledText)
}
```

All props from `TextareaOptions` are available except `height`, `minHeight`, and `maxHeight` (fixed to 1):

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `string` | `""` | Initial/current text value |
| `maxLength` | `number` | - | Maximum number of characters allowed |
| `placeholder` | `string` | - | Placeholder text shown when empty |
| `backgroundColor` | `ColorInput` | - | Background color |
| `textColor` | `ColorInput` | - | Text color |
| `focusedBackgroundColor` | `ColorInput` | - | Background when focused |
| `focusedTextColor` | `ColorInput` | - | Text color when focused |
| `keyBindings` | `InputKeyBinding[]` | - | Custom key bindings |
| `keyAliasMap` | `KeyAliasMap` | - | Key alias mapping |
| `onSubmit` | `(event: SubmitEvent) => void` | - | Callback on Enter |
| `selectionBg` | `ColorInput` | - | Selection background color |
| `selectionFg` | `ColorInput` | - | Selection foreground color |
| `wrapMode` | `"none" \| "char" \| "word"` | `"none"` | Text wrapping (typically "none" for input) |
| `showCursor` | `boolean` | `true` | Show blinking cursor |
| `cursorColor` | `ColorInput` | - | Cursor color |
| `cursorStyle` | `CursorStyleOptions` | `{ style: "block", blinking: true }` | Cursor appearance |
| `scrollMargin` | `number` | - | Keep cursor visible margin |

## Events

```typescript
enum InputRenderableEvents {
  INPUT = "input",      // Emitted on every keystroke
  CHANGE = "change",    // Emitted on committed value change (blur)
  ENTER = "enter",      // Emitted when Enter is pressed
}
```

## Actions

```typescript
type InputAction = TextareaAction
// Includes: "move-left" | "move-right" | "line-home" | "line-end" | "backspace" | "delete"
//   | "word-forward" | "word-backward" | "select-all" | "submit" | "undo" | "redo" | ...
```

## Properties & Methods

```typescript
class InputRenderable extends TextareaRenderable {
  // Value
  get value(): string
  set value(value: string)

  // Configuration
  get maxLength(): number
  set maxLength(maxLength: number)
  get placeholder(): string
  set placeholder(placeholder: string)
  set initialValue(value: string)

  // Focus
  focus(): void
  blur(): void

  // Submission
  submit(): boolean

  // Text editing
  insertText(text: string): void        // Strips newlines, enforces maxLength
  handlePaste(event: PasteEvent): void   // Strips newlines, enforces maxLength
  newLine(): boolean                     // Always returns false (no-op)

  // Deletion
  deleteCharBackward(): boolean
  deleteChar(): boolean
  deleteLine(): boolean
  deleteWordBackward(): boolean
  deleteWordForward(): boolean
  deleteToLineStart(): boolean
  deleteToLineEnd(): boolean
  deleteCharacter(direction: "backward" | "forward"): void

  // Undo/Redo
  undo(): boolean
  redo(): boolean

  // Inherited from TextareaRenderable
  moveCursorLeft(options?: { select?: boolean }): boolean
  moveCursorRight(options?: { select?: boolean }): boolean
  gotoLineHome(options?: { select?: boolean }): boolean
  gotoLineEnd(options?: { select?: boolean }): boolean
  moveWordForward(options?: { select?: boolean }): boolean
  moveWordBackward(options?: { select?: boolean }): boolean
  selectAll(): boolean

  // Inherited from EditBufferRenderable
  get plainText(): string
  get logicalCursor(): LogicalCursor
  get visualCursor(): VisualCursor
  get cursorOffset(): number
  set cursorOffset(offset: number)
  getSelectedText(): string
  hasSelection(): boolean
  getSelection(): { start: number; end: number } | null
}
```

## Examples

### Basic Input

```tsx
<input placeholder="Type here..." />
```

### With Submission

```tsx
<input
  onSubmit={() => {
    console.log("Submitted")
  }}
  placeholder="Press Enter to submit"
/>
```

### With Max Length

```tsx
<input maxLength={50} placeholder="Max 50 characters" />
```

### Styled Input

```tsx
<input
  backgroundColor="#1e1e2e"
  textColor="#cdd6f4"
  focusedBackgroundColor="#313244"
  focusedTextColor="#f5e0dc"
  placeholder="Styled input"
/>
```

### Imperative Usage

```typescript
import { InputRenderable, InputRenderableEvents } from "@opentui/core"

const input = new InputRenderable(ctx, {
  placeholder: "Enter your name",
  maxLength: 100,
})

input.on(InputRenderableEvents.INPUT, () => {
  console.log("Current value:", input.value)
})

input.on(InputRenderableEvents.CHANGE, () => {
  console.log("Committed:", input.value)
})

input.on(InputRenderableEvents.ENTER, () => {
  console.log("Submitted:", input.value)
})

parent.add(input)
input.focus()
```

### Programmatic Control

```typescript
// Set value
input.value = "Hello"

// Read value
const current = input.value

// Focus/blur
input.focus()
input.blur()

// Submit programmatically
input.submit()
```

## Default Key Bindings

| Key | Action |
|-----|--------|
| Left/Right | Move cursor |
| Home/End | Line start/end |
| Backspace | Delete character before cursor |
| Delete | Delete character at cursor |
| Ctrl+A | Select all |
| Ctrl+U | Delete to line start |
| Ctrl+K | Delete to line end |
| Ctrl+W | Delete word backward |
| Ctrl+Backspace | Delete word backward |
| Ctrl+Delete | Delete word forward |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Enter | Submit |

## Related Components

- [Textarea](./textarea.md) -- parent class, multi-line variant
- [TextBuffer](./text-buffer.md) -- underlying buffer system
