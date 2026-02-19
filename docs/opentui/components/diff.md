# Diff Component

`DiffRenderable` renders git-style diffs with unified or split views, syntax highlighting, line numbers, and customizable per-line coloring. It extends `Renderable` directly and internally composes `CodeRenderable` and `LineNumberRenderable`.

**Import:** `import { DiffRenderable } from "@opentui/core"`

## Constructor

```typescript
new DiffRenderable(ctx: RenderContext, options: DiffRenderableOptions)
```

## Props

```typescript
interface DiffRenderableOptions extends RenderableOptions<DiffRenderable> {
  diff?: string                       // Unified diff content
  view?: "unified" | "split"          // View mode
  fg?: string | RGBA                  // Default foreground color
  filetype?: string                   // Language for syntax highlighting
  syntaxStyle?: SyntaxStyle           // Syntax highlighting theme
  wrapMode?: "word" | "char" | "none" // Text wrapping
  conceal?: boolean                   // Conceal syntax characters
  selectionBg?: string | RGBA         // Selection background
  selectionFg?: string | RGBA         // Selection foreground
  treeSitterClient?: TreeSitterClient // Tree-sitter for highlighting
  showLineNumbers?: boolean           // Show line number gutter

  // Line number colors
  lineNumberFg?: string | RGBA
  lineNumberBg?: string | RGBA

  // Gutter colors (the +/- sign column)
  addedBg?: string | RGBA
  removedBg?: string | RGBA
  contextBg?: string | RGBA

  // Content area colors
  addedContentBg?: string | RGBA
  removedContentBg?: string | RGBA
  contextContentBg?: string | RGBA

  // Sign character colors
  addedSignColor?: string | RGBA
  removedSignColor?: string | RGBA

  // Line number area colors for added/removed
  addedLineNumberBg?: string | RGBA
  removedLineNumberBg?: string | RGBA
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `diff` | `string` | - | Unified diff string |
| `view` | `"unified" \| "split"` | `"unified"` | Display mode |
| `fg` | `string \| RGBA` | - | Default text color |
| `filetype` | `string` | - | Language for syntax highlighting |
| `syntaxStyle` | `SyntaxStyle` | - | Syntax highlighting theme |
| `wrapMode` | `"word" \| "char" \| "none"` | - | Text wrapping mode |
| `conceal` | `boolean` | - | Conceal syntax characters |
| `selectionBg` | `string \| RGBA` | - | Selection background |
| `selectionFg` | `string \| RGBA` | - | Selection foreground |
| `treeSitterClient` | `TreeSitterClient` | - | Tree-sitter for highlighting |
| `showLineNumbers` | `boolean` | - | Show line numbers |
| `lineNumberFg` | `string \| RGBA` | - | Line number foreground |
| `lineNumberBg` | `string \| RGBA` | - | Line number background |
| `addedBg` | `string \| RGBA` | - | Added line gutter background |
| `removedBg` | `string \| RGBA` | - | Removed line gutter background |
| `contextBg` | `string \| RGBA` | - | Context line gutter background |
| `addedContentBg` | `string \| RGBA` | - | Added line content background |
| `removedContentBg` | `string \| RGBA` | - | Removed line content background |
| `contextContentBg` | `string \| RGBA` | - | Context line content background |
| `addedSignColor` | `string \| RGBA` | - | "+" character color |
| `removedSignColor` | `string \| RGBA` | - | "-" character color |
| `addedLineNumberBg` | `string \| RGBA` | - | Line number bg for added lines |
| `removedLineNumberBg` | `string \| RGBA` | - | Line number bg for removed lines |

## Properties & Methods

```typescript
class DiffRenderable extends Renderable {
  // Content
  get diff(): string
  set diff(value: string)

  // View mode
  get view(): "unified" | "split"
  set view(value: "unified" | "split")

  // Syntax highlighting
  get filetype(): string | undefined
  set filetype(value: string | undefined)
  get syntaxStyle(): SyntaxStyle | undefined
  set syntaxStyle(value: SyntaxStyle | undefined)

  // Display
  get wrapMode(): "word" | "char" | "none" | undefined
  set wrapMode(value: "word" | "char" | "none" | undefined)
  get showLineNumbers(): boolean
  set showLineNumbers(value: boolean)
  get conceal(): boolean
  set conceal(value: boolean)

  // Foreground
  get fg(): RGBA | undefined
  set fg(value: string | RGBA | undefined)

  // Selection
  get selectionBg(): RGBA | undefined
  set selectionBg(value: string | RGBA | undefined)
  get selectionFg(): RGBA | undefined
  set selectionFg(value: string | RGBA | undefined)

  // Gutter colors
  get addedBg(): RGBA
  set addedBg(value: string | RGBA)
  get removedBg(): RGBA
  set removedBg(value: string | RGBA)
  get contextBg(): RGBA
  set contextBg(value: string | RGBA)

  // Content colors
  get addedContentBg(): RGBA | null
  set addedContentBg(value: string | RGBA | null)
  get removedContentBg(): RGBA | null
  set removedContentBg(value: string | RGBA | null)
  get contextContentBg(): RGBA | null
  set contextContentBg(value: string | RGBA | null)

  // Sign colors
  get addedSignColor(): RGBA
  set addedSignColor(value: string | RGBA)
  get removedSignColor(): RGBA
  set removedSignColor(value: string | RGBA)

  // Line number colors
  get lineNumberFg(): RGBA
  set lineNumberFg(value: string | RGBA)
  get lineNumberBg(): RGBA
  set lineNumberBg(value: string | RGBA)
  get addedLineNumberBg(): RGBA
  set addedLineNumberBg(value: string | RGBA)
  get removedLineNumberBg(): RGBA
  set removedLineNumberBg(value: string | RGBA)

  // Per-line coloring
  setLineColor(line: number, color: string | RGBA | LineColorConfig): void
  clearLineColor(line: number): void
  setLineColors(lineColors: Map<number, string | RGBA | LineColorConfig>): void
  clearAllLineColors(): void

  // Range highlighting
  highlightLines(startLine: number, endLine: number, color: string | RGBA | LineColorConfig): void
  clearHighlightLines(startLine: number, endLine: number): void

  // Cleanup
  destroyRecursively(): void
}
```

### LineColorConfig

```typescript
interface LineColorConfig {
  gutter?: string | RGBA    // Color for the gutter column
  content?: string | RGBA   // Color for the content area
}
```

## Examples

### Basic Diff

```tsx
const diffContent = `--- a/file.ts
+++ b/file.ts
@@ -1,5 +1,5 @@
 function hello() {
-  return "Hello";
+  return "Hello, World!";
 }`

<diff diff={diffContent} />
```

### Split View

```tsx
<diff diff={diffContent} view="split" />
```

### With Syntax Highlighting

```tsx
<diff
  diff={diffContent}
  filetype="typescript"
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
/>
```

### Custom Colors

```tsx
<diff
  diff={diffContent}
  addedBg="#2d5a3d"
  removedBg="#5a2d2d"
  contextBg="#1e1e2e"
  addedContentBg="#1a3d2d"
  removedContentBg="#3d1a1a"
  addedSignColor="#a6e3a1"
  removedSignColor="#f38ba8"
/>
```

### With Line Numbers

```tsx
<diff
  diff={diffContent}
  showLineNumbers
  lineNumberFg="#6c7086"
/>
```

### Per-Line Highlighting

```typescript
const diff = new DiffRenderable(ctx, { diff: diffContent })

// Highlight a range of lines
diff.highlightLines(5, 10, "#fab387")

// Set individual line color
diff.setLineColor(3, { gutter: "#f38ba8", content: "#3d1a1a" })

// Clear
diff.clearHighlightLines(5, 10)
diff.clearAllLineColors()
```

### Imperative Usage

```typescript
const diff = new DiffRenderable(ctx, {
  diff: unifiedDiffString,
  view: "unified",
  filetype: "typescript",
  syntaxStyle,
  showLineNumbers: true,
})

parent.add(diff)

// Update diff
diff.diff = newDiffString

// Switch view mode
diff.view = "split"
```

## Diff Format

Expects standard unified diff format:

```
--- a/original.txt
+++ b/modified.txt
@@ -l,s +l,s @@
 context line
-removed line
+added line
 context line
```

## Related Components

- [Code](./code.md) -- used internally for syntax highlighting
- [LineNumbers](./line-numbers.md) -- used internally for line number gutter
- [TextBuffer](./text-buffer.md) -- underlying text rendering
