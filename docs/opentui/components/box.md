# Box Component

`BoxRenderable` is the foundational container component for building layouts. It extends `Renderable` directly and serves as the base class for `ScrollBoxRenderable`.

**Import:** `import { BoxRenderable } from "@opentui/core"`

## Purpose

- Flexbox layout container powered by Yoga
- Background fill with RGBA color support
- Border rendering with multiple styles (single, double, rounded, heavy, custom)
- Title text rendered inside the border
- Gap support between children
- Focus-aware border color changes

## Constructor

```typescript
new BoxRenderable(ctx: RenderContext, options: BoxOptions)
```

## Props

```typescript
interface BoxOptions<TRenderable extends Renderable = BoxRenderable> extends RenderableOptions<TRenderable> {
  backgroundColor?: string | RGBA
  borderStyle?: BorderStyle           // Default: "single"
  border?: boolean | BorderSides[]    // Default: false
  borderColor?: string | RGBA
  customBorderChars?: BorderCharacters
  shouldFill?: boolean                // Fill background (default: true)
  title?: string                      // Title text in border
  titleAlignment?: "left" | "center" | "right"  // Default: "left"
  focusedBorderColor?: ColorInput
  focusable?: boolean
  gap?: number | `${number}%`
  rowGap?: number | `${number}%`
  columnGap?: number | `${number}%`
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `backgroundColor` | `string \| RGBA` | `""` (transparent) | Background fill color |
| `border` | `boolean \| BorderSides[]` | `false` | Enable borders on all or specific sides |
| `borderStyle` | `BorderStyle` | `"single"` | Border character style |
| `borderColor` | `string \| RGBA` | `""` | Color of border characters |
| `customBorderChars` | `BorderCharacters` | - | Override individual border characters |
| `shouldFill` | `boolean` | `true` | Whether to fill the background area |
| `title` | `string` | - | Title displayed in the top border |
| `titleAlignment` | `"left" \| "center" \| "right"` | `"left"` | Title alignment within the border |
| `focusedBorderColor` | `ColorInput` | `""` | Border color when focused |
| `focusable` | `boolean` | - | Whether the box can receive focus |
| `gap` | `number \| \`${number}%\`` | - | Gap between children (both axes) |
| `rowGap` | `number \| \`${number}%\`` | - | Gap between children on the cross axis |
| `columnGap` | `number \| \`${number}%\`` | - | Gap between children on the main axis |

### BorderStyle

```typescript
type BorderStyle = "single" | "double" | "rounded" | "heavy"
```

### BorderSides

```typescript
type BorderSides = "top" | "right" | "bottom" | "left"

// Examples:
border: true                    // All sides
border: ["top", "bottom"]       // Top and bottom only
border: ["left"]                // Left only
```

### BorderCharacters

```typescript
interface BorderCharacters {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  horizontal: string
  vertical: string
  topT: string
  bottomT: string
  leftT: string
  rightT: string
  cross: string
}
```

## Properties & Methods

```typescript
class BoxRenderable extends Renderable {
  // Background
  get backgroundColor(): RGBA
  set backgroundColor(value: RGBA | string | undefined)

  // Border
  get border(): boolean | BorderSides[]
  set border(value: boolean | BorderSides[])
  get borderStyle(): BorderStyle
  set borderStyle(value: BorderStyle)
  get borderColor(): RGBA
  set borderColor(value: RGBA | string)
  get focusedBorderColor(): RGBA
  set focusedBorderColor(value: RGBA | string)

  // Custom border characters
  get customBorderChars(): BorderCharacters | undefined
  set customBorderChars(value: BorderCharacters | undefined)

  // Title
  get title(): string | undefined
  set title(value: string | undefined)
  get titleAlignment(): "left" | "center" | "right"
  set titleAlignment(value: "left" | "center" | "right")

  // Fill
  shouldFill: boolean

  // Gap
  set gap(gap: number | `${number}%` | undefined)
  set rowGap(rowGap: number | `${number}%` | undefined)
  set columnGap(columnGap: number | `${number}%` | undefined)

  // Inherited from Renderable
  add(obj: Renderable | VNode, index?: number): number
  insertBefore(obj: Renderable | VNode, anchor?: Renderable): number
  remove(id: string): void
  getChildren(): Renderable[]
}
```

## Examples

### Basic Box

```tsx
<box backgroundColor="#1e1e2e" padding={1}>
  <text>Content</text>
</box>
```

### Box with Border and Title

```tsx
<box
  border
  borderStyle="rounded"
  borderColor="#89b4fa"
  title="My Panel"
  titleAlignment="center"
  padding={1}
>
  <text>Panel content</text>
</box>
```

### Focus-Aware Border

```tsx
<box
  border
  borderColor="#6c7086"
  focusedBorderColor="#89b4fa"
  focusable
>
  <text>Click to focus</text>
</box>
```

### Flexbox Layout

```tsx
<box flex={1} flexDirection="row" justifyContent="center" alignItems="center" gap={2}>
  <box backgroundColor="#f38ba8" width={10} height={5} />
  <box backgroundColor="#a6e3a1" width={10} height={5} />
  <box backgroundColor="#89b4fa" width={10} height={5} />
</box>
```

### Partial Borders

```tsx
<box border={["top", "bottom"]} borderColor="#6c7086" paddingX={2}>
  <text>Header style</text>
</box>
```

### Custom Border Characters

```tsx
<box
  border
  customBorderChars={{
    topLeft: "+", topRight: "+",
    bottomLeft: "+", bottomRight: "+",
    horizontal: "-", vertical: "|",
    topT: "+", bottomT: "+",
    leftT: "+", rightT: "+",
    cross: "+",
  }}
>
  <text>ASCII style border</text>
</box>
```

### Absolute Positioning

```tsx
<box position="absolute" top={5} right={2} zIndex={10}>
  <text>Floating overlay</text>
</box>
```

### Responsive Width

```tsx
<box width="50%" padding={1}>
  <text>Takes half the parent width</text>
</box>
```

### Imperative Usage

```typescript
import { BoxRenderable, TextRenderable } from "@opentui/core"

const box = new BoxRenderable(ctx, {
  backgroundColor: "#1e1e2e",
  border: true,
  borderStyle: "rounded",
  borderColor: "#89b4fa",
  title: "Panel",
  padding: 1,
  flexDirection: "column",
  gap: 1,
})

const label = new TextRenderable(ctx, { content: "Hello", fg: "#cdd6f4" })
box.add(label)

// Update properties dynamically
box.backgroundColor = "#313244"
box.title = "Updated Title"
box.borderColor = "#f38ba8"
```

## Related Components

- [ScrollBox](./scrollbox.md) -- extends BoxRenderable with scrolling
- [Text](./text.md) -- commonly used as child content
- [Composition System](../advanced/composition-system.md) -- `Box()` construct function
