# OpenTUI Documentation

OpenTUI is a high-performance TypeScript framework for building rich terminal user interfaces (TUIs) with React and Solid.js support.

## Key Features

- **Native Performance** -- Zig-powered rendering engine with optimized buffer management
- **Flexbox Layout** -- Yoga layout engine (same as React Native) for flexible UI composition
- **React and Solid.js** -- First-class framework bindings with full JSX support
- **Rich Components** -- Box, Text, Input, Select, Code, Markdown, Diff, ScrollBox, and more
- **Syntax Highlighting** -- Tree-sitter integration for incremental, worker-based code highlighting
- **3D Rendering** -- WebGPU-based 3D with Three.js, physics (Rapier/Planck), particles, and sprites
- **Full Input** -- Keyboard (including Kitty protocol), mouse, paste, and selection support
- **Testing** -- Dedicated test renderer with mock keyboard/mouse and frame capture
- **Streaming** -- Optimized for LLM streaming with incremental parsing in Code and Markdown

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| `@opentui/core` | 0.1.80 | Core rendering engine, components, utilities, 3D, and testing |
| `@opentui/solid` | 0.1.80 | Solid.js renderer with fine-grained reactivity |
| `@opentui/react` | 0.1.77 | React reconciler with hooks and DevTools support |

## Quick Start

```bash
bun install @opentui/core @opentui/solid
```

```tsx
import { render } from "@opentui/solid"

function App() {
  return (
    <box flex flexDirection="column" padding={1} border borderColor="#89b4fa">
      <text fg="#cdd6f4">Hello, Terminal!</text>
    </box>
  )
}

render(() => <App />)
```

## Architecture

```
+---------------------------------------------------------------+
|                      Your Application                         |
+-----------------------------+---------------------------------+
|       @opentui/react        |         @opentui/solid          |
|    (React Reconciler)       |     (Solid.js Renderer)         |
+-----------------------------+---------------------------------+
|                        @opentui/core                          |
|  +-------------+  +------------+  +-------------------------+ |
|  | Renderables |  |  Renderer  |  |       Utilities         | |
|  | Box, Text,  |  | CliRenderer|  | Keyboard, Mouse, RGBA,  | |
|  | Input, Code |  | TestRender |  | StyledText, TreeSitter  | |
|  +-------------+  +------------+  +-------------------------+ |
|  +-------------+  +------------+  +-------------------------+ |
|  |     3D      |  |  Physics   |  |      Animation          | |
|  | Three.js,   |  | Rapier2D,  |  | Sprites, Particles,     | |
|  | WebGPU      |  | Planck     |  | Explosions              | |
|  +-------------+  +------------+  +-------------------------+ |
+---------------------------------------------------------------+
|                   Native Layer (Zig + FFI)                     |
|            Buffer Management, Terminal I/O, Hit Grid           |
+---------------------------------------------------------------+
```

## Table of Contents

### Getting Started

- [Installation](./installation.md) -- Setup, configuration, and first app
- [Core API](./core-api.md) -- Imperative API reference (renderer, renderable, buffer, events, types)

### Components

- [Components Overview](./components/README.md) -- Common props, lifecycle, usage patterns
- [Box](./components/box.md) -- Container with flexbox layout, borders, backgrounds
- [Text](./components/text.md) -- Styled text display with StyledText and TextNode
- [Input](./components/input.md) -- Single-line text input
- [Textarea](./components/textarea.md) -- Multi-line text editor with undo/redo
- [Select](./components/select.md) -- Vertical list selection
- [ScrollBox](./components/scrollbox.md) -- Scrollable container with viewport culling
- [Code](./components/code.md) -- Syntax-highlighted code display
- [Diff](./components/diff.md) -- Unified and split diff viewer
- [Markdown](./components/markdown.md) -- Markdown renderer with streaming support
- [ASCIIFont](./components/ascii-font.md) -- ASCII art text rendering
- [Slider](./components/slider.md) -- Range slider component
- [LineNumber](./components/line-numbers.md) -- Line number gutter
- [FrameBuffer](./components/frame-buffer.md) -- Raw frame buffer rendering
- [TextBuffer](./components/text-buffer.md) -- Text buffer display

### Framework Integration

- [React](./react.md) -- React reconciler, hooks, JSX elements, DevTools
- [Solid.js](./solid.md) -- Solid.js renderer, hooks, Portal, Dynamic

### Core Internals

- [Types](./core/types.md) -- Core type definitions (RGBA, TextAttributes, RenderContext, etc.)
- [Renderer](./core/renderer.md) -- CliRenderer lifecycle, rendering pipeline, capabilities
- [Buffer](./core/buffer.md) -- OptimizedBuffer API for cell-level rendering
- [ANSI Utilities](./core/ansi-utils.md) -- ANSI escape sequence helpers

### Utilities

- [Utilities Overview](./utilities/README.md) -- Quick reference for all utility modules
- [Keyboard](./utilities/keyboard.md) -- KeyEvent, KeyHandler, Kitty protocol, key bindings
- [Mouse](./utilities/mouse.md) -- MouseEvent, MouseParser, hit testing, pointer styles
- [Colors](./utilities/colors.md) -- RGBA class, color parsing, terminal palette detection
- [Styled Text](./utilities/styled-text.md) -- Composable rich text with template literals
- [Tree-Sitter](./utilities/tree-sitter.md) -- Syntax highlighting client and buffer management

### Advanced

- [Custom Renderables](./advanced/custom-renderables.md) -- Extending Renderable, JSX registration
- [Composition System](./advanced/composition-system.md) -- VNode, h(), vstyles, delegate pattern
- [Animation](./advanced/animation.md) -- Timeline-based animation system
- [Physics](./advanced/physics.md) -- Rapier2D and Planck integration

### 3D

- [3D Support](./3d.md) -- Three.js, WebGPU, sprites, particles, physics

### Testing

- [Testing](./testing.md) -- Test renderer, mock input/mouse, frame capture, recorder

## License

MIT
