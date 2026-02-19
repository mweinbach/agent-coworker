# Keyboard Handling

OpenTUI provides comprehensive keyboard input handling with support for standard ANSI sequences and the Kitty keyboard protocol.

## Overview

```typescript
import { KeyEvent, KeyHandler, parseKeypress } from "@opentui/core"
```

## KeyEvent

Represents a parsed keyboard event. Created by the KeyHandler when raw input is received.

```typescript
class KeyEvent {
  name: string              // Key name ("return", "escape", "a", etc.)
  ctrl: boolean             // Ctrl modifier
  meta: boolean             // Meta/Command modifier
  shift: boolean            // Shift modifier
  option: boolean           // Alt/Option modifier
  sequence: string          // Raw escape sequence
  raw: string               // Original input bytes
  eventType: "press" | "repeat" | "release"
  source: "raw" | "kitty"  // Input protocol used
  code?: string             // Key code (Kitty protocol only)
  repeated?: boolean        // Is this a key repeat
  super?: boolean           // Super key (Kitty protocol)
  hyper?: boolean           // Hyper key (Kitty protocol)
  capsLock?: boolean        // Caps Lock state (Kitty protocol)
  numLock?: boolean         // Num Lock state (Kitty protocol)
  baseCode?: number         // Base key code before modifiers

  preventDefault(): void    // Prevent default handling
  stopPropagation(): void   // Stop event bubbling
}
```

### Key Names

| Category | Names |
|----------|-------|
| Navigation | `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown` |
| Editing | `backspace`, `delete`, `tab`, `return`, `escape`, `space` |
| Function | `f1` through `f12` |
| Letters | `a` through `z` |
| Numbers | `0` through `9` |
| Special | `insert`, `scrolllock`, `pause` |

## KeyHandler

The KeyHandler processes raw stdin data into KeyEvent objects. It is created automatically by the renderer and available as `renderer.keyInput`.

```typescript
const handler = new KeyHandler(true) // true = use Kitty protocol

handler.on("keypress", (event: KeyEvent) => {
  console.log(`Pressed: ${event.name}`)
  if (event.ctrl) console.log("Ctrl was held")
})

handler.on("keyrelease", (event: KeyEvent) => {
  console.log(`Released: ${event.name}`)
})

handler.on("paste", (event: PasteEvent) => {
  console.log(`Pasted: ${event.text}`)
})
```

## parseKeypress

Low-level function to parse a single raw input buffer into a KeyEvent.

```typescript
import { parseKeypress } from "@opentui/core/lib/parse.keypress"

const key = parseKeypress(inputBuffer, { useKittyKeyboard: true })
if (key) {
  console.log(key.name, key.ctrl, key.shift)
}
```

## Kitty Keyboard Protocol

Enhanced keyboard input supported by modern terminals (Kitty, Ghostty, WezTerm). Provides features not available with standard ANSI sequences.

```typescript
const renderer = await createCliRenderer({
  useKittyKeyboard: {
    disambiguate: true,       // Distinguish similar keys (e.g., Enter vs Ctrl+M)
    alternateKeys: true,      // Report alternate key layout codes
    events: false,            // Enable key release events
    allKeysAsEscapes: false,  // Send all keys as escape sequences
    reportText: false,        // Include text content in events
  },
})
```

### Benefits over Standard ANSI

- Key release events (track which keys are held)
- Distinguish keypad numbers from regular numbers
- Modifier key state detection (Caps Lock, Num Lock)
- Super and Hyper key support
- Key repeat information
- Unambiguous key identification

## Usage in React

```tsx
import { useKeyboard } from "@opentui/react"

function App() {
  const [key, setKey] = useState("")

  useKeyboard((event) => {
    setKey(event.name)
  }, { release: true }) // Include release events

  return <text>Last key: {key}</text>
}
```

## Usage in Solid.js

```tsx
import { useKeyboard } from "@opentui/solid"

function App() {
  const [keys, setKeys] = createSignal(new Set<string>())

  useKeyboard((event) => {
    setKeys((prev) => {
      const next = new Set(prev)
      if (event.eventType === "release") {
        next.delete(event.name)
      } else {
        next.add(event.name)
      }
      return next
    })
  }, { release: true })

  return <text>Pressed: {Array.from(keys()).join(", ")}</text>
}
```

### Options

```typescript
interface UseKeyboardOptions {
  release?: boolean  // Include release events (default: false)
}
```

## Key Combinations

```typescript
useKeyboard((event) => {
  // Ctrl+C
  if (event.ctrl && event.name === "c") {
    console.log("Copy")
  }

  // Ctrl+Shift+S
  if (event.ctrl && event.shift && event.name === "s") {
    console.log("Save As")
  }

  // Meta/Command key
  if (event.meta && event.name === "q") {
    console.log("Quit")
  }
})
```

## Prevent Default

```typescript
useKeyboard((event) => {
  if (event.name === "tab") {
    event.preventDefault() // Prevent default tab behavior
    // Custom tab handling
  }
})
```

## Key Bindings

Map keys to named actions for components like Input, Textarea, and Select.

```typescript
import { KeyBinding, buildKeyBindingsMap } from "@opentui/core/lib/keymapping"

const bindings: KeyBinding[] = [
  { key: "up", action: "move-up" },
  { key: "down", action: "move-down" },
  { key: "k", ctrl: true, action: "delete-line" },
  { key: "s", ctrl: true, action: "save" },
]

const keyMap = buildKeyBindingsMap(bindings)
```

Components accept `keyBindings` and `keyAliasMap` props to customize their keyboard behavior:

```tsx
<textarea keyBindings={[
  { key: "s", ctrl: true, action: "submit" },
  { key: "escape", action: "blur" },
]} />
```

## PasteEvent

Bracketed paste events are parsed separately from keyboard input.

```typescript
class PasteEvent {
  text: string              // Pasted text content
  preventDefault(): void
  stopPropagation(): void
}
```

React:
```tsx
// Handled automatically by <input> and <textarea>
// For custom components, use the onPaste prop
<box onPaste={(event) => console.log("Pasted:", event.text)} />
```

Solid.js:
```tsx
import { usePaste } from "@opentui/solid"

usePaste((event) => {
  console.log("Pasted:", event.text)
})
```
