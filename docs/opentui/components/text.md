# Text and TextNode Components

`TextRenderable` displays styled text content. `TextNodeRenderable` provides hierarchical styled text nodes that compose into a `TextRenderable`.

**Import:** `import { TextRenderable, TextNodeRenderable, RootTextNodeRenderable } from "@opentui/core"`

## TextRenderable

Extends `TextBufferRenderable` to display styled text with selection support, wrapping, and scrolling.

### Constructor

```typescript
new TextRenderable(ctx: RenderContext, options: TextOptions)
```

### Props

```typescript
interface TextOptions extends TextBufferOptions {
  content?: StyledText | string
}
```

`TextBufferOptions` provides:

```typescript
interface TextBufferOptions extends RenderableOptions<TextBufferRenderable> {
  fg?: string | RGBA                   // Foreground color
  bg?: string | RGBA                   // Background color
  selectionBg?: string | RGBA          // Selection highlight background
  selectionFg?: string | RGBA          // Selection highlight foreground
  selectable?: boolean                 // Enable mouse selection (default: true)
  attributes?: number                  // Text attributes bitmask
  wrapMode?: "none" | "char" | "word"  // Text wrapping mode (default: "none")
  tabIndicator?: string | number       // Tab display character or width
  tabIndicatorColor?: string | RGBA    // Color for tab indicators
  truncate?: boolean                   // Truncate text that overflows (default: false)
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `content` | `StyledText \| string` | `""` | Text content to display |
| `fg` | `string \| RGBA` | Default fg | Foreground (text) color |
| `bg` | `string \| RGBA` | Default bg | Background color |
| `selectionBg` | `string \| RGBA` | - | Background color when text is selected |
| `selectionFg` | `string \| RGBA` | - | Foreground color when text is selected |
| `selectable` | `boolean` | `true` | Whether text can be selected with mouse |
| `attributes` | `number` | `0` | Text attribute bitmask (bold, italic, etc.) |
| `wrapMode` | `"none" \| "char" \| "word"` | `"none"` | How text wraps at boundaries |
| `tabIndicator` | `string \| number` | - | Character or width to display for tabs |
| `tabIndicatorColor` | `string \| RGBA` | - | Color of tab indicator characters |
| `truncate` | `boolean` | `false` | Truncate overflowing text |

### Properties & Methods

```typescript
class TextRenderable extends TextBufferRenderable {
  // Content
  get content(): StyledText
  set content(value: StyledText | string)
  get chunks(): TextChunk[]
  get textNode(): RootTextNodeRenderable

  // TextNode tree manipulation
  add(obj: TextNodeRenderable | StyledText | string, index?: number): number
  remove(id: string): void
  insertBefore(obj: BaseRenderable | any, anchor?: TextNodeRenderable): number
  getTextChildren(): BaseRenderable[]
  clear(): void

  // Inherited from TextBufferRenderable
  get plainText(): string
  get textLength(): number
  get lineCount(): number
  get virtualLineCount(): number

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

  // Selection
  get selectionBg(): RGBA | undefined
  set selectionBg(value: RGBA | string | undefined)
  get selectionFg(): RGBA | undefined
  set selectionFg(value: RGBA | string | undefined)
  get selectable(): boolean
  hasSelection(): boolean
  getSelectedText(): string
  getSelection(): { start: number; end: number } | null

  // Wrap & display
  get wrapMode(): "none" | "char" | "word"
  set wrapMode(value: "none" | "char" | "word")
  get truncate(): boolean
  set truncate(value: boolean)
  get tabIndicator(): string | number | undefined
  set tabIndicator(value: string | number | undefined)
  get tabIndicatorColor(): RGBA | undefined
  set tabIndicatorColor(value: RGBA | string | undefined)
  get attributes(): number
  set attributes(value: number)
}
```

## TextNodeRenderable

`TextNodeRenderable` extends `BaseRenderable` (not `Renderable`) and represents a styled span of text within a `TextRenderable`. TextNodes form a tree where child nodes inherit and override parent styles.

### Constructor

```typescript
new TextNodeRenderable(options: TextNodeOptions)
```

### Props

```typescript
interface TextNodeOptions extends BaseRenderableOptions {
  fg?: string | RGBA
  bg?: string | RGBA
  attributes?: number
  link?: { url: string }
}
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fg` | `string \| RGBA` | inherited | Foreground color (inherits from parent if unset) |
| `bg` | `string \| RGBA` | inherited | Background color (inherits from parent if unset) |
| `attributes` | `number` | `0` | Text attributes bitmask |
| `link` | `{ url: string }` | - | Makes this node a hyperlink |

### Properties & Methods

```typescript
class TextNodeRenderable extends BaseRenderable {
  // Children
  get children(): (string | TextNodeRenderable)[]
  set children(children: (string | TextNodeRenderable)[])

  // Tree operations
  add(obj: TextNodeRenderable | StyledText | string, index?: number): number
  replace(obj: TextNodeRenderable | string, index: number): void
  insertBefore(child: string | TextNodeRenderable | StyledText, anchorNode: TextNodeRenderable | string): this
  remove(id: string): this
  clear(): void
  getChildren(): BaseRenderable[]
  getChildrenCount(): number
  getRenderable(id: string): BaseRenderable | undefined
  getRenderableIndex(id: string): number
  findDescendantById(id: string): BaseRenderable | undefined

  // Style
  get fg(): RGBA | undefined
  set fg(fg: RGBA | string | undefined)
  get bg(): RGBA | undefined
  set bg(bg: RGBA | string | undefined)
  get attributes(): number
  set attributes(attributes: number)
  get link(): { url: string } | undefined
  set link(link: { url: string } | undefined)

  // Style computation
  mergeStyles(parentStyle: { fg?: RGBA; bg?: RGBA; attributes: number; link?: { url: string } }): { ... }
  gatherWithInheritedStyle(parentStyle?): TextChunk[]
  toChunks(parentStyle?): TextChunk[]

  // Static factories
  static fromString(text: string, options?: Partial<TextNodeOptions>): TextNodeRenderable
  static fromNodes(nodes: TextNodeRenderable[], options?: Partial<TextNodeOptions>): TextNodeRenderable
}
```

### isTextNodeRenderable

```typescript
function isTextNodeRenderable(obj: any): obj is TextNodeRenderable
```

## RootTextNodeRenderable

A special `TextNodeRenderable` subclass that serves as the root of a TextRenderable's node tree. It holds a reference back to its parent `TextRenderable` and triggers re-renders on the owning renderable.

```typescript
class RootTextNodeRenderable extends TextNodeRenderable {
  textParent: TextRenderable
  constructor(ctx: RenderContext, options: TextNodeOptions, textParent: TextRenderable)
  requestRender(): void  // Delegates to textParent
}
```

## StyledText

Create rich text with multiple styles:

```typescript
import { StyledText, t, bold, italic, fg, bg } from "@opentui/core"

// Template literal helper
const styled = t`Hello ${bold("World")}!`

// Function composition
const colored = fg("#f38ba8")(bold(italic("Styled text")))

// Set as content
text.content = styled
```

### Style Functions

```typescript
// Named colors
black(text), red(text), green(text), yellow(text), blue(text),
magenta(text), cyan(text), white(text)

// Bright colors
brightBlack(text), brightRed(text), brightGreen(text), ...

// Background colors
bgBlack(text), bgRed(text), bgGreen(text), ...

// Attributes
bold(text), italic(text), underline(text), strikethrough(text),
dim(text), blink(text), reverse(text)

// Custom colors
fg("#ff0000")(text)
bg("#0000ff")(text)

// Links
link("https://example.com")("Click here")
```

## Text Attributes

```typescript
const TextAttributes = {
  NONE: 0,
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  BLINK: 16,
  INVERSE: 32,
  HIDDEN: 64,
  STRIKETHROUGH: 128,
}

// Combine with bitwise OR
const boldItalic = TextAttributes.BOLD | TextAttributes.ITALIC
```

## Examples

### Plain Text

```tsx
<text>Hello, World!</text>
```

### Colored Text

```tsx
<text fg="#89b4fa" bg="#1e1e2e">
  Blue text on dark background
</text>
```

### Styled Text (JSX)

```tsx
<text>
  Normal text with <strong>bold</strong> and <em>italic</em>.
</text>

<text>
  <span fg="#f38ba8">Red text</span>
  <span fg="#a6e3a1">Green text</span>
</text>

<text>
  <a href="https://example.com">Click here</a>
</text>
```

### Word Wrapping

```tsx
<text wrapMode="word" width={40}>
  This is a long text that will wrap at word boundaries when it exceeds the width.
</text>
```

### Tab Indicators

```tsx
<text tabIndicator=">" tabIndicatorColor="#6c7086">
  {"Indented\twith\ttabs"}
</text>
```

### TextNode Hierarchy (Imperative)

```typescript
const text = new TextRenderable(ctx, { fg: "#cdd6f4" })

const boldNode = TextNodeRenderable.fromString("Bold text", {
  attributes: TextAttributes.BOLD,
})
const colorNode = TextNodeRenderable.fromString("Red text", {
  fg: "#f38ba8",
})

text.add("Normal ")
text.add(boldNode)
text.add(" and ")
text.add(colorNode)
```

### Selection Handling

```typescript
if (text.hasSelection()) {
  const selected = text.getSelectedText()
  const range = text.getSelection()  // { start, end }
}
```

### Streaming Text

```typescript
let fullText = ""

async function streamChunk(chunk: string) {
  fullText += chunk
  text.content = fullText
}
```

## Related Components

- [TextBuffer](./text-buffer.md) -- base class providing scroll, selection, and line info
- [Code](./code.md) -- also extends TextBufferRenderable, adds syntax highlighting
- [Markdown](./markdown.md) -- renders markdown containing Text elements
