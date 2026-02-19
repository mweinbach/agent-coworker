# Code Component

`CodeRenderable` displays syntax-highlighted code using Tree-sitter for parsing. It extends `TextBufferRenderable` and supports streaming mode for incremental content updates and custom highlight callbacks.

**Import:** `import { CodeRenderable } from "@opentui/core"`

## Constructor

```typescript
new CodeRenderable(ctx: RenderContext, options: CodeOptions)
```

## Props

```typescript
interface CodeOptions extends TextBufferOptions {
  content?: string
  filetype?: string
  syntaxStyle: SyntaxStyle              // Required
  treeSitterClient?: TreeSitterClient
  conceal?: boolean
  drawUnstyledText?: boolean
  streaming?: boolean
  onHighlight?: OnHighlightCallback
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `content` | `string` | `""` | Source code to display |
| `filetype` | `string` | - | Language identifier for highlighting (e.g., `"typescript"`) |
| `syntaxStyle` | `SyntaxStyle` | required | Syntax highlighting color theme |
| `treeSitterClient` | `TreeSitterClient` | - | Tree-sitter client for parsing |
| `conceal` | `boolean` | `true` | Hide redundant syntax characters |
| `drawUnstyledText` | `boolean` | `true` | Render text before highlights are ready |
| `streaming` | `boolean` | `false` | Enable streaming mode for incremental updates |
| `onHighlight` | `OnHighlightCallback` | - | Custom highlight callback |
| `fg` | `string \| RGBA` | - | Default foreground color (inherited) |
| `bg` | `string \| RGBA` | - | Background color (inherited) |
| `selectionBg` | `string \| RGBA` | - | Selection background (inherited) |
| `selectionFg` | `string \| RGBA` | - | Selection foreground (inherited) |
| `selectable` | `boolean` | `true` | Enable text selection (inherited) |
| `wrapMode` | `"none" \| "char" \| "word"` | `"none"` | Text wrapping mode (inherited) |
| `tabIndicator` | `string \| number` | - | Tab display (inherited) |
| `truncate` | `boolean` | `false` | Truncate overflow (inherited) |

### OnHighlightCallback

```typescript
type OnHighlightCallback = (
  highlights: SimpleHighlight[],
  context: HighlightContext
) => SimpleHighlight[] | undefined | Promise<SimpleHighlight[] | undefined>

interface HighlightContext {
  content: string
  filetype: string
  syntaxStyle: SyntaxStyle
}
```

## Properties & Methods

```typescript
class CodeRenderable extends TextBufferRenderable {
  // Content
  get content(): string
  set content(value: string)

  // Language
  get filetype(): string | undefined
  set filetype(value: string)

  // Syntax style
  get syntaxStyle(): SyntaxStyle
  set syntaxStyle(value: SyntaxStyle)

  // Display options
  get conceal(): boolean
  set conceal(value: boolean)
  get drawUnstyledText(): boolean
  set drawUnstyledText(value: boolean)

  // Streaming
  get streaming(): boolean
  set streaming(value: boolean)

  // Tree-sitter client
  get treeSitterClient(): TreeSitterClient
  set treeSitterClient(value: TreeSitterClient)

  // Custom highlight callback
  get onHighlight(): OnHighlightCallback | undefined
  set onHighlight(value: OnHighlightCallback | undefined)

  // Status
  get isHighlighting(): boolean

  // Line-level highlights
  getLineHighlights(lineIdx: number): Highlight[]

  // Inherited from TextBufferRenderable
  get plainText(): string
  get lineCount(): number
  get virtualLineCount(): number
  get scrollY(): number
  set scrollY(value: number)
  get scrollX(): number
  set scrollX(value: number)
  get fg(): RGBA
  set fg(value: RGBA | string | undefined)
  get bg(): RGBA
  set bg(value: RGBA | string | undefined)
  get wrapMode(): "none" | "char" | "word"
  set wrapMode(value: "none" | "char" | "word")
  hasSelection(): boolean
  getSelectedText(): string
}
```

## Examples

### Basic Code Display

```tsx
<code
  content={codeString}
  filetype="typescript"
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
/>
```

### Streaming Code (LLM Output)

```tsx
<code
  content={streamedCode}
  filetype="typescript"
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
  streaming
/>
```

### Custom Highlight Callback

```tsx
<code
  content={code}
  filetype="typescript"
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
  onHighlight={(highlights, context) => {
    // Add error highlights
    const errors = findErrors(context.content)
    return [...highlights, ...errors.map(e => ({
      start: e.start,
      end: e.end,
      styleId: errorStyleId,
    }))]
  }}
/>
```

### With Conceal Disabled

```tsx
<code
  content={code}
  filetype="lua"
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
  conceal={false}  // Show all syntax characters
/>
```

### With Line Numbers

```tsx
<box flexDirection="row">
  <line-number target={codeRef} />
  <code ref={codeRef} content={code} filetype="typescript" syntaxStyle={syntaxStyle} />
</box>
```

### Imperative Usage

```typescript
import { CodeRenderable, SyntaxStyle } from "@opentui/core"

const code = new CodeRenderable(ctx, {
  content: `function hello() {\n  return "world";\n}`,
  filetype: "typescript",
  syntaxStyle,
  treeSitterClient: tsClient,
  conceal: true,
})

parent.add(code)

// Update content
code.content = newCode

// Change language
code.filetype = "javascript"

// Check highlighting status
if (code.isHighlighting) {
  // Highlighting in progress
}
```

### Streaming Pattern

```typescript
code.streaming = true

for await (const chunk of llmStream) {
  code.content += chunk  // Efficiently processes only new content
}

code.streaming = false  // Done streaming
```

## Related Components

- [TextBuffer](./text-buffer.md) -- base class providing scroll, selection, and line info
- [Text](./text.md) -- also extends TextBufferRenderable for plain/styled text
- [LineNumbers](./line-numbers.md) -- pairs with Code for line number gutter
- [Diff](./diff.md) -- uses CodeRenderable internally for syntax highlighting
- [Markdown](./markdown.md) -- renders code blocks as CodeRenderable
