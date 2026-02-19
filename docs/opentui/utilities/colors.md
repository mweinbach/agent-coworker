# Colors

OpenTUI provides RGBA color manipulation utilities used throughout the framework for styling components.

## Overview

```typescript
import { RGBA, parseColor } from "@opentui/core"
```

## RGBA Class

The primary color type in OpenTUI. Stores color components as a `Float32Array` in 0-1 range for GPU compatibility.

```typescript
class RGBA {
  buffer: Float32Array  // [r, g, b, a] in 0-1 range

  // Construction
  static fromValues(r: number, g: number, b: number, a?: number): RGBA  // 0-1 range
  static fromInts(r: number, g: number, b: number, a?: number): RGBA    // 0-255 range
  static fromHex(hex: string): RGBA                                      // Hex string
  static fromArray(array: Float32Array): RGBA                            // From raw array

  // Properties (0-1 range, read/write)
  get r(): number
  set r(value: number)
  get g(): number
  set g(value: number)
  get b(): number
  set b(value: number)
  get a(): number
  set a(value: number)

  // Methods
  toInts(): [number, number, number, number]  // Returns 0-255 values
  toString(): string                           // String representation
  equals(other?: RGBA): boolean                // Value equality
  map<R>(fn: (value: number) => R): R[]        // Map over components
}
```

## ColorInput Type

Most component props accept either a hex string or an RGBA instance:

```typescript
type ColorInput = string | RGBA

// Both are valid:
<box backgroundColor="#89b4fa" />
<box backgroundColor={RGBA.fromInts(137, 180, 250, 255)} />
```

## Creating Colors

### From Hex Strings

```typescript
const color = RGBA.fromHex("#89b4fa")
const withAlpha = RGBA.fromHex("#89b4fa80")   // With alpha
const shorthand = RGBA.fromHex("#fff")         // Expanded to #ffffff
```

### From RGB Values

```typescript
// Float values (0-1 range)
const color = RGBA.fromValues(0.5, 0.7, 0.9, 1.0)

// Integer values (0-255 range)
const color = RGBA.fromInts(128, 179, 230, 255)
```

### From Float32Array

```typescript
const buffer = new Float32Array([0.5, 0.7, 0.9, 1.0])
const color = RGBA.fromArray(buffer)
```

### Parsing Any Format

```typescript
const color = parseColor("#89b4fa")
const color2 = parseColor("rgb(137, 180, 250)")
const color3 = parseColor("rgba(137, 180, 250, 0.5)")
```

## Converting

### To Hex

```typescript
import { rgbToHex } from "@opentui/core"

const hex = rgbToHex(color)  // "#89b4fa"
```

### To Integer Array

```typescript
const [r, g, b, a] = color.toInts()
// [137, 180, 250, 255]
```

## Color Transformations

### HSV Conversion

```typescript
import { hsvToRgb } from "@opentui/core/lib/RGBA"

// HSV to RGB (h: 0-360, s: 0-1, v: 0-1)
const color = hsvToRgb(200, 0.5, 0.9)
```

### Lighten / Darken

```typescript
function lighten(color: RGBA, amount: number): RGBA {
  return RGBA.fromValues(
    Math.min(1, color.r + amount),
    Math.min(1, color.g + amount),
    Math.min(1, color.b + amount),
    color.a
  )
}
```

### Blend Two Colors

```typescript
function blend(c1: RGBA, c2: RGBA, t: number): RGBA {
  return RGBA.fromValues(
    c1.r + (c2.r - c1.r) * t,
    c1.g + (c2.g - c1.g) * t,
    c1.b + (c2.b - c1.b) * t,
    c1.a + (c2.a - c1.a) * t
  )
}
```

## Terminal Palette Detection

Detect the terminal's current color palette at runtime:

```typescript
import { TerminalPalette, TerminalColors } from "@opentui/core/lib/terminal-palette"

const palette = new TerminalPalette(stdin, stdout)
const colors = await palette.detect()

// colors.palette[0-15]       -- ANSI 16 colors
// colors.defaultForeground   -- Default text color
// colors.defaultBackground   -- Default background color
// colors.cursorColor         -- Cursor color
```

The renderer also provides palette detection:

```typescript
const palette = await renderer.getPalette()
```

## Using in Components

```tsx
// Hex strings (most common)
<box backgroundColor="#1e1e2e">
  <text fg="#cdd6f4">Hello</text>
</box>

// RGBA instances (for programmatic color manipulation)
const highlight = RGBA.fromHex("#89b4fa")
highlight.a = 0.5  // Semi-transparent

<box backgroundColor={highlight}>
  <text fg={RGBA.fromInts(205, 214, 244, 255)}>Hello</text>
</box>
```

## Catppuccin Mocha Palette Example

A common color palette for terminal applications:

```typescript
const catppuccin = {
  rosewater: RGBA.fromHex("#f5e0dc"),
  flamingo:  RGBA.fromHex("#f2cdcd"),
  pink:      RGBA.fromHex("#f5c2e7"),
  mauve:     RGBA.fromHex("#cba6f7"),
  red:       RGBA.fromHex("#f38ba8"),
  maroon:    RGBA.fromHex("#eba0ac"),
  peach:     RGBA.fromHex("#fab387"),
  yellow:    RGBA.fromHex("#f9e2af"),
  green:     RGBA.fromHex("#a6e3a1"),
  teal:      RGBA.fromHex("#94e2d5"),
  sky:       RGBA.fromHex("#89dceb"),
  sapphire:  RGBA.fromHex("#74c7ec"),
  blue:      RGBA.fromHex("#89b4fa"),
  lavender:  RGBA.fromHex("#b4befe"),
  text:      RGBA.fromHex("#cdd6f4"),
  subtext1:  RGBA.fromHex("#bac2de"),
  subtext0:  RGBA.fromHex("#a6adc8"),
  overlay2:  RGBA.fromHex("#9399b2"),
  overlay1:  RGBA.fromHex("#7f849c"),
  overlay0:  RGBA.fromHex("#6c7086"),
  surface2:  RGBA.fromHex("#585b70"),
  surface1:  RGBA.fromHex("#45475a"),
  surface0:  RGBA.fromHex("#313244"),
  base:      RGBA.fromHex("#1e1e2e"),
  mantle:    RGBA.fromHex("#181825"),
  crust:     RGBA.fromHex("#11111b"),
}
```
