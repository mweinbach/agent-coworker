# Markdown Component

`MarkdownRenderable` renders markdown content with full block and inline element support, syntax-highlighted code blocks via Tree-sitter, streaming mode for incremental LLM output, and a custom node rendering hook. It extends `Renderable` directly.

**Import:** `import { MarkdownRenderable } from "@opentui/core"`

## Constructor

```typescript
new MarkdownRenderable(ctx: RenderContext, options: MarkdownOptions)
```

## Props

```typescript
interface MarkdownOptions extends RenderableOptions<MarkdownRenderable> {
  content?: string
  syntaxStyle: SyntaxStyle              // Required
  conceal?: boolean
  treeSitterClient?: TreeSitterClient
  streaming?: boolean
  renderNode?: (token: Token, context: RenderNodeContext) => Renderable | undefined | null
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `content` | `string` | `""` | Markdown text content |
| `syntaxStyle` | `SyntaxStyle` | required | Syntax style for code blocks |
| `conceal` | `boolean` | `true` | Hide markdown syntax for cleaner display |
| `treeSitterClient` | `TreeSitterClient` | - | Tree-sitter client for code block highlighting |
| `streaming` | `boolean` | `false` | Enable streaming mode for incremental updates |
| `renderNode` | `(token, context) => Renderable \| null` | - | Custom node renderer override |

### RenderNodeContext

```typescript
interface RenderNodeContext {
  syntaxStyle: SyntaxStyle
  conceal: boolean
  treeSitterClient?: TreeSitterClient
  defaultRender: () => Renderable | null   // Fallback to default rendering
}
```

### BlockState

Internal block tracking exposed for advanced usage:

```typescript
interface BlockState {
  token: MarkedToken        // Parsed markdown token
  tokenRaw: string          // Raw markdown source for this block
  renderable: Renderable    // The rendered component
}
```

## Properties & Methods

```typescript
class MarkdownRenderable extends Renderable {
  // Content
  get content(): string
  set content(value: string)

  // Syntax style
  get syntaxStyle(): SyntaxStyle
  set syntaxStyle(value: SyntaxStyle)

  // Display
  get conceal(): boolean
  set conceal(value: boolean)

  // Streaming
  get streaming(): boolean
  set streaming(value: boolean)

  // Internal state (read-only, for advanced use)
  _parseState: ParseState | null
  _blockStates: BlockState[]

  // Cache management
  clearCache(): void
}
```

### Incremental Parser

The markdown parser (`parseMarkdownIncremental`) enables efficient re-rendering by reusing unchanged tokens:

```typescript
interface ParseState {
  content: string
  tokens: MarkedToken[]
}

function parseMarkdownIncremental(
  newContent: string,
  prevState: ParseState | null,
  trailingUnstable?: number
): ParseState
```

In streaming mode, trailing tokens are kept "unstable" (re-parsed on each update) to handle incomplete markdown content.

## Supported Markdown Elements

### Block Elements

| Element | Syntax | Rendered As |
|---------|--------|-------------|
| Headings | `# H1` through `###### H6` | Styled TextRenderable |
| Paragraphs | Plain text | TextRenderable |
| Blockquotes | `> quote` | Indented TextRenderable |
| Unordered lists | `- item` | TextRenderable with bullets |
| Ordered lists | `1. item` | TextRenderable with numbers |
| Code blocks | `` ```language `` | CodeRenderable |
| Tables | `\| col \| col \|` | Custom table layout |
| Thematic breaks | `---` or `***` | Horizontal rule |

### Inline Elements

| Element | Syntax |
|---------|--------|
| Bold | `**bold**` or `__bold__` |
| Italic | `*italic*` or `_italic_` |
| Bold italic | `***bold italic***` |
| Strikethrough | `~~strikethrough~~` |
| Inline code | `` `code` `` |
| Links | `[text](url)` |
| Images | `![alt](url)` |

## Examples

### Basic Markdown

```tsx
<markdown
  content={`# Hello World

This is **bold** and *italic* text.

## Code Block

\`\`\`typescript
const greeting = "Hello";
\`\`\`
`}
  syntaxStyle={syntaxStyle}
/>
```

### Streaming (LLM Output)

```tsx
<markdown
  content={streamedContent}
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
  streaming
/>
```

### Custom Node Rendering

```tsx
<markdown
  content={markdownContent}
  syntaxStyle={syntaxStyle}
  renderNode={(token, context) => {
    if (token.type === "heading") {
      return new CustomHeadingRenderable(ctx, token)
    }
    // Use default for everything else
    return context.defaultRender()
  }}
/>
```

### With Code Block Highlighting

```tsx
<markdown
  content={markdownWithCodeBlocks}
  syntaxStyle={syntaxStyle}
  treeSitterClient={tsClient}
/>
```

### Imperative Usage

```typescript
const markdown = new MarkdownRenderable(ctx, {
  content: "# Hello\n\nWorld",
  syntaxStyle: SyntaxStyle.create(),
  streaming: true,
})

parent.add(markdown)

// Update content incrementally
markdown.content += "\n\nNew paragraph"

// Done streaming
markdown.streaming = false
markdown.clearCache()
```

### Streaming Pattern

```typescript
markdown.streaming = true

for await (const chunk of llmStream) {
  markdown.content += chunk  // Incremental parse, only new tokens processed
}

markdown.streaming = false
markdown.clearCache()
```

### Conceal Mode

```tsx
// With conceal (default): hides **,  ##, etc.
<markdown content={content} syntaxStyle={syntaxStyle} conceal />

// Without conceal: shows raw markdown syntax
<markdown content={content} syntaxStyle={syntaxStyle} conceal={false} />
```

## Related Components

- [Code](./code.md) -- used for rendering fenced code blocks
- [Text](./text.md) -- used for rendering paragraphs, headings, list items
- [Box](./box.md) -- used for layout of block elements
