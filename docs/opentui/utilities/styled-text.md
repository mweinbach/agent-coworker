# Styled Text

Create rich terminal text with multiple styles using composable functions and template literals.

## Overview

```typescript
import { StyledText, t, bold, italic, fg, bg } from "@opentui/core/lib/styled-text"
```

## StyledText Class

The container for styled text content. Holds an array of `TextChunk` objects, each with text and style information.

```typescript
class StyledText {
  chunks: TextChunk[]
  constructor(chunks: TextChunk[])
}

interface TextChunk {
  __isChunk: true
  text: string
  fg?: RGBA              // Foreground color
  bg?: RGBA              // Background color
  attributes?: number    // TextAttributes bitmask
  link?: { url: string } // Hyperlink
}
```

## Template Literal

The `t` tag function is the simplest way to create styled text:

```typescript
import { t, bold, red, fg } from "@opentui/core/lib/styled-text"

const styled = t`Hello ${bold("World")}!`
const colored = t`This is ${red("red")} and ${fg("#89b4fa")("blue")} text.`
```

## Style Functions

### Foreground Colors

```typescript
black(text)
red(text)
green(text)
yellow(text)
blue(text)
magenta(text)
cyan(text)
white(text)
```

### Bright Foreground Colors

```typescript
brightBlack(text)
brightRed(text)
brightGreen(text)
brightYellow(text)
brightBlue(text)
brightMagenta(text)
brightCyan(text)
brightWhite(text)
```

### Background Colors

```typescript
bgBlack(text)
bgRed(text)
bgGreen(text)
bgYellow(text)
bgBlue(text)
bgMagenta(text)
bgCyan(text)
bgWhite(text)
```

### Custom Colors

The `fg()` and `bg()` functions accept hex strings or RGBA instances and return a function that applies the color:

```typescript
fg("#ff0000")("Red text")
fg(RGBA.fromHex("#00ff00"))("Green text")
bg("#0000ff")("Blue background")
```

### Text Styles

```typescript
bold(text)
italic(text)
underline(text)
strikethrough(text)
dim(text)
reverse(text)
blink(text)
```

### Links

```typescript
import { link } from "@opentui/core/lib/styled-text"

const clickable = link("https://example.com")("Click here")
```

## Composing Styles

Nest style functions to combine multiple styles:

```typescript
// Bold + italic
const bi = bold(italic("Bold and italic"))

// Colored bold
const cb = fg("#f38ba8")(bold("Red bold text"))

// Background + foreground
const styled = bg("#1e1e2e")(fg("#89b4fa")("Blue on dark"))

// Underlined colored link
const styledLink = underline(fg("#89b4fa")("Click here"))
```

## Multi-line Styled Text

```typescript
const output = t`
  ${bold("Title")}

  ${dim("Description of the feature")}

  ${fg("#a6e3a1")("Success:")} Operation complete
  ${fg("#f38ba8")("Error:")} Something went wrong
`
```

## Using with Components

### TextRenderable (Imperative)

```typescript
import { TextRenderable } from "@opentui/core"

const text = new TextRenderable(renderer, {
  content: t`Hello ${bold("World")}!`,
})
```

### React / Solid.js (JSX)

In JSX, use inline elements instead of StyledText:

```tsx
<text>
  Plain text with <strong>bold</strong> and <em>italic</em>.
</text>

<text>
  <span fg="#f38ba8">Red text</span>
  <span bg="#1e1e2e"> on dark background</span>
</text>
```

## Programmatic Construction

Build StyledText from chunks directly:

```typescript
import { StyledText, TextAttributes } from "@opentui/core"

const styled = new StyledText([
  { __isChunk: true, text: "Hello ", fg: RGBA.fromHex("#cdd6f4") },
  { __isChunk: true, text: "World", fg: RGBA.fromHex("#f38ba8"), attributes: TextAttributes.BOLD },
  { __isChunk: true, text: "!", fg: RGBA.fromHex("#cdd6f4") },
])
```

## Text Attributes

Combine attributes with bitwise OR or use the helper:

```typescript
import { TextAttributes, createTextAttributes } from "@opentui/core"

// Bitwise combination
const boldItalic = TextAttributes.BOLD | TextAttributes.ITALIC

// Helper function
const attrs = createTextAttributes({ bold: true, underline: true })
```

Attribute values:

| Attribute | Value |
|-----------|-------|
| `NONE` | 0 |
| `BOLD` | 1 |
| `DIM` | 2 |
| `ITALIC` | 4 |
| `UNDERLINE` | 8 |
| `BLINK` | 16 |
| `INVERSE` | 32 |
| `HIDDEN` | 64 |
| `STRIKETHROUGH` | 128 |

## Converting

### From Plain String

```typescript
import { stringToStyledText } from "@opentui/core/lib/styled-text"

const styled = stringToStyledText("Plain text")
```

### To Plain Text

```typescript
const plainText = styled.chunks.map(c => c.text).join("")
```
