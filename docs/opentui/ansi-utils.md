# ANSI & Utilities Reference

ANSI escape code constants, the console overlay, post-processing visual filters, the animation/timeline system, and general utility functions exported by `@opentui/core`.

## Table of Contents

- [ANSI Escape Codes](#ansi-escape-codes)
- [TerminalConsole](#terminalconsole)
  - [ConsoleOptions](#consoleoptions)
  - [ConsolePosition](#consoleposition)
  - [Console Actions & Key Bindings](#console-actions--key-bindings)
  - [TerminalConsole Class](#terminalconsole-class)
- [Output Capture](#output-capture)
- [Post-Processing Filters](#post-processing-filters)
  - [Stateless Filters](#stateless-filters)
  - [Stateful Effect Classes](#stateful-effect-classes)
    - [DistortionEffect](#distortioneffect)
    - [VignetteEffect](#vignetteeffect)
    - [BrightnessEffect](#brightnesseffect)
    - [BlurEffect](#blureffect)
    - [BloomEffect](#bloomeffect)
- [Animation System](#animation-system)
  - [Timeline](#timeline)
  - [TimelineOptions](#timelineoptions)
  - [AnimationOptions](#animationoptions)
  - [JSAnimation](#jsanimation)
  - [Easing Functions](#easing-functions)
  - [TimelineEngine](#timelineengine)
  - [createTimeline()](#createtimeline)
  - [Animation Usage Example](#animation-usage-example)
- [Utility Functions](#utility-functions)
  - [createTextAttributes()](#createtextattributes)
  - [attributesWithLink()](#attributeswithlink)
  - [getLinkId()](#getlinkid)
  - [visualizeRenderableTree()](#visualizeRenderableTree)
  - [isRenderable()](#isrenderable)
  - [buildKittyKeyboardFlags()](#buildkittykeyboardflags)
- [Related Documentation](#related-documentation)

---

## ANSI Escape Codes

The `ANSI` constant provides common terminal escape sequences.

```typescript
declare const ANSI: {
  // Screen buffer switching
  switchToAlternateScreen: string
  switchToMainScreen: string

  // Terminal reset
  reset: string

  // Scrolling
  scrollDown: (lines: number) => string
  scrollUp: (lines: number) => string

  // Cursor positioning
  moveCursor: (row: number, col: number) => string
  moveCursorAndClear: (row: number, col: number) => string

  // Background color
  setRgbBackground: (r: number, g: number, b: number) => string
  resetBackground: string

  // Bracketed paste mode markers
  bracketedPasteStart: string
  bracketedPasteEnd: string
}
```

**Usage notes:**
- `switchToAlternateScreen` / `switchToMainScreen` -- Switch between the main and alternate terminal screen buffers. The renderer handles this automatically when `useAlternateScreen: true`.
- `moveCursor(row, col)` -- Row and column are 1-based (ANSI convention).
- `moveCursorAndClear(row, col)` -- Moves cursor and clears from cursor to end of line.
- `scrollDown(lines)` / `scrollUp(lines)` -- Scroll the terminal content.
- `bracketedPasteStart` / `bracketedPasteEnd` -- Markers used to detect paste events.

---

## TerminalConsole

An overlay console that captures `console.log`, `console.warn`, `console.error`, and `console.debug` output and renders it within the terminal UI. It can be positioned on any edge of the screen and supports scrolling, keyboard navigation, text selection, and log export.

### ConsoleOptions

```typescript
interface ConsoleOptions {
  position?: ConsolePosition           // Where to dock the console
  sizePercent?: number                 // Size as % of terminal (default varies)
  zIndex?: number                      // Z-index for rendering order

  // Log level colors
  colorInfo?: ColorInput
  colorWarn?: ColorInput
  colorError?: ColorInput
  colorDebug?: ColorInput
  colorDefault?: ColorInput
  backgroundColor?: ColorInput

  // Title bar
  title?: string
  titleBarColor?: ColorInput
  titleBarTextColor?: ColorInput

  // Cursor
  cursorColor?: ColorInput

  // Limits
  maxStoredLogs?: number               // Max log entries stored
  maxDisplayLines?: number             // Max lines displayed

  // Debug mode
  startInDebugMode?: boolean

  // Selection & copy
  selectionColor?: ColorInput
  copyButtonColor?: ColorInput
  onCopySelection?: (text: string) => void

  // Key bindings
  keyBindings?: ConsoleKeyBinding[]
  keyAliasMap?: KeyAliasMap
}
```

### ConsolePosition

```typescript
enum ConsolePosition {
  TOP = "top"
  BOTTOM = "bottom"
  LEFT = "left"
  RIGHT = "right"
}
```

### Console Actions & Key Bindings

```typescript
type ConsoleAction =
  | "scroll-up"
  | "scroll-down"
  | "scroll-to-top"
  | "scroll-to-bottom"
  | "position-previous"
  | "position-next"
  | "size-increase"
  | "size-decrease"
  | "save-logs"
  | "copy-selection"

type ConsoleKeyBinding = BaseKeyBinding<ConsoleAction>
```

### TerminalConsole Class

```typescript
class TerminalConsole extends EventEmitter {
  constructor(renderer: CliRenderer, options?: ConsoleOptions)

  // --- Lifecycle ---
  activate(): void              // Start capturing console output
  deactivate(): void            // Stop capturing console output
  destroy(): void               // Clean up resources

  // --- Visibility ---
  toggle(): void
  show(): void
  hide(): void
  get visible(): boolean

  // --- Focus ---
  focus(): void
  blur(): void

  // --- Dimensions ---
  resize(width: number, height: number): void
  get bounds(): { x: number; y: number; width: number; height: number }

  // --- Content ---
  clear(): void
  getCachedLogs(): string       // Get all stored logs as text

  // --- Rendering ---
  renderToBuffer(buffer: OptimizedBuffer): void

  // --- Debug ---
  setDebugMode(enabled: boolean): void
  toggleDebugMode(): void

  // --- Mouse ---
  handleMouse(event: MouseEvent): boolean

  // --- Configuration ---
  set keyBindings(bindings: ConsoleKeyBinding[])
  set keyAliasMap(aliases: KeyAliasMap)
  set onCopySelection(callback: ((text: string) => void) | undefined)
  get onCopySelection(): ((text: string) => void) | undefined
}
```

---

## Output Capture

```typescript
declare const capture: Capture
```

The `capture` singleton intercepts `console.log/warn/error/debug` calls. It is used internally by `TerminalConsole` but is also exported for direct use.

---

## Post-Processing Filters

Post-process functions transform the `OptimizedBuffer` after the render pass but before the native diff/output step. Register them via `renderer.addPostProcessFn()`.

### Stateless Filters

These are pure functions that modify the buffer in place.

#### applyScanlines()

Darkens every `step`-th row to simulate a CRT scanline effect.

```typescript
declare function applyScanlines(buffer: OptimizedBuffer, strength?: number, step?: number): void
```

- `strength` -- Darkening factor (0.0 to 1.0). Default: varies.
- `step` -- Apply to every Nth row. Default: 2.

#### applyGrayscale()

Converts all buffer colors to grayscale.

```typescript
declare function applyGrayscale(buffer: OptimizedBuffer): void
```

#### applySepia()

Applies a sepia tone to all buffer colors.

```typescript
declare function applySepia(buffer: OptimizedBuffer): void
```

#### applyInvert()

Inverts all colors in the buffer.

```typescript
declare function applyInvert(buffer: OptimizedBuffer): void
```

#### applyNoise()

Adds random noise to buffer colors.

```typescript
declare function applyNoise(buffer: OptimizedBuffer, strength?: number): void
```

- `strength` -- Noise intensity (0.0 to 1.0).

#### applyChromaticAberration()

Shifts RGB channels horizontally to simulate chromatic aberration.

```typescript
declare function applyChromaticAberration(buffer: OptimizedBuffer, strength?: number): void
```

- `strength` -- Shift amount in cells.

#### applyAsciiArt()

Replaces characters with ASCII art ramp characters based on background brightness.

```typescript
declare function applyAsciiArt(buffer: OptimizedBuffer, ramp?: string): void
```

- `ramp` -- Character ramp from darkest to brightest. Default: standard ASCII art ramp.

### Stateful Effect Classes

These maintain internal state between frames for animated or cached effects.

#### DistortionEffect

Animated glitch/distortion effect that randomly shifts rows and corrupts colors.

```typescript
class DistortionEffect {
  glitchChancePerSecond: number    // Probability of glitch per second
  maxGlitchLines: number           // Max rows affected per glitch
  minGlitchDuration: number        // Min glitch duration (seconds)
  maxGlitchDuration: number        // Max glitch duration (seconds)
  maxShiftAmount: number           // Max horizontal shift
  shiftFlipRatio: number           // Chance of direction flip
  colorGlitchChance: number        // Chance of color corruption

  constructor(options?: Partial<DistortionEffect>)

  apply(buffer: OptimizedBuffer, deltaTime: number): void
}
```

**Usage:**

```typescript
const distortion = new DistortionEffect({ glitchChancePerSecond: 2.0 })
renderer.addPostProcessFn((buffer, dt) => distortion.apply(buffer, dt))
```

#### VignetteEffect

Darkens corners/edges of the buffer. Precomputes attenuation factors for performance.

```typescript
class VignetteEffect {
  constructor(strength?: number)

  get strength(): number
  set strength(value: number)

  apply(buffer: OptimizedBuffer): void
}
```

#### BrightnessEffect

Adjusts overall buffer brightness.

```typescript
class BrightnessEffect {
  constructor(brightness?: number)    // 1.0 = normal, <1.0 = darker, >1.0 = brighter

  get brightness(): number
  set brightness(value: number)

  apply(buffer: OptimizedBuffer): void
}
```

#### BlurEffect

Applies a separable box blur. Note: text may not look good when blurred.

```typescript
class BlurEffect {
  constructor(radius?: number)

  get radius(): number
  set radius(value: number)

  apply(buffer: OptimizedBuffer): void
}
```

#### BloomEffect

Applies a bloom/glow effect to bright areas.

```typescript
class BloomEffect {
  constructor(threshold?: number, strength?: number, radius?: number)

  get/set threshold: number    // Brightness threshold (0.0 to 1.0)
  get/set strength: number     // Bloom intensity
  get/set radius: number       // Blur radius for the bloom

  apply(buffer: OptimizedBuffer): void
}
```

---

## Animation System

The animation system provides a `Timeline`-based property animation engine with easing functions. Timelines are managed by a global `TimelineEngine` that integrates with the renderer's frame loop.

### Timeline

```typescript
class Timeline {
  items: (TimelineAnimationItem | TimelineCallbackItem)[]
  subTimelines: TimelineTimelineItem[]
  currentTime: number
  isPlaying: boolean
  isComplete: boolean
  duration: number
  loop: boolean
  synced: boolean

  constructor(options?: TimelineOptions)

  // Add a property animation
  add(
    target: any,
    properties: AnimationOptions,
    startTime?: number | string    // Absolute ms or relative (e.g., "+=500")
  ): this

  // Add a one-shot animation (plays once even if timeline loops)
  once(target: any, properties: AnimationOptions): this

  // Add a callback at a specific time
  call(callback: () => void, startTime?: number | string): this

  // Synchronize a sub-timeline
  sync(timeline: Timeline, startTime?: number): this

  // Playback controls
  play(): this
  pause(): this
  restart(): this
  resetItems(): void

  // Called each frame by the engine
  update(deltaTime: number): void

  // State change listeners
  addStateChangeListener(listener: (timeline: Timeline) => void): void
  removeStateChangeListener(listener: (timeline: Timeline) => void): void
}
```

### TimelineOptions

```typescript
interface TimelineOptions {
  duration?: number        // Total duration in ms (auto-calculated if not set)
  loop?: boolean           // Loop the timeline
  autoplay?: boolean       // Start playing immediately
  onComplete?: () => void  // Called when timeline completes
  onPause?: () => void     // Called when timeline pauses
}
```

### AnimationOptions

```typescript
interface AnimationOptions {
  duration: number              // Animation duration in ms
  ease?: EasingFunctions        // Easing function name
  onUpdate?: (animation: JSAnimation) => void
  onComplete?: () => void
  onStart?: () => void
  onLoop?: () => void
  loop?: boolean | number       // true = infinite, number = loop count
  loopDelay?: number            // Delay between loops in ms
  alternate?: boolean           // Reverse direction on alternate loops
  once?: boolean                // Play only once (even if timeline loops)
  [key: string]: any            // Target property values (e.g., opacity: 0, x: 100)
}
```

### JSAnimation

```typescript
interface JSAnimation {
  targets: any[]           // The animated objects
  deltaTime: number        // Time since last update
  progress: number         // 0.0 to 1.0
  currentTime: number      // Current time within animation
}
```

### Easing Functions

All easing functions take a `t` parameter (0.0 to 1.0) and return the eased value.

```typescript
type EasingFunctions =
  | "linear"
  | "inQuad" | "outQuad" | "inOutQuad"
  | "inExpo" | "outExpo"
  | "inOutSine"
  | "outBounce" | "inBounce"
  | "outElastic"
  | "inCirc" | "outCirc" | "inOutCirc"
  | "inBack" | "outBack" | "inOutBack"
```

The `inBack`, `outBack`, and `inOutBack` functions accept an optional overshoot parameter `s` (default ~1.70158).

### TimelineEngine

The global engine that manages all active timelines and integrates with the renderer frame loop.

```typescript
class TimelineEngine {
  defaults: { frameRate: number }

  attach(renderer: CliRenderer): void    // Connect to renderer's frame callback
  detach(): void                         // Disconnect from renderer

  register(timeline: Timeline): void     // Add a timeline to the engine
  unregister(timeline: Timeline): void   // Remove a timeline from the engine
  clear(): void                          // Remove all timelines

  update(deltaTime: number): void        // Manually update all timelines
}

declare const engine: TimelineEngine
```

### createTimeline()

Convenience factory that creates a `Timeline` and registers it with the global engine.

```typescript
declare function createTimeline(options?: TimelineOptions): Timeline
```

### Animation Usage Example

```typescript
import { createCliRenderer, createTimeline, engine } from "@opentui/core"

const renderer = await createCliRenderer()
engine.attach(renderer)

// Fade a renderable in over 500ms with elastic easing
const tl = createTimeline()
tl.add([myRenderable], {
  duration: 500,
  opacity: 1,
  ease: "outElastic",
  onComplete: () => console.log("Fade complete"),
})
tl.play()

// Sequence: move right, then call a function, then move down
const seq = createTimeline()
seq.add([myRenderable], { duration: 300, translateX: 20 })
seq.call(() => console.log("Halfway!"), "+=0")
seq.add([myRenderable], { duration: 300, translateY: 10 }, "+=0")
seq.play()

// Looping pulse animation
const pulse = createTimeline({ loop: true })
pulse.add([myRenderable], {
  duration: 1000,
  opacity: 0.5,
  ease: "inOutSine",
  alternate: true,
})
pulse.play()
```

---

## Utility Functions

### createTextAttributes()

Creates a text attribute bitmask from named boolean flags. See [Types Reference](./types.md#createtextattributes).

```typescript
declare function createTextAttributes(options?: {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  blink?: boolean
  inverse?: boolean
  hidden?: boolean
  strikethrough?: boolean
}): number
```

### attributesWithLink()

Encodes a hyperlink ID into the upper bits of an attribute value.

```typescript
declare function attributesWithLink(baseAttributes: number, linkId: number): number
```

### getLinkId()

Extracts the hyperlink ID from an attribute value.

```typescript
declare function getLinkId(attributes: number): number
```

### visualizeRenderableTree()

Debug utility that prints the renderable tree structure to the console.

```typescript
declare function visualizeRenderableTree(renderable: Renderable, maxDepth?: number): void
```

### isRenderable()

Type guard function.

```typescript
declare function isRenderable(obj: any): obj is Renderable
```

### buildKittyKeyboardFlags()

Builds the Kitty keyboard protocol flags bitmask from a configuration object.

```typescript
declare function buildKittyKeyboardFlags(
  config: KittyKeyboardOptions | null | undefined
): number
```

Returns 0 if config is null/undefined (disabled), or the combined flags value.

---

## Related Documentation

- [Core API Reference](./core-api.md) -- Architecture overview and main concepts
- [Types Reference](./types.md) -- All shared types and interfaces
- [Renderer Reference](./renderer.md) -- Renderer pipeline and native layer
- [Buffer Reference](./buffer.md) -- Buffer, edit buffer, and text buffer systems
