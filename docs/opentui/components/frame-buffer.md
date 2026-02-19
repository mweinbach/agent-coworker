# FrameBuffer Component

`FrameBufferRenderable` provides a raw pixel/cell buffer for custom rendering. It extends `Renderable` and exposes an `OptimizedBuffer` that you can draw into directly. It is the base class for `ASCIIFontRenderable`.

**Import:** `import { FrameBufferRenderable } from "@opentui/core"`

## Constructor

```typescript
new FrameBufferRenderable(ctx: RenderContext, options: FrameBufferOptions)
```

## Props

```typescript
interface FrameBufferOptions extends RenderableOptions<FrameBufferRenderable> {
  width: number             // Required: buffer width in cells
  height: number            // Required: buffer height in cells
  respectAlpha?: boolean    // Whether to blend alpha when compositing
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `width` | `number` | required | Width of the frame buffer in cells |
| `height` | `number` | required | Height of the frame buffer in cells |
| `respectAlpha` | `boolean` | - | Blend alpha values when rendering to parent buffer |

## Properties & Methods

```typescript
class FrameBufferRenderable extends Renderable {
  // The raw buffer -- draw into this
  frameBuffer: OptimizedBuffer

  // Lifecycle (protected, override in subclasses)
  protected onResize(width: number, height: number): void
  protected renderSelf(buffer: OptimizedBuffer): void
  protected destroySelf(): void
}
```

The `frameBuffer` is an `OptimizedBuffer` instance. On resize, the buffer is recreated to match the new dimensions. During rendering, the contents of `frameBuffer` are composited onto the parent buffer.

## OptimizedBuffer API

The `OptimizedBuffer` provides low-level drawing operations:

```typescript
class OptimizedBuffer {
  // Drawing
  drawText(text: string, x: number, y: number, fg: RGBA, bg?: RGBA, attributes?: number): void
  drawChar(char: string, x: number, y: number, fg: RGBA, bg?: RGBA, attributes?: number): void
  fill(char: string, fg: RGBA, bg: RGBA, x: number, y: number, width: number, height: number): void
  fillBackground(bg: RGBA, x: number, y: number, width: number, height: number): void
  clear(): void

  // Dimensions
  readonly width: number
  readonly height: number
}
```

## Examples

### Custom Drawing

```typescript
import { FrameBufferRenderable } from "@opentui/core"
import { RGBA } from "@opentui/core"

class CustomRenderable extends FrameBufferRenderable {
  constructor(ctx, options) {
    super(ctx, { ...options, width: 20, height: 5 })
    this.draw()
  }

  private draw() {
    const fb = this.frameBuffer
    fb.clear()

    const white = RGBA.fromHex("#ffffff")
    const blue = RGBA.fromHex("#89b4fa")

    // Draw a border
    fb.fill("-", white, blue, 0, 0, 20, 1)      // Top
    fb.fill("-", white, blue, 0, 4, 20, 1)      // Bottom
    fb.fill("|", white, blue, 0, 1, 1, 3)       // Left
    fb.fill("|", white, blue, 19, 1, 1, 3)      // Right

    // Draw text
    fb.drawText("Hello!", 7, 2, white)

    this.requestRender()
  }
}
```

### Progress Bar

```typescript
class ProgressBar extends FrameBufferRenderable {
  private _progress = 0

  constructor(ctx, width) {
    super(ctx, { width, height: 1 })
  }

  set progress(value: number) {
    this._progress = Math.max(0, Math.min(1, value))
    this.redraw()
  }

  private redraw() {
    const fb = this.frameBuffer
    fb.clear()

    const filled = Math.round(this._progress * fb.width)
    const green = RGBA.fromHex("#a6e3a1")
    const gray = RGBA.fromHex("#313244")
    const white = RGBA.fromHex("#ffffff")

    // Filled portion
    fb.fill("=", white, green, 0, 0, filled, 1)
    // Unfilled portion
    fb.fill("-", white, gray, filled, 0, fb.width - filled, 1)

    this.requestRender()
  }
}
```

### Using Directly (Imperative)

```typescript
const fb = new FrameBufferRenderable(ctx, {
  width: 40,
  height: 10,
  respectAlpha: true,
})

parent.add(fb)

// Draw into the buffer
fb.frameBuffer.clear()
fb.frameBuffer.drawText("Custom content", 0, 0, RGBA.fromHex("#cdd6f4"))
fb.requestRender()
```

### Via Composition

```typescript
import { FrameBuffer } from "@opentui/core/renderables/composition/constructs"

const vnode = FrameBuffer({ width: 20, height: 5 })
```

## Related Components

- [ASCIIFont](./ascii-font.md) -- extends FrameBufferRenderable for ASCII art text
- [VRenderable](../advanced/composition-system.md) -- alternative for custom rendering via render function
