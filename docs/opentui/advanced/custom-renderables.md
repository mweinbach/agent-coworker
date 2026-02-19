# Custom Renderables

Create your own renderable components by extending the base `Renderable` class.

## Overview

All OpenTUI components inherit from `Renderable` (defined in `@opentui/core`). The class provides layout (via Yoga), event handling, child management, and lifecycle hooks. You can create custom components by extending it.

## Base Classes

```
BaseRenderable (EventEmitter)
  +-- Renderable (layout, rendering, input)
        +-- BoxRenderable (borders, backgrounds)
        +-- TextBufferRenderable (text display)
        +-- ScrollBoxRenderable (scrolling)
        +-- ... other built-in components
```

## Basic Custom Renderable

```typescript
import {
  Renderable,
  RenderableOptions,
  RenderContext,
  OptimizedBuffer,
  RGBA,
} from "@opentui/core"

interface MyComponentOptions extends RenderableOptions<MyComponent> {
  text?: string
  color?: string
}

class MyComponent extends Renderable {
  private _text: string = ""
  private _color: RGBA

  constructor(ctx: RenderContext, options: MyComponentOptions) {
    super(ctx, options)
    this._text = options.text || ""
    this._color = options.color
      ? RGBA.fromHex(options.color)
      : RGBA.fromInts(255, 255, 255, 255)
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    buffer.drawText(this._text, this.x, this.y, this._color)
  }

  get text(): string {
    return this._text
  }

  set text(value: string) {
    this._text = value
    this.requestRender()  // Trigger re-render on change
  }

  get color(): RGBA {
    return this._color
  }

  set color(value: string | RGBA) {
    this._color = typeof value === "string" ? RGBA.fromHex(value) : value
    this.requestRender()
  }

  protected destroySelf(): void {
    // Clean up resources (event listeners, timers, etc.)
    super.destroySelf()
  }
}
```

## Key Methods to Override

From `Renderable`:

| Method | Purpose |
|--------|---------|
| `renderSelf(buffer, deltaTime)` | Draw your component's content to the buffer |
| `handleKeyPress(key): boolean` | Handle keyboard input; return `true` if consumed |
| `handlePaste(event)` | Handle paste input |
| `onResize(width, height)` | Called when the component's layout size changes |
| `onMouseEvent(event)` | Called on mouse events targeting this renderable |
| `onUpdate(deltaTime)` | Called each frame during layout pass |
| `destroySelf()` | Clean up when destroyed |
| `onRemove()` | Called when removed from parent |
| `onLayoutResize(width, height)` | Called when Yoga layout recalculates size |

## RenderableOptions

Options accepted by all renderables:

```typescript
interface RenderableOptions<T extends BaseRenderable = BaseRenderable> {
  // Identity
  id?: string

  // Size
  width?: number | "auto" | `${number}%`
  height?: number | "auto" | `${number}%`

  // Display
  zIndex?: number
  visible?: boolean
  opacity?: number
  buffered?: boolean         // Render to off-screen buffer
  live?: boolean             // Request continuous rendering

  // Layout (all Yoga/flexbox props from LayoutOptions)
  flexGrow?: number
  flexShrink?: number
  flexDirection?: "row" | "row-reverse" | "column" | "column-reverse"
  // ... (see components/README.md for full list)

  // Render hooks
  renderBefore?: (this: T, buffer: OptimizedBuffer, deltaTime: number) => void
  renderAfter?: (this: T, buffer: OptimizedBuffer, deltaTime: number) => void

  // Mouse events
  onMouse?: (this: T, event: MouseEvent) => void
  onMouseDown?: (this: T, event: MouseEvent) => void
  onMouseUp?: (this: T, event: MouseEvent) => void
  onMouseMove?: (this: T, event: MouseEvent) => void
  onMouseDrag?: (this: T, event: MouseEvent) => void
  onMouseDragEnd?: (this: T, event: MouseEvent) => void
  onMouseDrop?: (this: T, event: MouseEvent) => void
  onMouseOver?: (this: T, event: MouseEvent) => void
  onMouseOut?: (this: T, event: MouseEvent) => void
  onMouseScroll?: (this: T, event: MouseEvent) => void

  // Keyboard/paste
  onKeyDown?: (key: KeyEvent) => void
  onPaste?: (this: T, event: PasteEvent) => void

  // Lifecycle
  onSizeChange?: (this: T) => void
}
```

## Using with JSX

### React

```tsx
import { extend } from "@opentui/react"

// Register the component
extend({ myComponent: MyComponent })

// Add TypeScript support
declare module "@opentui/react" {
  interface OpenTUIComponents {
    myComponent: typeof MyComponent
  }
}

// Use in JSX
<myComponent text="Hello" color="#89b4fa" />
```

### Solid.js

```tsx
import { extend } from "@opentui/solid"

extend({ myComponent: MyComponent })

<myComponent text="Hello" color="#89b4fa" />
```

## Extending BoxRenderable

For components that need borders, backgrounds, and standard container behavior:

```typescript
import { BoxRenderable, BoxOptions, RenderContext, OptimizedBuffer } from "@opentui/core"

interface ButtonOptions extends BoxOptions {
  label?: string
  onPress?: () => void
}

class ButtonRenderable extends BoxRenderable {
  private _label: string = ""

  constructor(ctx: RenderContext, options: ButtonOptions) {
    super(ctx, {
      border: true,
      borderStyle: "single",
      focusable: true,
      ...options,
    })
    this._label = options.label || ""
    if (options.onPress) {
      this.onKeyDown = (key) => {
        if (key.name === "return" || key.name === "space") {
          options.onPress?.()
        }
      }
      this.onMouseDown = (event) => {
        if (event.button === 0) {
          options.onPress?.()
        }
      }
    }
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    super.renderSelf(buffer, deltaTime)
    const labelX = this.x + Math.floor((this.width - this._label.length) / 2)
    const labelY = this.y + Math.floor(this.height / 2)
    buffer.drawText(this._label, labelX, labelY, this.focusedBorderColor)
  }

  get label(): string { return this._label }
  set label(value: string) {
    this._label = value
    this.requestRender()
  }
}
```

## Handling Input

```typescript
class InteractiveComponent extends Renderable {
  constructor(ctx: RenderContext, options: RenderableOptions) {
    super(ctx, { focusable: true, ...options })
  }

  handleKeyPress(key: KeyEvent): boolean {
    switch (key.name) {
      case "up":
        this.moveUp()
        return true  // Event consumed
      case "down":
        this.moveDown()
        return true
      case "return":
        this.activate()
        return true
    }
    return false  // Event not consumed, propagate to parent
  }

  handlePaste(event: PasteEvent): void {
    // Handle pasted text
  }

  private moveUp(): void { /* ... */ }
  private moveDown(): void { /* ... */ }
  private activate(): void { /* ... */ }
}
```

## Focus Management

Renderables participate in the focus system:

```typescript
class FocusableComponent extends Renderable {
  constructor(ctx: RenderContext, options: RenderableOptions) {
    super(ctx, { ...options })
    this._focusable = true  // Enable focus
  }

  // Focus/blur are inherited from Renderable
  // this.focus()    -- Request focus
  // this.blur()     -- Release focus
  // this.focused    -- Check if focused

  // Listen to focus events
  // this.on(RenderableEvents.FOCUSED, () => { ... })
  // this.on(RenderableEvents.BLURRED, () => { ... })
}
```

## Child Management

Renderable provides built-in child management with z-index ordering:

```typescript
// Add children
parent.add(child)                     // Add to end
parent.add(child, 0)                  // Add at index
parent.insertBefore(child, anchor)    // Insert before another child

// Remove children
parent.remove(child.id)

// Query children
parent.getChildren()                  // All children
parent.getChildrenCount()             // Count
parent.getRenderable("child-id")      // By ID
parent.findDescendantById("deep-id")  // Recursive search
```

## Lifecycle

```typescript
class MyComponent extends Renderable {
  protected onResize(width: number, height: number): void {
    // Called when layout size changes
    // Recalculate internal state based on new dimensions
  }

  protected onRemove(): void {
    // Called when removed from parent
  }

  protected destroySelf(): void {
    // Called by destroy() -- clean up resources
    // Remove event listeners, clear timers, free memory
    super.destroySelf()
  }
}

// External lifecycle
const component = new MyComponent(ctx, options)
parent.add(component)           // Add to tree
component.requestRender()       // Request re-render
component.destroy()             // Clean up this node
component.destroyRecursively()  // Clean up this node and all children
```

## Buffered Rendering

For off-screen rendering (useful for complex components):

```typescript
class BufferedComponent extends Renderable {
  constructor(ctx: RenderContext, options: RenderableOptions) {
    super(ctx, { buffered: true, ...options })
  }

  // When buffered=true, renderSelf receives the component's
  // own frame buffer rather than the main screen buffer.
  // The framework composites it into the main buffer automatically.
}
```

## Performance Tips

1. **Call `requestRender()` only when visual state changes** -- avoid calling it in getters or read-only operations
2. **Cache expensive calculations** -- don't recalculate in `renderSelf()` on every frame
3. **Use `buffered: true`** for complex renderables that don't change often
4. **Clean up in `destroySelf()`** -- remove event listeners, clear timers, free resources
5. **Return `true` from `handleKeyPress`** when you consume the event to prevent unnecessary propagation
