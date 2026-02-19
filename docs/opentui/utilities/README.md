# Utility Modules

OpenTUI provides various utility modules for common TUI tasks. These are available from `@opentui/core` and its subpath exports.

## Module Index

| Module | Import | Purpose |
|--------|--------|---------|
| [Keyboard](./keyboard.md) | `@opentui/core` | KeyEvent parsing, KeyHandler, Kitty protocol, key bindings |
| [Mouse](./mouse.md) | `@opentui/core` | MouseEvent parsing, hit testing, pointer styles |
| [Colors](./colors.md) | `@opentui/core` | RGBA class, color parsing, terminal palette detection |
| [Styled Text](./styled-text.md) | `@opentui/core/lib/styled-text` | Rich text composition with template literals |
| [Tree-Sitter](./tree-sitter.md) | `@opentui/core/lib/tree-sitter` | Syntax highlighting with incremental parsing |

## Additional Utilities

These utilities are available but not covered in dedicated docs:

### Selection

```typescript
import { Selection } from "@opentui/core/lib/selection"

const selection = new Selection(renderable, { x: 0, y: 0 }, { x: 10, y: 5 })
const text = selection.getSelectedText()
```

### Clipboard (OSC 52)

```typescript
// Copy text to system clipboard via OSC 52
renderer.copyToClipboardOSC52("text to copy", ClipboardTarget.Clipboard)
renderer.isOsc52Supported() // Check terminal support
```

### Border Characters

```typescript
import { BorderChars, parseBorderStyle } from "@opentui/core/lib/border"

const chars = BorderChars["rounded"]  // "single" | "double" | "rounded" | "heavy"
```

### Extmarks (Editor Decorations)

```typescript
import { ExtmarksController } from "@opentui/core/lib/extmarks"

const extmarks = new ExtmarksController(editBuffer, editorView)
const id = extmarks.create({ start: 0, end: 10, styleId: 5 })
extmarks.delete(id)
```

### Environment Variables

```typescript
import { registerEnvVar, env } from "@opentui/core/lib/env"

registerEnvVar({
  name: "DEBUG",
  description: "Enable debug mode",
  type: "boolean",
  default: false,
})

if (env.DEBUG) console.log("Debug mode")
```

### Debounce

```typescript
import { createDebounce } from "@opentui/core/lib/debounce"

const debouncer = createDebounce("my-component")
await debouncer.debounce("action-1", 100, async () => {
  // Debounced action
})
```

### Singleton

```typescript
import { singleton, destroySingleton } from "@opentui/core/lib/singleton"

const instance = singleton("my-service", () => new MyService())
destroySingleton("my-service")
```

### Text Attributes

```typescript
import { TextAttributes, createTextAttributes } from "@opentui/core"

// Bitmask constants
TextAttributes.BOLD          // 1
TextAttributes.DIM           // 2
TextAttributes.ITALIC        // 4
TextAttributes.UNDERLINE     // 8
TextAttributes.BLINK         // 16
TextAttributes.INVERSE       // 32
TextAttributes.HIDDEN        // 64
TextAttributes.STRIKETHROUGH // 128

// Combine with bitwise OR
const boldItalic = TextAttributes.BOLD | TextAttributes.ITALIC

// Or use the helper
const attrs = createTextAttributes({ bold: true, underline: true })
```

### Renderable Tree Visualization

```typescript
import { visualizeRenderableTree } from "@opentui/core"

// Print the renderable tree for debugging
visualizeRenderableTree(renderer.root, 3) // maxDepth = 3
```

## Quick Reference

### Colors

```typescript
import { RGBA, parseColor } from "@opentui/core"

const color = RGBA.fromHex("#89b4fa")
const color2 = RGBA.fromInts(255, 128, 0, 255)
const parsed = parseColor("#f38ba8")
```

### Styled Text

```typescript
import { t, bold, italic, fg, bg } from "@opentui/core/lib/styled-text"

const styled = t`Hello ${bold("World")}!`
const colored = fg("#f38ba8")(italic("red text"))
```

### Keyboard

```typescript
import { parseKeypress, KeyEvent } from "@opentui/core/lib/parse.keypress"

const parsed = parseKeypress(inputBuffer)
// { name: "return", ctrl: false, shift: false, ... }
```

### Mouse

```typescript
import { MouseParser } from "@opentui/core/lib/parse.mouse"

const parser = new MouseParser()
const event = parser.parseMouseEvent(inputBuffer)
// { type: "down", button: 0, x: 10, y: 5, ... }
```
