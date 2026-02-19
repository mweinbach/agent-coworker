# Installation

## Requirements

- **Bun** >= 1.0 (recommended) or Node.js >= 18
- **Terminal** with true color support (recommended)

## Quick Start

### Create a New Project

```bash
# Using the project generator
bun create tui --template react
# or
bun create tui --template solid
```

### Manual Installation

```bash
# Core package (required)
bun install @opentui/core

# Choose your framework
bun install @opentui/react  # For React (requires react >= 19)
bun install @opentui/solid  # For Solid.js (requires solid-js 1.9.x)
```

## TypeScript Configuration

### React

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "strict": true,
    "skipLibCheck": true
  }
}
```

### Solid.js

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid",
    "strict": true,
    "skipLibCheck": true
  }
}
```

Create `bunfig.toml` to enable the Solid JSX transform:

```toml
preload = ["@opentui/solid/preload"]
```

## Basic Setup

### Imperative (Core Only)

```typescript
import { createCliRenderer, BoxRenderable, TextRenderable, RGBA } from "@opentui/core"

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
})

const box = new BoxRenderable(renderer, {
  backgroundColor: RGBA.fromHex("#1e1e2e"),
  border: true,
  borderColor: RGBA.fromHex("#89b4fa"),
  padding: 1,
})

const text = new TextRenderable(renderer, {
  content: "Hello, World!",
  fg: RGBA.fromHex("#cdd6f4"),
})

box.add(text)
renderer.root.add(box)
```

### React

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

function App() {
  return (
    <box
      backgroundColor="#1e1e2e"
      border
      borderColor="#89b4fa"
      padding={1}
    >
      <text fg="#cdd6f4">Hello, World!</text>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
```

### Solid.js

```tsx
import { render } from "@opentui/solid"

function App() {
  return (
    <box
      backgroundColor="#1e1e2e"
      border
      borderColor="#89b4fa"
      padding={1}
    >
      <text fg="#cdd6f4">Hello, World!</text>
    </box>
  )
}

render(() => <App />)
```

## Renderer Configuration

```typescript
interface CliRendererConfig {
  // Input/Output streams (defaults to process.stdin/stdout)
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream

  // Exit behavior
  exitOnCtrlC?: boolean          // Default: true
  exitSignals?: NodeJS.Signals[] // Default: ["SIGINT", "SIGTERM"]

  // Performance
  targetFps?: number             // Default: 60
  maxFps?: number                // Default: 120
  debounceDelay?: number         // Default: 16

  // Terminal settings
  useAlternateScreen?: boolean   // Default: true
  useMouse?: boolean             // Default: true
  enableMouseMovement?: boolean  // Default: true
  autoFocus?: boolean            // Default: true

  // Kitty keyboard protocol
  useKittyKeyboard?: {
    disambiguate?: boolean       // Default: true
    alternateKeys?: boolean      // Default: true
    events?: boolean             // Default: false
    allKeysAsEscapes?: boolean   // Default: false
    reportText?: boolean         // Default: false
  }

  // Console integration
  useConsole?: boolean           // Enable console overlay
  openConsoleOnError?: boolean   // Auto-open on errors

  // Background color
  backgroundColor?: ColorInput

  // Lifecycle
  onDestroy?: () => void
}
```

## Optional Dependencies

### Syntax Highlighting

```bash
bun install web-tree-sitter
```

Required for the `<code>`, `<markdown>`, and `<diff>` components to perform syntax highlighting. Tree-sitter runs in a worker thread for non-blocking parsing.

### 3D Support

```bash
bun install three
```

Required for `ThreeRenderable` and the `@opentui/core/3d` module. Uses WebGPU via `bun-webgpu` for GPU-accelerated 3D rendering in the terminal.

### React DevTools

```bash
bun install --dev react-devtools-core@7
```

Enables React DevTools integration for inspecting the component tree. Start DevTools with `npx react-devtools@7`, then run your app with `DEV=true`.

## Running Your App

```bash
# Development
bun run your-app.tsx

# With React DevTools
DEV=true bun run your-app.tsx
```

## Solid.js Production Builds

For production builds with Solid.js, use the bundler plugin:

```ts
import solidPlugin from "@opentui/solid/bun-plugin"

await Bun.build({
  entrypoints: ["./index.tsx"],
  plugins: [solidPlugin],
})
```

## Terminal Compatibility

OpenTUI works best with terminals supporting:

- **True Color** (24-bit color)
- **Kitty Keyboard Protocol** (enhanced keyboard input)
- **Kitty Graphics Protocol** (image/3D rendering)
- **Mouse tracking** (SGR extended mode)

Compatible terminals:

- [Kitty](https://sw.kovidgoyal.net/kitty/) (recommended -- full protocol support)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://alacritty.org/)
