# Solid API Reference

## Rendering

### render(node, rendererOrConfig?)

Renders a Solid component tree into a CLI renderer.

```tsx
import { render } from "@opentui/solid"

// Simple usage - creates renderer automatically
render(() => <App />)

// With config
render(() => <App />, {
  exitOnCtrlC: false,
  targetFPS: 60,
})

// With existing renderer
import { createCliRenderer } from "@opentui/core"

const renderer = await createCliRenderer()
render(() => <App />, renderer)
```

### testRender(node, options?)

Create a test renderer for snapshots and tests.

```tsx
import { testRender } from "@opentui/solid"

const testSetup = await testRender(() => <App />, {
  width: 40,
  height: 10,
})

// Access test utilities
testSetup.snapshot()  // Get current render
testSetup.renderer    // Access renderer
```

### extend(components)

Register custom renderables as JSX intrinsic elements.

```tsx
import { extend } from "@opentui/solid"
import { CustomRenderable } from "./custom"

extend({
  custom: CustomRenderable,
})

// Now usable in JSX
<custom prop="value" />
```

### getComponentCatalogue()

Returns the current component catalogue.

```tsx
import { getComponentCatalogue } from "@opentui/solid"

const catalogue = getComponentCatalogue()
console.log(Object.keys(catalogue))
```

## Hooks

### useRenderer()

Access the OpenTUI renderer instance.

```tsx
import { useRenderer } from "@opentui/solid"
import { onMount } from "solid-js"

function App() {
  const renderer = useRenderer()
  
  onMount(() => {
    console.log(`Terminal: ${renderer.width}x${renderer.height}`)
    renderer.console.show()
  })
  
  return <text>Hello</text>
}
```

### useKeyboard(handler, options?)

Handle keyboard events.

```tsx
import { useKeyboard, useRenderer } from "@opentui/solid"

function App() {
  const renderer = useRenderer()
  
  useKeyboard((key) => {
    if (key.name === "escape") {
      renderer.destroy()  // Never use process.exit() directly!
    }
    if (key.ctrl && key.name === "s") {
      saveDocument()
    }
  })
  
  return <text>Press ESC to exit</text>
}

// With release events
function GameControls() {
  const [pressed, setPressed] = createSignal(new Set<string>())
  
  useKeyboard(
    (event) => {
      setPressed(keys => {
        const newKeys = new Set(keys)
        if (event.eventType === "release") {
          newKeys.delete(event.name)
        } else {
          newKeys.add(event.name)
        }
        return newKeys
      })
    },
    { release: true }
  )
  
  return <text>Pressed: {Array.from(pressed()).join(", ")}</text>
}
```

### usePaste(handler)

Handle paste events.

```tsx
import { usePaste } from "@opentui/solid"

function PasteHandler() {
  usePaste((text) => {
    console.log("Pasted:", text)
  })
  
  return <text>Paste something</text>
}
```

### onResize(callback)

Handle terminal resize events.

```tsx
import { onResize } from "@opentui/solid"

function App() {
  onResize((width, height) => {
    console.log(`Resized to ${width}x${height}`)
  })
  
  return <text>Resize the terminal</text>
}
```

### useTerminalDimensions()

Get reactive terminal dimensions.

```tsx
import { useTerminalDimensions } from "@opentui/solid"

function ResponsiveLayout() {
  const dimensions = useTerminalDimensions()
  
  return (
    <box flexDirection={dimensions().width > 80 ? "row" : "column"}>
      <text>Width: {dimensions().width}</text>
      <text>Height: {dimensions().height}</text>
    </box>
  )
}
```

### useSelectionHandler(handler)

Handle text selection events.

```tsx
import { useSelectionHandler } from "@opentui/solid"

function SelectableText() {
  useSelectionHandler((selection) => {
    console.log("Selected:", selection.text)
  })
  
  return <text selectable>Select this text</text>
}
```

### useTimeline(options?)

Create animations with the timeline system.

```tsx
import { useTimeline } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"

function AnimatedBox() {
  const [width, setWidth] = createSignal(0)
  
  const timeline = useTimeline({
    duration: 2000,
    loop: false,
  })
  
  onMount(() => {
    timeline.add(
      { width: 0 },
      {
        width: 50,
        duration: 2000,
        ease: "easeOutQuad",
        onUpdate: (anim) => {
          setWidth(Math.round(anim.targets[0].width))
        },
      }
    )
  })
  
  return <box style={{ width: width(), height: 3, backgroundColor: "#6a5acd" }} />
}
```

## Components

### Text Component

```tsx
<text
  content="Hello"           // Or use children
  fg="#FFFFFF"              // Foreground color
  bg="#000000"              // Background color
  selectable={true}         // Allow text selection
>
  {/* Use nested modifier tags for styling */}
  <span fg="red">Red</span>
  <strong>Bold</strong>
  <em>Italic</em>
  <u>Underline</u>
  <br />
  <a href="https://...">Link</a>
</text>
```

> **Note**: Do NOT use `bold`, `italic`, `underline` as props on `<text>`. Use nested modifier tags like `<strong>`, `<em>`, `<u>` instead.

### Box Component

```tsx
<box
  // Borders
  border                    // Enable border
  borderStyle="single"      // single | double | rounded | bold
  borderColor="#FFFFFF"
  title="Title"
  titleAlignment="center"   // left | center | right
  
  // Colors
  backgroundColor="#1a1a2e"
  
  // Layout
  flexDirection="row"
  justifyContent="center"
  alignItems="center"
  gap={2}
  
  // Spacing
  padding={2}
  margin={1}
  
  // Dimensions
  width={40}
  height={10}
  flexGrow={1}
  
  // Events
  onMouseDown={(e) => {}}
  onMouseUp={(e) => {}}
>
  {children}
</box>
```

### Scrollbox Component

```tsx
<scrollbox
  focused                   // Enable keyboard scrolling
  style={{
    scrollbarOptions: {
      showArrows: true,
      trackOptions: {
        foregroundColor: "#7aa2f7",
        backgroundColor: "#414868",
      },
    },
  }}
>
  <For each={items()}>
    {(item) => <text>{item}</text>}
  </For>
</scrollbox>
```

### Input Component

```tsx
<input
  value={value()}
  onInput={(newValue) => setValue(newValue)}
  placeholder="Enter text..."
  focused
  width={30}
/>
```

### Textarea Component

```tsx
<textarea
  value={text()}
  onInput={(newValue) => setText(newValue)}
  placeholder="Enter multiple lines..."
  focused
  width={40}
  height={10}
/>
```

### Select Component

```tsx
<select
  options={[
    { name: "Option 1", description: "First", value: "1" },
    { name: "Option 2", description: "Second", value: "2" },
  ]}
  onChange={(index, option) => setSelected(option)}
  selectedIndex={0}
  focused
/>
```

### Tab Select Component (Note: underscore)

```tsx
<tab_select
  options={[
    { name: "Home", description: "Dashboard" },
    { name: "Settings", description: "Configuration" },
  ]}
  onChange={(index, option) => setTab(option)}
  tabWidth={20}
  focused
/>
```

### ASCII Font Component (Note: underscore)

```tsx
<ascii_font
  text="TITLE"
  font="tiny"               // tiny | block | slick | shade
  color="#FFFFFF"
/>
```

### Code Component

```tsx
<code
  code={sourceCode}
  language="typescript"
/>
```

### Line Number Component (Note: underscore)

```tsx
<line_number
  code={sourceCode}
  language="typescript"
  startLine={1}
  highlightedLines={[5]}
/>
```

### Diff Component

```tsx
<diff
  oldCode={originalCode}
  newCode={modifiedCode}
  language="typescript"
  mode="unified"            // unified | split
/>
```

## Control Flow

Solid's control flow components work with OpenTUI:

### For

```tsx
import { For } from "solid-js"

<For each={items()}>
  {(item, index) => (
    <box key={index()}>
      <text>{item.name}</text>
    </box>
  )}
</For>
```

### Show

```tsx
import { Show } from "solid-js"

<Show when={isVisible()} fallback={<text>Hidden</text>}>
  <text>Visible content</text>
</Show>
```

### Switch/Match

```tsx
import { Switch, Match } from "solid-js"

<Switch>
  <Match when={status() === "loading"}>
    <text>Loading...</text>
  </Match>
  <Match when={status() === "error"}>
    <text fg="red">Error!</text>
  </Match>
  <Match when={status() === "success"}>
    <text fg="green">Success!</text>
  </Match>
</Switch>
```

### Index

```tsx
import { Index } from "solid-js"

<Index each={items()}>
  {(item, index) => (
    <text>{index}: {item().name}</text>
  )}
</Index>
```

## Special Components

### Portal

```tsx
import { Portal } from "@opentui/solid"

<Portal mount={targetNode}>
  <box>Portal content</box>
</Portal>
```

### Dynamic

```tsx
import { Dynamic } from "@opentui/solid"

<Dynamic
  component={isMultiline() ? "textarea" : "input"}
  placeholder="Enter text..."
  focused
/>
```
