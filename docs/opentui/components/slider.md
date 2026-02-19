# Slider Component

`SliderRenderable` provides a horizontal or vertical slider with a draggable thumb, configurable range, and viewport-proportional thumb sizing. It extends `Renderable` directly and is used internally by `ScrollBarRenderable`.

**Import:** `import { SliderRenderable } from "@opentui/core"`

## Constructor

```typescript
new SliderRenderable(ctx: RenderContext, options: SliderOptions)
```

## Props

```typescript
interface SliderOptions extends RenderableOptions<SliderRenderable> {
  orientation: "vertical" | "horizontal"   // Required
  value?: number
  min?: number
  max?: number
  viewPortSize?: number
  backgroundColor?: ColorInput
  foregroundColor?: ColorInput
  onChange?: (value: number) => void
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `orientation` | `"vertical" \| "horizontal"` | required | Slider direction |
| `value` | `number` | `0` | Current value |
| `min` | `number` | `0` | Minimum value |
| `max` | `number` | `100` | Maximum value |
| `viewPortSize` | `number` | - | Viewport size (affects thumb proportional sizing) |
| `backgroundColor` | `ColorInput` | - | Track background color |
| `foregroundColor` | `ColorInput` | - | Thumb/fill color |
| `onChange` | `(value: number) => void` | - | Value change callback |

## Properties & Methods

```typescript
class SliderRenderable extends Renderable {
  readonly orientation: "vertical" | "horizontal"

  // Value
  get value(): number
  set value(newValue: number)

  // Range
  get min(): number
  set min(newMin: number)
  get max(): number
  set max(newMax: number)

  // Viewport (proportional thumb sizing)
  get viewPortSize(): number
  set viewPortSize(size: number)

  // Colors
  get backgroundColor(): RGBA
  set backgroundColor(value: ColorInput)
  get foregroundColor(): RGBA
  set foregroundColor(value: ColorInput)
}
```

## How It Works

The slider renders a track and a thumb:
- The **track** fills the full width/height of the renderable
- The **thumb** size is proportional to `viewPortSize / (max - min + viewPortSize)` when `viewPortSize` is set
- Without `viewPortSize`, the thumb is a fixed small size
- Mouse drag on the thumb moves the value; clicking on the track jumps to that position

## Examples

### Horizontal Slider

```tsx
<slider
  orientation="horizontal"
  value={50}
  min={0}
  max={100}
  width={30}
  height={1}
  foregroundColor="#89b4fa"
  backgroundColor="#313244"
  onChange={(value) => console.log("Value:", value)}
/>
```

### Vertical Slider

```tsx
<slider
  orientation="vertical"
  value={25}
  min={0}
  max={100}
  width={1}
  height={20}
  foregroundColor="#a6e3a1"
  backgroundColor="#313244"
/>
```

### Scrollbar-Style (Proportional Thumb)

When `viewPortSize` is set, the thumb size represents the ratio of visible content:

```tsx
<slider
  orientation="vertical"
  value={0}
  min={0}
  max={500}           // Total content height
  viewPortSize={100}  // Visible viewport height
  width={1}
  height={20}
  foregroundColor="#6c7086"
  backgroundColor="#1e1e2e"
  onChange={(scrollPosition) => {
    scrollBox.scrollTop = scrollPosition
  }}
/>
```

### Imperative Usage

```typescript
const slider = new SliderRenderable(ctx, {
  orientation: "horizontal",
  value: 50,
  min: 0,
  max: 100,
  foregroundColor: "#89b4fa",
  backgroundColor: "#313244",
  onChange: (value) => {
    console.log("New value:", value)
  },
})

parent.add(slider)

// Update value programmatically
slider.value = 75

// Change range
slider.min = 10
slider.max = 200
```

## Related Components

- [ScrollBar](./scrollbox.md#scrollbar) -- uses SliderRenderable as its track
- [ScrollBox](./scrollbox.md) -- uses ScrollBarRenderable (which uses Slider)
