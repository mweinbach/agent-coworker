# Mouse Handling

OpenTUI provides comprehensive mouse input handling with support for SGR extended mouse mode and hit testing.

## Overview

```typescript
import { MouseEvent, MouseParser } from "@opentui/core"
```

## MouseEvent

Represents a parsed mouse event with position, button, modifiers, and target information.

```typescript
class MouseEvent {
  type: MouseEventType      // Event type (see table below)
  button: number            // 0=left, 1=middle, 2=right
  x: number                 // Column position
  y: number                 // Row position
  target: Renderable | null // Renderable under the cursor
  modifiers: {
    shift: boolean
    alt: boolean
    ctrl: boolean
  }
  scroll?: ScrollInfo       // Present for scroll events
  isDragging?: boolean      // True during drag operations

  preventDefault(): void
  stopPropagation(): void
}
```

### ScrollInfo

```typescript
interface ScrollInfo {
  direction: "up" | "down" | "left" | "right"
  delta: number
}
```

## Mouse Event Types

| Type | Description |
|------|-------------|
| `down` | Mouse button pressed |
| `up` | Mouse button released |
| `move` | Mouse moved (no button held) |
| `drag` | Mouse moved while button pressed |
| `drag-end` | Drag ended (button released after drag) |
| `drop` | Content dropped on target |
| `over` | Mouse entered a renderable's bounds |
| `out` | Mouse left a renderable's bounds |
| `scroll` | Scroll wheel rotated |

## Mouse Buttons

```typescript
const MouseButton = {
  LEFT: 0,
  MIDDLE: 1,
  RIGHT: 2,
  WHEEL_UP: 4,
  WHEEL_DOWN: 5,
}
```

## MouseParser

Low-level parser for raw terminal mouse input. Used internally by the renderer.

```typescript
import { MouseParser } from "@opentui/core/lib/parse.mouse"

const parser = new MouseParser()

// Parse single event
const event = parser.parseMouseEvent(inputBuffer)

// Parse multiple buffered events
const events = parser.parseAllMouseEvents(inputBuffer)

// Reset parser state
parser.reset()
```

## Usage on Renderables

All renderables accept mouse event handler props:

```tsx
<box
  onMouseDown={(event) => console.log("Clicked at", event.x, event.y)}
  onMouseUp={(event) => console.log("Released")}
  onMouseMove={(event) => console.log("Moving")}
  onMouseScroll={(event) => console.log("Scrolling", event.scroll)}
/>
```

### Available Mouse Props

```typescript
interface RenderableOptions {
  onMouse?: (event: MouseEvent) => void         // All mouse events
  onMouseDown?: (event: MouseEvent) => void      // Button press
  onMouseUp?: (event: MouseEvent) => void        // Button release
  onMouseMove?: (event: MouseEvent) => void      // Movement
  onMouseDrag?: (event: MouseEvent) => void      // Drag (move while pressed)
  onMouseDragEnd?: (event: MouseEvent) => void   // Drag ended
  onMouseDrop?: (event: MouseEvent) => void      // Drop target
  onMouseOver?: (event: MouseEvent) => void      // Enter bounds
  onMouseOut?: (event: MouseEvent) => void       // Leave bounds
  onMouseScroll?: (event: MouseEvent) => void    // Scroll wheel
}
```

## Drag and Drop

```tsx
<box
  onMouseDown={(event) => {
    dragStart = { x: event.x, y: event.y }
  }}
  onMouseDrag={(event) => {
    // Update position during drag
    box.x = event.x - dragStart.x
    box.y = event.y - dragStart.y
  }}
  onMouseDragEnd={(event) => {
    console.log("Drag ended")
  }}
/>
```

## Hover Effects

```tsx
const [hovered, setHovered] = useState(false)

<box
  onMouseOver={() => setHovered(true)}
  onMouseOut={() => setHovered(false)}
  backgroundColor={hovered ? "#89b4fa" : "#6c7086"}
>
  <text>Hover me</text>
</box>
```

## Scroll Handling

```tsx
<box
  onMouseScroll={(event) => {
    if (event.scroll?.direction === "down") {
      scrollBox.scrollBy(3)
    } else if (event.scroll?.direction === "up") {
      scrollBox.scrollBy(-3)
    }
  }}
/>
```

## Right-Click Context Menu

```tsx
<box
  onMouseDown={(event) => {
    if (event.button === 2) { // Right click
      showContextMenu(event.x, event.y)
    }
  }}
/>
```

## Mouse Pointer Styles

Change the cursor appearance when hovering over elements:

```typescript
type MousePointerStyle = "default" | "pointer" | "text" | "crosshair" | "move" | "not-allowed"

renderer.setMousePointer("pointer")      // Hand cursor
renderer.setMousePointer("text")         // I-beam cursor
renderer.setMousePointer("default")      // Default cursor
renderer.setMousePointer("not-allowed")  // Forbidden cursor
```

## Hit Testing

Find which renderable is at a given screen position:

```typescript
// Returns the renderable number at position
const renderableNum = renderer.hitTest(x, y)

// Look up the renderable by number
const renderable = Renderable.renderablesByNumber.get(renderableNum)
```

The hit grid is maintained automatically by the renderer based on renderable positions and z-index order.

## Enabling Mouse

Mouse input is enabled by default. Configure it in the renderer options:

```typescript
const renderer = await createCliRenderer({
  useMouse: true,              // Enable mouse tracking (default: true)
  enableMouseMovement: true,   // Track mouse movement even without button press (default: true)
})
```

## Mouse Protocols

OpenTUI supports multiple mouse protocols and automatically negotiates the best one:

- **SGR (1006)** -- Extended mouse mode with unlimited coordinates (recommended)
- **UTF-8 (1005)** -- UTF-8 encoded coordinates
- **X10 (9)** -- Basic mouse press reporting only

Most modern terminals support SGR mode, which provides the most accurate position reporting and modifier key tracking.
