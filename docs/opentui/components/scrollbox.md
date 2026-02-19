# ScrollBox and ScrollBar Components

## ScrollBoxRenderable

`ScrollBoxRenderable` provides a scrollable container with automatic scrollbars, sticky scroll behavior, and viewport culling for performance. It extends `BoxRenderable`.

**Import:** `import { ScrollBoxRenderable } from "@opentui/core"`

### Constructor

```typescript
new ScrollBoxRenderable(ctx: RenderContext, options: ScrollBoxOptions)
```

### Internal Structure

ScrollBox is composed of several nested renderables:

```
ScrollBoxRenderable (root)
  wrapper: BoxRenderable
    viewport: BoxRenderable
      content: ContentRenderable (children go here)
    verticalScrollBar: ScrollBarRenderable
  horizontalScrollBar: ScrollBarRenderable
```

Children added to `ScrollBoxRenderable` are placed in the `content` sub-renderable.

### Props

```typescript
interface ScrollBoxOptions extends BoxOptions<ScrollBoxRenderable> {
  // Sub-component configuration
  rootOptions?: BoxOptions
  wrapperOptions?: BoxOptions
  viewportOptions?: BoxOptions
  contentOptions?: BoxOptions
  scrollbarOptions?: Omit<ScrollBarOptions, "orientation">
  verticalScrollbarOptions?: Omit<ScrollBarOptions, "orientation">
  horizontalScrollbarOptions?: Omit<ScrollBarOptions, "orientation">

  // Scroll behavior
  stickyScroll?: boolean
  stickyStart?: "bottom" | "top" | "left" | "right"
  scrollX?: boolean
  scrollY?: boolean
  scrollAcceleration?: ScrollAcceleration

  // Performance
  viewportCulling?: boolean
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `rootOptions` | `BoxOptions` | - | Options for the root box |
| `wrapperOptions` | `BoxOptions` | - | Options for the wrapper box |
| `viewportOptions` | `BoxOptions` | - | Options for the viewport box |
| `contentOptions` | `BoxOptions` | - | Options for the content container |
| `scrollbarOptions` | `ScrollBarOptions` | - | Options shared by both scrollbars |
| `verticalScrollbarOptions` | `ScrollBarOptions` | - | Vertical scrollbar options |
| `horizontalScrollbarOptions` | `ScrollBarOptions` | - | Horizontal scrollbar options |
| `stickyScroll` | `boolean` | - | Auto-scroll to follow new content |
| `stickyStart` | `"bottom" \| "top" \| "left" \| "right"` | - | Which edge to stick to |
| `scrollX` | `boolean` | - | Enable horizontal scrolling |
| `scrollY` | `boolean` | - | Enable vertical scrolling |
| `scrollAcceleration` | `ScrollAcceleration` | - | Scroll acceleration config |
| `viewportCulling` | `boolean` | - | Skip rendering off-screen children |

### Properties & Methods

```typescript
class ScrollBoxRenderable extends BoxRenderable {
  // Sub-components (read-only)
  readonly wrapper: BoxRenderable
  readonly viewport: BoxRenderable
  readonly content: ContentRenderable
  readonly horizontalScrollBar: ScrollBarRenderable
  readonly verticalScrollBar: ScrollBarRenderable

  // Scroll position
  get scrollTop(): number
  set scrollTop(value: number)
  get scrollLeft(): number
  set scrollLeft(value: number)

  // Content dimensions
  get scrollWidth(): number
  get scrollHeight(): number

  // Sticky scroll
  get stickyScroll(): boolean
  set stickyScroll(value: boolean)
  get stickyStart(): "bottom" | "top" | "left" | "right" | undefined
  set stickyStart(value: "bottom" | "top" | "left" | "right" | undefined)

  // Viewport culling
  get viewportCulling(): boolean
  set viewportCulling(value: boolean)

  // Scroll acceleration
  get scrollAcceleration(): ScrollAcceleration
  set scrollAcceleration(value: ScrollAcceleration)

  // Scrolling
  scrollBy(delta: number | { x: number; y: number }, unit?: ScrollUnit): void
  scrollTo(position: number | { x: number; y: number }): void

  // Auto-scroll during drag operations
  startAutoScroll(mouseX: number, mouseY: number): void
  updateAutoScroll(mouseX: number, mouseY: number): void
  stopAutoScroll(): void

  // Tree operations (delegates to content)
  add(obj: Renderable | VNode, index?: number): number
  insertBefore(obj: Renderable | VNode, anchor?: Renderable): number
  remove(id: string): void
  getChildren(): Renderable[]

  // Input
  handleKeyPress(key: KeyEvent): boolean

  // Sub-component options (setters)
  set rootOptions(options: ScrollBoxOptions["rootOptions"])
  set wrapperOptions(options: ScrollBoxOptions["wrapperOptions"])
  set viewportOptions(options: ScrollBoxOptions["viewportOptions"])
  set contentOptions(options: ScrollBoxOptions["contentOptions"])
  set scrollbarOptions(options: ScrollBoxOptions["scrollbarOptions"])
  set verticalScrollbarOptions(options: ScrollBoxOptions["verticalScrollbarOptions"])
  set horizontalScrollbarOptions(options: ScrollBoxOptions["horizontalScrollbarOptions"])
}
```

### ScrollUnit

```typescript
type ScrollUnit = "absolute" | "viewport" | "content" | "step"
```

| Unit | Description |
|------|-------------|
| `"absolute"` | Absolute pixel/cell position |
| `"viewport"` | Relative to viewport size |
| `"content"` | Relative to content size |
| `"step"` | Scroll step (default ~3 lines) |

### Examples

#### Basic ScrollBox

```tsx
<scrollbox height={20} scrollY>
  {items.map(item => (
    <text key={item.id}>{item.name}</text>
  ))}
</scrollbox>
```

#### Both Directions

```tsx
<scrollbox scrollX scrollY width={60} height={20}>
  {/* Wide and tall content */}
</scrollbox>
```

#### Sticky Scroll (Log Viewer)

```tsx
<scrollbox scrollY stickyScroll stickyStart="bottom" height={30}>
  {logs.map((log, i) => (
    <text key={i}>{log}</text>
  ))}
</scrollbox>
```

#### Viewport Culling (Performance)

```tsx
<scrollbox scrollY viewportCulling height={20}>
  {thousandsOfItems.map(item => (
    <text key={item.id}>{item.name}</text>
  ))}
</scrollbox>
```

#### Custom Scrollbars

```tsx
<scrollbox
  scrollY
  verticalScrollbarOptions={{
    showArrows: true,
    trackOptions: { foregroundColor: "#89b4fa" },
  }}
>
  {/* Content */}
</scrollbox>
```

#### Imperative Usage

```typescript
const scrollBox = new ScrollBoxRenderable(ctx, {
  scrollY: true,
  scrollX: false,
  viewportCulling: true,
  stickyScroll: true,
  stickyStart: "bottom",
})

// Scroll programmatically
scrollBox.scrollBy(10, "step")
scrollBox.scrollTo({ x: 0, y: 50 })

// Get scroll info
console.log(scrollBox.scrollTop, scrollBox.scrollHeight)
```

---

## ScrollBarRenderable

`ScrollBarRenderable` renders a scrollbar with optional arrow buttons and a draggable slider thumb. It extends `Renderable` and uses `SliderRenderable` internally.

**Import:** `import { ScrollBarRenderable, ArrowRenderable } from "@opentui/core"`

### Constructor

```typescript
new ScrollBarRenderable(ctx: RenderContext, options: ScrollBarOptions)
```

### Props

```typescript
interface ScrollBarOptions extends RenderableOptions<ScrollBarRenderable> {
  orientation: "vertical" | "horizontal"
  showArrows?: boolean
  arrowOptions?: Omit<ArrowOptions, "direction">
  trackOptions?: Partial<SliderOptions>
  onChange?: (position: number) => void
}
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `orientation` | `"vertical" \| "horizontal"` | required | Scrollbar direction |
| `showArrows` | `boolean` | - | Show arrow buttons at ends |
| `arrowOptions` | `ArrowOptions` | - | Arrow button configuration |
| `trackOptions` | `SliderOptions` | - | Slider track configuration |
| `onChange` | `(position: number) => void` | - | Position change callback |

### Properties & Methods

```typescript
class ScrollBarRenderable extends Renderable {
  // Sub-components (read-only)
  readonly slider: SliderRenderable
  readonly startArrow: ArrowRenderable
  readonly endArrow: ArrowRenderable
  readonly orientation: "vertical" | "horizontal"

  // Scroll state
  get scrollSize(): number
  set scrollSize(value: number)
  get scrollPosition(): number
  set scrollPosition(value: number)
  get viewportSize(): number
  set viewportSize(value: number)
  scrollStep: number | undefined | null

  // Visibility
  get visible(): boolean
  set visible(value: boolean)
  resetVisibilityControl(): void

  // Arrows
  get showArrows(): boolean
  set showArrows(value: boolean)

  // Sub-component options
  set arrowOptions(options: ScrollBarOptions["arrowOptions"])
  set trackOptions(options: ScrollBarOptions["trackOptions"])

  // Scrolling
  scrollBy(delta: number, unit?: ScrollUnit): void

  // Input
  handleKeyPress(key: KeyEvent): boolean
}
```

### ArrowRenderable

```typescript
interface ArrowOptions extends RenderableOptions<ArrowRenderable> {
  direction: "up" | "down" | "left" | "right"
  foregroundColor?: ColorInput
  backgroundColor?: ColorInput
  attributes?: number
  arrowChars?: {
    up?: string
    down?: string
    left?: string
    right?: string
  }
}

class ArrowRenderable extends Renderable {
  get direction(): "up" | "down" | "left" | "right"
  set direction(value: "up" | "down" | "left" | "right")
  get foregroundColor(): RGBA
  set foregroundColor(value: ColorInput)
  get backgroundColor(): RGBA
  set backgroundColor(value: ColorInput)
  get attributes(): number
  set attributes(value: number)
  set arrowChars(value: ArrowOptions["arrowChars"])
}
```

## Related Components

- [Box](./box.md) -- base class of ScrollBoxRenderable
- [Slider](./slider.md) -- used internally by ScrollBarRenderable
- [Markdown](./markdown.md) -- uses ScrollBox internally for scrollable content
