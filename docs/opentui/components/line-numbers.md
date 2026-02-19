# LineNumber Component

`LineNumberRenderable` provides a line number gutter that pairs with any `LineInfoProvider`-implementing renderable (such as `TextBufferRenderable`, `EditBufferRenderable`, `CodeRenderable`, or `DiffRenderable`). It supports per-line coloring, line signs, custom number mappings, and line hiding.

**Import:** `import { LineNumberRenderable } from "@opentui/core"`

## Constructor

```typescript
new LineNumberRenderable(ctx: RenderContext, options: LineNumberOptions)
```

## Props

```typescript
interface LineNumberOptions extends RenderableOptions<LineNumberRenderable> {
  target?: Renderable & LineInfoProvider    // The renderable to show line numbers for
  fg?: string | RGBA                        // Line number foreground color
  bg?: string | RGBA                        // Line number background color
  minWidth?: number                         // Minimum gutter width
  paddingRight?: number                     // Padding between numbers and content
  lineColors?: Map<number, string | RGBA | LineColorConfig>  // Per-line colors
  lineSigns?: Map<number, LineSign>         // Per-line signs (markers)
  lineNumberOffset?: number                 // Offset added to line numbers
  hideLineNumbers?: Set<number>             // Lines to hide numbers for
  lineNumbers?: Map<number, number>         // Custom line number mapping
  showLineNumbers?: boolean                 // Show/hide all line numbers
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `target` | `Renderable & LineInfoProvider` | - | Target renderable to track |
| `fg` | `string \| RGBA` | - | Line number text color |
| `bg` | `string \| RGBA` | - | Line number background color |
| `minWidth` | `number` | - | Minimum width of the gutter |
| `paddingRight` | `number` | - | Right padding after line numbers |
| `lineColors` | `Map<number, ColorConfig>` | - | Per-line color overrides |
| `lineSigns` | `Map<number, LineSign>` | - | Per-line sign markers |
| `lineNumberOffset` | `number` | `0` | Offset added to displayed numbers |
| `hideLineNumbers` | `Set<number>` | - | Set of lines to hide numbers for |
| `lineNumbers` | `Map<number, number>` | - | Custom line-to-number mapping |
| `showLineNumbers` | `boolean` | `true` | Whether to display numbers |

### LineSign

Signs are markers displayed before or after the line number:

```typescript
interface LineSign {
  before?: string              // Character(s) before the line number
  beforeColor?: string | RGBA  // Color of the before sign
  after?: string               // Character(s) after the line number
  afterColor?: string | RGBA   // Color of the after sign
}
```

### LineColorConfig

Per-line coloring can target the gutter, content area, or both:

```typescript
interface LineColorConfig {
  gutter?: string | RGBA    // Color for the line number column
  content?: string | RGBA   // Color for the content area background
}
```

When a simple `string | RGBA` is passed, it applies to both gutter and content.

## Properties & Methods

```typescript
class LineNumberRenderable extends Renderable {
  // Visibility
  get showLineNumbers(): boolean
  set showLineNumbers(value: boolean)

  // Line number offset
  get lineNumberOffset(): number
  set lineNumberOffset(value: number)

  // Tree operations
  add(child: Renderable): number
  remove(id: string): void
  clearTarget(): void
  destroyRecursively(): void

  // Per-line colors
  setLineColor(line: number, color: string | RGBA | LineColorConfig): void
  clearLineColor(line: number): void
  clearAllLineColors(): void
  setLineColors(lineColors: Map<number, string | RGBA | LineColorConfig>): void
  getLineColors(): { gutter: Map<number, RGBA>; content: Map<number, RGBA> }

  // Per-line signs
  setLineSign(line: number, sign: LineSign): void
  clearLineSign(line: number): void
  clearAllLineSigns(): void
  setLineSigns(lineSigns: Map<number, LineSign>): void
  getLineSigns(): Map<number, LineSign>

  // Hidden lines
  setHideLineNumbers(hideLineNumbers: Set<number>): void
  getHideLineNumbers(): Set<number>

  // Custom number mapping
  setLineNumbers(lineNumbers: Map<number, number>): void
  getLineNumbers(): Map<number, number>

  // Range highlighting
  highlightLines(startLine: number, endLine: number, color: string | RGBA | LineColorConfig): void
  clearHighlightLines(startLine: number, endLine: number): void
}
```

## Examples

### With Code Component

```tsx
<box flexDirection="row">
  <line-number target={codeRef} fg="#6c7086" bg="#1e1e2e" />
  <code ref={codeRef} content={sourceCode} filetype="typescript" syntaxStyle={syntaxStyle} />
</box>
```

### With Error Signs

```typescript
const lineNumbers = new LineNumberRenderable(ctx, {
  target: codeRenderable,
  fg: "#6c7086",
})

// Add error marker on line 5
lineNumbers.setLineSign(5, {
  before: "E",
  beforeColor: "#f38ba8",
})

// Add warning marker on line 12
lineNumbers.setLineSign(12, {
  before: "W",
  beforeColor: "#fab387",
})
```

### With Line Highlighting

```typescript
// Highlight lines 10-15 with a yellow gutter
lineNumbers.highlightLines(10, 15, {
  gutter: "#f9e2af",
  content: "#3a3a2e",
})

// Clear the highlights
lineNumbers.clearHighlightLines(10, 15)
```

### Per-Line Colors

```typescript
const lineColors = new Map()
lineColors.set(3, "#2d5a3d")        // Green background for line 3
lineColors.set(7, { gutter: "#f38ba8", content: "#3d1a1a" })  // Separate gutter/content

lineNumbers.setLineColors(lineColors)
```

### Custom Line Number Mapping

Useful for showing original file line numbers in a filtered/partial view:

```typescript
const mapping = new Map()
mapping.set(0, 42)   // Display line 0 as line 42
mapping.set(1, 43)
mapping.set(2, 50)   // Gap indicates non-contiguous lines

lineNumbers.setLineNumbers(mapping)
```

### Hidden Line Numbers

```typescript
// Hide line numbers for specific lines (e.g., dividers)
lineNumbers.setHideLineNumbers(new Set([5, 10, 15]))
```

### Line Number Offset

```typescript
// Start numbering from line 100 instead of 1
lineNumbers.lineNumberOffset = 99
```

### Imperative Usage

```typescript
import { LineNumberRenderable, CodeRenderable } from "@opentui/core"

const code = new CodeRenderable(ctx, {
  content: sourceCode,
  filetype: "typescript",
  syntaxStyle,
})

const lineNumbers = new LineNumberRenderable(ctx, {
  target: code,
  fg: "#6c7086",
  bg: "#181825",
  minWidth: 4,
  paddingRight: 1,
})

const container = new BoxRenderable(ctx, { flexDirection: "row" })
container.add(lineNumbers)
container.add(code)
parent.add(container)

// Add breakpoint markers
lineNumbers.setLineSign(10, { before: "B", beforeColor: "#f38ba8" })

// Highlight current execution line
lineNumbers.setLineColor(15, { gutter: "#89b4fa", content: "#1e3a5f" })
```

## Related Components

- [Code](./code.md) -- commonly paired as target
- [Diff](./diff.md) -- uses LineNumberRenderable internally
- [TextBuffer](./text-buffer.md) -- provides LineInfoProvider interface
