# ASCIIFont Component

`ASCIIFontRenderable` renders text using large ASCII art fonts (bitmap fonts). It extends `FrameBufferRenderable` and supports text selection, gradient colors, and multiple built-in fonts.

**Import:** `import { ASCIIFontRenderable } from "@opentui/core"`

## Constructor

```typescript
new ASCIIFontRenderable(ctx: RenderContext, options: ASCIIFontOptions)
```

## Props

```typescript
interface ASCIIFontOptions extends Omit<RenderableOptions<ASCIIFontRenderable>, "width" | "height"> {
  text?: string
  font?: ASCIIFontName
  color?: ColorInput | ColorInput[]     // Single color or gradient array
  backgroundColor?: ColorInput
  selectionBg?: ColorInput
  selectionFg?: ColorInput
  selectable?: boolean
}
```

Note: `width` and `height` are omitted from `RenderableOptions` because they are auto-calculated from the text and font dimensions.

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `text` | `string` | `""` | Text to render in ASCII art |
| `font` | `ASCIIFontName` | `"tiny"` | Font name to use |
| `color` | `ColorInput \| ColorInput[]` | `""` | Text color, or array for gradient |
| `backgroundColor` | `ColorInput` | `""` | Background color behind the art |
| `selectionBg` | `ColorInput` | - | Background color when selected |
| `selectionFg` | `ColorInput` | - | Foreground color when selected |
| `selectable` | `boolean` | `true` | Whether the text can be selected |

### ASCIIFontName

Available font names (from `fonts` export):

```typescript
type ASCIIFontName = keyof typeof fonts
// Includes: "tiny", and other built-in ASCII art fonts
```

## Properties & Methods

```typescript
class ASCIIFontRenderable extends FrameBufferRenderable {
  selectable: boolean

  // Text
  get text(): string
  set text(value: string)

  // Font
  get font(): ASCIIFontName
  set font(value: ASCIIFontName)

  // Color (single or gradient)
  get color(): ColorInput | ColorInput[]
  set color(value: ColorInput | ColorInput[])

  // Background
  get backgroundColor(): ColorInput
  set backgroundColor(value: ColorInput)

  // Selection support
  shouldStartSelection(x: number, y: number): boolean
  onSelectionChanged(selection: Selection | null): boolean
  getSelectedText(): string
  hasSelection(): boolean

  // Inherited from FrameBufferRenderable
  frameBuffer: OptimizedBuffer          // Direct pixel buffer access
}
```

## Examples

### Basic ASCII Art Text

```tsx
<asciifont text="Hello" font="tiny" color="#89b4fa" />
```

### With Background

```tsx
<asciifont
  text="TITLE"
  font="tiny"
  color="#cdd6f4"
  backgroundColor="#1e1e2e"
/>
```

### Gradient Colors

Pass an array of colors for a gradient effect across the text:

```tsx
<asciifont
  text="Rainbow"
  font="tiny"
  color={["#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#89b4fa", "#cba6f7"]}
/>
```

### Non-Selectable

```tsx
<asciifont text="Decorative" font="tiny" color="#6c7086" selectable={false} />
```

### Imperative Usage

```typescript
import { ASCIIFontRenderable } from "@opentui/core"

const logo = new ASCIIFontRenderable(ctx, {
  text: "MyApp",
  font: "tiny",
  color: ["#89b4fa", "#cba6f7"],
  backgroundColor: "#1e1e2e",
})

parent.add(logo)

// Update text dynamically
logo.text = "NewTitle"

// Change font
logo.font = "tiny"

// Change colors
logo.color = "#f38ba8"
```

## How It Works

ASCIIFontRenderable:
1. Measures the text dimensions using the selected font's glyph data
2. Auto-sizes itself to fit the rendered ASCII art
3. Renders each character as a multi-line glyph pattern into its `FrameBuffer`
4. Supports selection by mapping screen coordinates back to the original text

## Related Components

- [FrameBuffer](./frame-buffer.md) -- base class providing raw buffer rendering
- [Text](./text.md) -- for regular-sized text display
- [Select](./select.md) -- can use ASCII fonts for option rendering via the `font` prop
