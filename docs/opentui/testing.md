# Testing

OpenTUI provides a comprehensive testing toolkit for terminal UI components. The testing module includes a headless renderer, mock keyboard and mouse input, a frame recorder for visual regression testing, spy utilities, and a mock tree-sitter client for syntax highlighting tests.

## Table of Contents

- [Installation and Import](#installation-and-import)
- [TestRenderer](#testrenderer)
  - [TestRendererOptions](#testrendereroptions)
  - [TestRenderer Interface](#testrenderer-interface)
  - [createTestRenderer()](#createtestrenderer)
  - [Output Capture](#output-capture)
- [Mock Keyboard Input](#mock-keyboard-input)
  - [KeyCodes](#keycodes)
  - [KeyInput Type](#keyinput-type)
  - [MockKeysOptions](#mockkeysoptions)
  - [createMockKeys()](#createmockkeys)
  - [Keyboard Methods](#keyboard-methods)
  - [Key Modifiers](#key-modifiers)
  - [Keyboard Protocols](#keyboard-protocols)
- [Mock Mouse Input](#mock-mouse-input)
  - [MouseButtons](#mousebuttons)
  - [Mouse Types](#mouse-types)
  - [createMockMouse()](#createmockmouse)
  - [Mouse Methods](#mouse-methods)
- [TestRecorder](#testrecorder)
  - [RecordedFrame](#recordedframe)
  - [RecordedBuffers](#recordedbuffers)
  - [RecordBuffersOptions](#recordbuffersoptions)
  - [TestRecorderOptions](#testrecorderoptions)
  - [TestRecorder Class](#testrecorder-class)
- [Spy Utility](#spy-utility)
  - [createSpy()](#createspy)
- [MockTreeSitterClient](#mocktreesitterclient)
- [Renderable Test Utilities](#renderable-test-utilities)
  - [createTextareaRenderable()](#createtextarearenderable)
- [Testing Patterns and Best Practices](#testing-patterns-and-best-practices)
  - [Basic Component Test](#basic-component-test)
  - [Keyboard Interaction Test](#keyboard-interaction-test)
  - [Mouse Interaction Test](#mouse-interaction-test)
  - [Visual Regression with TestRecorder](#visual-regression-with-testrecorder)
  - [Testing with Syntax Highlighting](#testing-with-syntax-highlighting)
  - [React Component Testing](#react-component-testing)
  - [Solid Component Testing](#solid-component-testing)
- [Best Practices](#best-practices)

---

## Installation and Import

All testing utilities are exported from the `@opentui/core/testing` barrel module:

```typescript
import {
  createTestRenderer,
  createMockKeys,
  createMockMouse,
  MockTreeSitterClient,
  TestRecorder,
  createSpy,
  KeyCodes,
  MouseButtons,
} from "@opentui/core/testing"
```

Individual modules can also be imported directly:

```typescript
import { createTestRenderer } from "@opentui/core/testing/test-renderer"
import { createMockKeys, KeyCodes } from "@opentui/core/testing/mock-keys"
import { createMockMouse, MouseButtons } from "@opentui/core/testing/mock-mouse"
import { MockTreeSitterClient } from "@opentui/core/testing/mock-tree-sitter-client"
import { TestRecorder } from "@opentui/core/testing/test-recorder"
import { createSpy } from "@opentui/core/testing/spy"
```

---

## TestRenderer

The `TestRenderer` is a headless `CliRenderer` designed for automated testing. It runs without a real terminal, providing programmatic control over rendering, input simulation, and output capture.

### TestRendererOptions

```typescript
interface TestRendererOptions extends CliRendererConfig {
  width?: number
  height?: number
  kittyKeyboard?: boolean
  otherModifiersMode?: boolean
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | `number` | `80` | Viewport width in columns |
| `height` | `number` | `24` | Viewport height in rows |
| `kittyKeyboard` | `boolean` | `false` | Enable Kitty keyboard protocol for enhanced key reporting |
| `otherModifiersMode` | `boolean` | `false` | Enable modifyOtherKeys mode for extended modifier reporting |

`TestRendererOptions` extends `CliRendererConfig`, so all standard renderer configuration options (such as `targetFps`, `maxFps`, `debounceDelay`, `backgroundColor`, `useMouse`, etc.) are also available.

### TestRenderer Interface

```typescript
interface TestRenderer extends CliRenderer {}
```

`TestRenderer` is a full `CliRenderer` instance. It exposes the complete renderer API including `root`, focus management, buffer access, and event emission. The difference is that it operates headlessly without terminal I/O.

### createTestRenderer()

```typescript
function createTestRenderer(options: TestRendererOptions): Promise<{
  renderer: TestRenderer
  mockInput: MockInput
  mockMouse: MockMouse
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
  captureSpans: () => CapturedFrame
  resize: (width: number, height: number) => void
}>
```

Creates and initializes a test renderer with all associated mock utilities. This is the primary entry point for testing.

**Return value:**

| Property | Type | Description |
|----------|------|-------------|
| `renderer` | `TestRenderer` | The headless renderer instance. Use `renderer.root.add()` to attach renderables. |
| `mockInput` | `MockInput` | Mock keyboard input controller (see [Mock Keyboard Input](#mock-keyboard-input)) |
| `mockMouse` | `MockMouse` | Mock mouse input controller (see [Mock Mouse Input](#mock-mouse-input)) |
| `renderOnce` | `() => Promise<void>` | Triggers a single render pass. Call after state changes to update the frame buffer. |
| `captureCharFrame` | `() => string` | Captures the current frame as a plain text string (characters only, no color data). |
| `captureSpans` | `() => CapturedFrame` | Captures the current frame as structured span data with full color and attribute information. |
| `resize` | `(width: number, height: number) => void` | Resizes the virtual viewport. Triggers layout recalculation on next render. |

### Output Capture

#### captureCharFrame()

Returns the rendered frame as a plain string. Useful for text-content assertions.

```typescript
const frame = captureCharFrame()
// "┌──────────────┐\n│ Hello World! │\n└──────────────┘"
```

#### captureSpans()

Returns structured frame data with color and attribute information, typed as `CapturedFrame`:

```typescript
interface CapturedSpan {
  text: string
  fg: RGBA
  bg: RGBA
  attributes: number
  width: number
}

interface CapturedLine {
  spans: CapturedSpan[]
}

interface CapturedFrame {
  cols: number
  rows: number
  cursor: [number, number]
  lines: CapturedLine[]
}
```

```typescript
const frame = captureSpans()
// {
//   cols: 80,
//   rows: 24,
//   cursor: [10, 5],
//   lines: [
//     { spans: [{ text: "Hello", fg: RGBA, bg: RGBA, attributes: 0, width: 5 }] }
//   ]
// }
```

The `attributes` field is a bitmask using the `TextAttributes` constants:

```typescript
import { TextAttributes } from "@opentui/core"

// TextAttributes.NONE          = 0
// TextAttributes.BOLD          = 1
// TextAttributes.DIM           = 2
// TextAttributes.ITALIC        = 4
// TextAttributes.UNDERLINE     = 8
// TextAttributes.BLINK         = 16
// TextAttributes.INVERSE       = 32
// TextAttributes.HIDDEN        = 64
// TextAttributes.STRIKETHROUGH = 128
```

---

## Mock Keyboard Input

The mock keyboard system simulates terminal keyboard input by injecting raw ANSI escape sequences into the renderer's input stream.

### KeyCodes

```typescript
const KeyCodes: {
  readonly RETURN: "\r"
  readonly LINEFEED: "\n"
  readonly TAB: "\t"
  readonly BACKSPACE: "\b"
  readonly DELETE: "\x1b[3~"
  readonly HOME: "\x1b[H"
  readonly END: "\x1b[F"
  readonly ESCAPE: "\x1b"
  readonly ARROW_UP: "\x1b[A"
  readonly ARROW_DOWN: "\x1b[B"
  readonly ARROW_RIGHT: "\x1b[C"
  readonly ARROW_LEFT: "\x1b[D"
  readonly F1: "\x1bOP"
  readonly F2: "\x1bOQ"
  readonly F3: "\x1bOR"
  readonly F4: "\x1bOS"
  readonly F5: "\x1b[15~"
  readonly F6: "\x1b[17~"
  readonly F7: "\x1b[18~"
  readonly F8: "\x1b[19~"
  readonly F9: "\x1b[20~"
  readonly F10: "\x1b[21~"
  readonly F11: "\x1b[23~"
  readonly F12: "\x1b[24~"
}
```

### KeyInput Type

```typescript
type KeyInput = string | keyof typeof KeyCodes
```

Any string character (e.g., `"a"`, `"Z"`, `"1"`) or a `KeyCodes` key name (e.g., `"RETURN"`, `"ARROW_UP"`).

### MockKeysOptions

```typescript
interface MockKeysOptions {
  kittyKeyboard?: boolean
  otherModifiersMode?: boolean
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `kittyKeyboard` | `boolean` | `false` | Generate Kitty keyboard protocol sequences |
| `otherModifiersMode` | `boolean` | `false` | Generate modifyOtherKeys sequences |

### createMockKeys()

```typescript
function createMockKeys(
  renderer: CliRenderer,
  options?: MockKeysOptions
): {
  pressKeys: (keys: KeyInput[], delayMs?: number) => Promise<void>
  pressKey: (key: KeyInput, modifiers?: KeyModifiers) => void
  typeText: (text: string, delayMs?: number) => Promise<void>
  pressEnter: (modifiers?: KeyModifiers) => void
  pressEscape: (modifiers?: KeyModifiers) => void
  pressTab: (modifiers?: KeyModifiers) => void
  pressBackspace: (modifiers?: KeyModifiers) => void
  pressArrow: (direction: "up" | "down" | "left" | "right", modifiers?: KeyModifiers) => void
  pressCtrlC: () => void
  pasteBracketedText: (text: string) => Promise<void>
}
```

When using `createTestRenderer()`, the returned `mockInput` is an instance of this type.

### Keyboard Methods

| Method | Description |
|--------|-------------|
| `pressKey(key, modifiers?)` | Press a single key with optional modifiers. Synchronous. |
| `pressKeys(keys, delayMs?)` | Press multiple keys in sequence with optional delay between each. Returns a Promise. |
| `typeText(text, delayMs?)` | Type a string character by character with optional delay. Returns a Promise. |
| `pressEnter(modifiers?)` | Press the Enter/Return key. |
| `pressEscape(modifiers?)` | Press the Escape key. |
| `pressTab(modifiers?)` | Press the Tab key. |
| `pressBackspace(modifiers?)` | Press the Backspace key. |
| `pressArrow(direction, modifiers?)` | Press an arrow key in the given direction. |
| `pressCtrlC()` | Press Ctrl+C (sends interrupt signal). |
| `pasteBracketedText(text)` | Simulate a bracketed paste operation (wraps text in bracketed paste escape sequences). |

### Key Modifiers

All methods accepting modifiers use this shape:

```typescript
interface KeyModifiers {
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  hyper?: boolean
}
```

### Keyboard Protocols

The mock keyboard supports three encoding modes:

- **Standard ANSI** (default) -- Traditional escape sequences compatible with all terminals.
- **Kitty Keyboard Protocol** (`kittyKeyboard: true`) -- Enhanced protocol that disambiguates keys, reports modifier state precisely, and supports press/repeat/release events.
- **modifyOtherKeys** (`otherModifiersMode: true`) -- xterm extension for reporting modified keys that would otherwise be ambiguous.

These are set via `TestRendererOptions` when creating the test renderer, and the mock keyboard automatically generates the correct sequences.

---

## Mock Mouse Input

The mock mouse system simulates SGR mouse events in the renderer's input stream.

### MouseButtons

```typescript
const MouseButtons: {
  readonly LEFT: 0
  readonly MIDDLE: 1
  readonly RIGHT: 2
  readonly WHEEL_UP: 64
  readonly WHEEL_DOWN: 65
  readonly WHEEL_LEFT: 66
  readonly WHEEL_RIGHT: 67
}

type MouseButton = (typeof MouseButtons)[keyof typeof MouseButtons]
// 0 | 1 | 2 | 64 | 65 | 66 | 67
```

### Mouse Types

```typescript
interface MousePosition {
  x: number
  y: number
}

interface MouseModifiers {
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
}

type MouseEventType = "down" | "up" | "move" | "drag" | "scroll"

interface MouseEventOptions {
  button?: MouseButton
  modifiers?: MouseModifiers
  delayMs?: number
}
```

### createMockMouse()

```typescript
function createMockMouse(renderer: CliRenderer): {
  moveTo: (x: number, y: number, options?: MouseEventOptions) => Promise<void>
  click: (x: number, y: number, button?: MouseButton, options?: MouseEventOptions) => Promise<void>
  doubleClick: (x: number, y: number, button?: MouseButton, options?: MouseEventOptions) => Promise<void>
  pressDown: (x: number, y: number, button?: MouseButton, options?: MouseEventOptions) => Promise<void>
  release: (x: number, y: number, button?: MouseButton, options?: MouseEventOptions) => Promise<void>
  drag: (startX: number, startY: number, endX: number, endY: number, button?: MouseButton, options?: MouseEventOptions) => Promise<void>
  scroll: (x: number, y: number, direction: "up" | "down" | "left" | "right", options?: MouseEventOptions) => Promise<void>
  getCurrentPosition: () => MousePosition
  getPressedButtons: () => MouseButton[]
  emitMouseEvent: (type: MouseEventType, x: number, y: number, button?: MouseButton, options?: Omit<MouseEventOptions, "button">) => Promise<void>
}
```

### Mouse Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `moveTo` | `(x, y, options?) => Promise<void>` | Move cursor to position without pressing any button. |
| `click` | `(x, y, button?, options?) => Promise<void>` | Click at position (press + release). Defaults to left button. |
| `doubleClick` | `(x, y, button?, options?) => Promise<void>` | Double-click at position. |
| `pressDown` | `(x, y, button?, options?) => Promise<void>` | Press and hold a button at position. |
| `release` | `(x, y, button?, options?) => Promise<void>` | Release a held button at position. |
| `drag` | `(startX, startY, endX, endY, button?, options?) => Promise<void>` | Drag from start to end position. |
| `scroll` | `(x, y, direction, options?) => Promise<void>` | Scroll at position in a direction. |
| `getCurrentPosition` | `() => MousePosition` | Get the current cursor position. |
| `getPressedButtons` | `() => MouseButton[]` | Get list of currently pressed buttons. |
| `emitMouseEvent` | `(type, x, y, button?, options?) => Promise<void>` | Emit a raw mouse event of any type. Low-level API for custom scenarios. |

All mouse coordinates are 0-indexed column/row positions.

---

## TestRecorder

`TestRecorder` records frames from a `TestRenderer` by hooking into the render pipeline. It captures the character frame after each native render pass, making it ideal for visual regression testing and animation verification.

### RecordedFrame

```typescript
interface RecordedFrame {
  frame: string
  timestamp: number
  frameNumber: number
  buffers?: RecordedBuffers
}
```

| Field | Type | Description |
|-------|------|-------------|
| `frame` | `string` | The rendered frame as plain text (same format as `captureCharFrame()`). |
| `timestamp` | `number` | Milliseconds since recording started. |
| `frameNumber` | `number` | Sequential frame counter (starts at 1). |
| `buffers` | `RecordedBuffers?` | Optional raw buffer data (foreground, background, attributes) if buffer recording is enabled. |

### RecordedBuffers

```typescript
interface RecordedBuffers {
  fg?: Float32Array
  bg?: Float32Array
  attributes?: Uint8Array
}
```

| Field | Type | Description |
|-------|------|-------------|
| `fg` | `Float32Array?` | Raw foreground color buffer (RGBA floats). |
| `bg` | `Float32Array?` | Raw background color buffer (RGBA floats). |
| `attributes` | `Uint8Array?` | Raw text attribute buffer (bitmask per cell). |

### RecordBuffersOptions

```typescript
interface RecordBuffersOptions {
  fg?: boolean
  bg?: boolean
  attributes?: boolean
}
```

Controls which raw buffers to capture alongside the text frame.

### TestRecorderOptions

```typescript
interface TestRecorderOptions {
  recordBuffers?: RecordBuffersOptions
  now?: () => number
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `recordBuffers` | `RecordBuffersOptions` | `undefined` | Which raw buffers to record per frame. If omitted, only text frames are recorded. |
| `now` | `() => number` | `Date.now` | Custom time source for deterministic timestamps in tests. |

### TestRecorder Class

```typescript
class TestRecorder {
  constructor(renderer: TestRenderer, options?: TestRecorderOptions)

  /** Start recording frames. Hooks into the renderer's renderNative method. */
  rec(): void

  /** Stop recording frames and restore the original renderNative method. */
  stop(): void

  /** Get all recorded frames. */
  get recordedFrames(): RecordedFrame[]

  /** Clear all recorded frames and reset the frame counter. */
  clear(): void

  /** Check if currently recording. */
  get isRecording(): boolean
}
```

**Lifecycle:** `rec()` patches the renderer's internal `renderNative` method to capture each frame. `stop()` restores the original method. Calling `rec()` while already recording, or `stop()` while not recording, is safe (no-op).

---

## Spy Utility

A lightweight function spy for tracking calls in tests, without depending on external mocking libraries.

### createSpy()

```typescript
function createSpy(): {
  (...args: any[]): void
  calls: any[][]
  callCount(): number
  calledWith(...expected: any[]): boolean
  reset(): number
}
```

The returned spy is a callable function that also exposes inspection properties:

| Property / Method | Type | Description |
|-------------------|------|-------------|
| `(...args)` | `(...args: any[]) => void` | Call the spy. Arguments are recorded. |
| `calls` | `any[][]` | Array of argument arrays for each call. `calls[0]` is the args of the first call. |
| `callCount()` | `() => number` | Returns the total number of times the spy was called. |
| `calledWith(...expected)` | `(...expected: any[]) => boolean` | Returns `true` if any call had the given arguments (shallow equality). |
| `reset()` | `() => number` | Clears all recorded calls. Returns the number of calls that were cleared. |

```typescript
const spy = createSpy()

spy("a", 1)
spy("b", 2)

spy.callCount()        // 2
spy.calls              // [["a", 1], ["b", 2]]
spy.calledWith("a", 1) // true
spy.calledWith("c", 3) // false
spy.reset()            // 2 (cleared 2 calls)
spy.callCount()        // 0
```

---

## MockTreeSitterClient

A mock implementation of `TreeSitterClient` for testing syntax highlighting behavior without real tree-sitter WASM parsers.

```typescript
class MockTreeSitterClient extends TreeSitterClient {
  constructor(options?: {
    autoResolveTimeout?: number
  })

  /** Override: returns a pending promise that resolves when you call resolveHighlightOnce(). */
  highlightOnce(content: string, filetype: string): Promise<{
    highlights?: SimpleHighlight[]
    warning?: string
    error?: string
  }>

  /** Set the result that will be returned when highlights are resolved. */
  setMockResult(result: {
    highlights?: SimpleHighlight[]
    warning?: string
    error?: string
  }): void

  /** Resolve a specific pending highlightOnce call by index (default: 0, the oldest). */
  resolveHighlightOnce(index?: number): void

  /** Resolve all pending highlightOnce calls. */
  resolveAllHighlightOnce(): void

  /** Check if there are any pending (unresolved) highlight requests. */
  isHighlighting(): boolean
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoResolveTimeout` | `number` | `undefined` | If set, pending highlights auto-resolve after this many milliseconds. |

**SimpleHighlight format:**

```typescript
type SimpleHighlight = [
  startCol: number,
  endCol: number,
  group: string,
  meta?: HighlightMeta
]
```

The mock gives you full control over when and how highlights resolve, letting you test loading states, error cases, and incremental highlighting behavior.

---

## Renderable Test Utilities

Additional helpers for testing specific renderables are available under the `renderables/__tests__/` namespace.

### createTextareaRenderable()

```typescript
import { createTextareaRenderable } from "@opentui/core/renderables/__tests__/renderable-test-utils"

function createTextareaRenderable(
  renderer: TestRenderer,
  renderOnce: () => Promise<void>,
  options: TextareaOptions
): Promise<{
  textarea: TextareaRenderable
  root: any
}>
```

A convenience factory that creates a `TextareaRenderable`, attaches it to the renderer root, and returns it ready for testing along with the root renderable.

---

## Testing Patterns and Best Practices

### Basic Component Test

```typescript
import { createTestRenderer } from "@opentui/core/testing"
import { BoxRenderable } from "@opentui/core"
import { describe, test, expect, beforeEach } from "bun:test"

describe("BoxRenderable", () => {
  let renderer, renderOnce, captureCharFrame

  beforeEach(async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 })
    renderer = setup.renderer
    renderOnce = setup.renderOnce
    captureCharFrame = setup.captureCharFrame
  })

  test("renders a bordered box", async () => {
    const box = new BoxRenderable(renderer, {
      width: 20,
      height: 5,
      border: "single",
    })
    renderer.root.add(box)
    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toContain("┌")
    expect(frame).toContain("└")
  })
})
```

### Keyboard Interaction Test

```typescript
import { createTestRenderer, createSpy } from "@opentui/core/testing"
import { InputRenderable } from "@opentui/core"
import { describe, test, expect, beforeEach } from "bun:test"

describe("Input Component", () => {
  let renderer, mockInput, renderOnce, captureCharFrame

  beforeEach(async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 })
    renderer = setup.renderer
    mockInput = setup.mockInput
    renderOnce = setup.renderOnce
    captureCharFrame = setup.captureCharFrame
  })

  test("displays typed text", async () => {
    const input = new InputRenderable(renderer, {
      width: 20,
      placeholder: "Type here...",
    })
    renderer.root.add(input)
    input.focus()
    await renderOnce()

    // Verify placeholder
    let frame = captureCharFrame()
    expect(frame).toContain("Type here...")

    // Type and verify
    await mockInput.typeText("hello")
    await renderOnce()

    frame = captureCharFrame()
    expect(frame).toContain("hello")
  })

  test("submits on Enter", async () => {
    const onSubmit = createSpy()
    const input = new InputRenderable(renderer, { onSubmit })
    renderer.root.add(input)
    input.focus()
    await renderOnce()

    await mockInput.typeText("test")
    mockInput.pressEnter()
    await renderOnce()

    expect(onSubmit.callCount()).toBe(1)
    expect(onSubmit.calledWith("test")).toBe(true)
  })

  test("handles arrow key navigation", async () => {
    const input = new InputRenderable(renderer, { width: 20 })
    renderer.root.add(input)
    input.focus()
    await renderOnce()

    await mockInput.typeText("hello world")
    mockInput.pressArrow("left")
    mockInput.pressArrow("left")
    mockInput.pressBackspace()
    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toContain("hello wold")
  })

  test("handles Ctrl+C", async () => {
    const input = new InputRenderable(renderer, { width: 20 })
    renderer.root.add(input)
    input.focus()
    await renderOnce()

    await mockInput.typeText("some text")
    mockInput.pressCtrlC()
    await renderOnce()

    // Verify behavior after Ctrl+C
  })

  test("handles bracketed paste", async () => {
    const input = new InputRenderable(renderer, { width: 40 })
    renderer.root.add(input)
    input.focus()
    await renderOnce()

    await mockInput.pasteBracketedText("pasted content")
    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toContain("pasted content")
  })
})
```

### Mouse Interaction Test

```typescript
import { createTestRenderer, createSpy, MouseButtons } from "@opentui/core/testing"
import { describe, test, expect, beforeEach } from "bun:test"

describe("Mouse Interactions", () => {
  let renderer, mockMouse, renderOnce, captureCharFrame

  beforeEach(async () => {
    const setup = await createTestRenderer({ width: 40, height: 20 })
    renderer = setup.renderer
    mockMouse = setup.mockMouse
    renderOnce = setup.renderOnce
    captureCharFrame = setup.captureCharFrame
  })

  test("handles click events", async () => {
    // Set up a clickable component
    // ...
    await mockMouse.click(10, 5)
    await renderOnce()

    // Assert click was handled
  })

  test("handles drag operations", async () => {
    await mockMouse.drag(5, 5, 20, 5, MouseButtons.LEFT)
    await renderOnce()

    // Assert drag selection
  })

  test("handles scroll events", async () => {
    await mockMouse.scroll(10, 10, "down")
    await renderOnce()

    // Assert scroll offset changed
  })

  test("handles modified clicks", async () => {
    await mockMouse.click(10, 5, MouseButtons.LEFT, {
      modifiers: { shift: true },
    })
    await renderOnce()

    // Assert shift-click behavior (e.g., range selection)
  })

  test("tracks cursor position", async () => {
    await mockMouse.moveTo(15, 8)
    const pos = mockMouse.getCurrentPosition()
    expect(pos.x).toBe(15)
    expect(pos.y).toBe(8)
  })

  test("tracks pressed buttons", async () => {
    await mockMouse.pressDown(10, 5, MouseButtons.LEFT)
    expect(mockMouse.getPressedButtons()).toContain(MouseButtons.LEFT)

    await mockMouse.release(10, 5, MouseButtons.LEFT)
    expect(mockMouse.getPressedButtons()).not.toContain(MouseButtons.LEFT)
  })
})
```

### Visual Regression with TestRecorder

```typescript
import { createTestRenderer, TestRecorder } from "@opentui/core/testing"
import { describe, test, expect } from "bun:test"

describe("Animation", () => {
  test("records frame sequence", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 40,
      height: 10,
    })

    // Use a fixed time source for deterministic timestamps
    let time = 0
    const recorder = new TestRecorder(renderer, {
      now: () => time,
      recordBuffers: { fg: true, bg: true },
    })

    // Set up animated component
    // ...

    recorder.rec()

    // Simulate animation frames
    for (let i = 0; i < 5; i++) {
      time += 16 // ~60fps
      await renderOnce()
    }

    recorder.stop()

    const frames = recorder.recordedFrames
    expect(frames).toHaveLength(5)
    expect(frames[0].frameNumber).toBe(1)
    expect(frames[0].timestamp).toBe(0)
    expect(frames[1].timestamp).toBe(16)

    // Each frame has text content
    expect(frames[0].frame).toBeDefined()

    // Each frame has buffer data
    expect(frames[0].buffers?.fg).toBeInstanceOf(Float32Array)
    expect(frames[0].buffers?.bg).toBeInstanceOf(Float32Array)

    // Compare frames for visual changes
    expect(frames[0].frame).not.toBe(frames[4].frame)
  })

  test("can clear and re-record", async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      width: 40,
      height: 10,
    })
    const recorder = new TestRecorder(renderer)

    recorder.rec()
    await renderOnce()
    recorder.stop()

    expect(recorder.recordedFrames).toHaveLength(1)

    recorder.clear()
    expect(recorder.recordedFrames).toHaveLength(0)

    recorder.rec()
    await renderOnce()
    await renderOnce()
    recorder.stop()

    expect(recorder.recordedFrames).toHaveLength(2)
  })
})
```

### Testing with Syntax Highlighting

```typescript
import { createTestRenderer, MockTreeSitterClient } from "@opentui/core/testing"
import { CodeRenderable } from "@opentui/core"
import { describe, test, expect } from "bun:test"

describe("Code with Syntax Highlighting", () => {
  test("renders highlighted code", async () => {
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({
      width: 60,
      height: 10,
    })

    const mockClient = new MockTreeSitterClient()

    // Set up expected highlights: "function" keyword at cols 0-8
    mockClient.setMockResult({
      highlights: [
        [0, 8, "keyword"],
        [9, 14, "function"],
        [14, 15, "punctuation.bracket"],
        [15, 16, "punctuation.bracket"],
      ],
    })

    // Create code component with mock client
    const code = new CodeRenderable(renderer, {
      content: 'function hello() { return "world" }',
      filetype: "typescript",
      treeSitterClient: mockClient,
    })
    renderer.root.add(code)

    // Resolve the pending highlight request
    mockClient.resolveHighlightOnce()
    await renderOnce()

    // Verify with structured span data
    const frame = captureSpans()
    // Inspect spans for applied highlight styles
  })

  test("handles highlight errors gracefully", async () => {
    const mockClient = new MockTreeSitterClient()
    mockClient.setMockResult({
      error: "Parser not found for filetype: unknown",
    })

    // Test that the component handles the error without crashing
    mockClient.resolveHighlightOnce()
    // ... assertions
  })

  test("supports async highlight loading", async () => {
    const mockClient = new MockTreeSitterClient()

    // Don't resolve immediately -- test the loading state
    const highlightPromise = mockClient.highlightOnce("const x = 1", "typescript")
    expect(mockClient.isHighlighting()).toBe(true)

    // Now resolve
    mockClient.setMockResult({
      highlights: [[0, 5, "keyword"]],
    })
    mockClient.resolveHighlightOnce()

    const result = await highlightPromise
    expect(result.highlights).toHaveLength(1)
    expect(mockClient.isHighlighting()).toBe(false)
  })
})
```

### React Component Testing

```tsx
import { testRender } from "@opentui/react"
import { describe, test, expect } from "bun:test"

test("React component renders and handles input", async () => {
  const { mockInput, renderOnce, captureCharFrame } =
    await testRender(<MyComponent />)

  await renderOnce()
  await mockInput.typeText("hello")
  await renderOnce()

  expect(captureCharFrame()).toContain("hello")
})
```

### Solid Component Testing

```tsx
import { testRender } from "@opentui/solid"
import { describe, test, expect } from "bun:test"

test("Solid component renders and handles input", async () => {
  const { mockInput, renderOnce, captureCharFrame } =
    await testRender(() => <MyComponent />)

  await renderOnce()
  await mockInput.typeText("hello")
  await renderOnce()

  expect(captureCharFrame()).toContain("hello")
})
```

---

## Best Practices

1. **Always `await renderOnce()` after state changes.** The test renderer does not auto-render. You must explicitly trigger a render pass after input simulation or state mutations before capturing output.

2. **Use `captureCharFrame()` for content assertions, `captureSpans()` for style assertions.** Text matching is simpler and more readable for verifying what is displayed. Use span data only when you need to verify colors, attributes, or precise layout.

3. **Set explicit dimensions.** Always specify `width` and `height` in `TestRendererOptions` to ensure deterministic layout across test environments.

4. **Use `createSpy()` for callback verification.** It is purpose-built for OpenTUI testing and avoids dependencies on external mocking libraries.

5. **Use `TestRecorder` with a fixed `now()` function.** This produces deterministic timestamps, making frame-by-frame assertions reliable.

6. **Use `MockTreeSitterClient` instead of real parsers.** Real tree-sitter requires WASM binaries and a worker thread. The mock lets you control exactly when and what highlights are produced, and avoids filesystem dependencies in tests.

7. **Prefer `beforeEach` for setup.** Create a fresh test renderer per test to avoid state leakage between tests.

8. **Clean up recorders.** Call `recorder.stop()` and `recorder.clear()` when done to avoid accumulating frame data in memory during large test suites.

9. **Test keyboard protocols separately if needed.** If your component has different behavior under Kitty keyboard protocol vs standard ANSI, create separate test renderers with `kittyKeyboard: true` and `kittyKeyboard: false`.

10. **Use `resize()` to test responsive layouts.** The test renderer supports dynamic resizing, so you can verify that components reflow correctly at different terminal sizes.
