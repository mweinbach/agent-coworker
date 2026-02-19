# Composition System

OpenTUI's composition system provides a declarative, VNode-based approach to building UI trees. It includes the `h()` hyperscript function, pre-built construct functions, the `VRenderable` class for custom render logic, text styling helpers (`vstyles`), and the `delegate` pattern for proxying methods through a tree.

**Import:** `import { h, VNode, isVNode, instantiate, maybeMakeRenderable, delegate } from "@opentui/core"`

## VNode

A `VNode` is a lightweight virtual node describing a component to be instantiated:

```typescript
interface VNode<P = any, C = VChild[]> {
  type: Construct<P>                          // Constructor or functional construct
  props?: P                                   // Properties to pass
  children?: C                                // Child nodes
  __delegateMap?: Record<string, string>      // Method delegation mapping
  __pendingCalls?: PendingCall[]              // Deferred method calls
}

type VChild = VNode | Renderable | VChild[] | null | undefined | false

interface PendingCall {
  method: string
  args: any[]
  isProperty?: boolean
}
```

### Construct Types

A `Construct` can be either a class constructor or a functional factory:

```typescript
interface RenderableConstructor<P extends RenderableOptions<any> = RenderableOptions<any>> {
  new (ctx: RenderContext, options: P): Renderable
}

type FunctionalConstruct<P = any> = (props: P, children?: VChild[]) => VNode
type Construct<P = any> = RenderableConstructor<P> | FunctionalConstruct<P>
```

### ProxiedVNode

`ProxiedVNode` extends `VNode` with a Proxy that records method/property calls for deferred replay on instantiation:

```typescript
type ProxiedVNode<TCtor extends RenderableConstructor<any>> =
  VNode<...> & {
    [K in keyof InstanceType<TCtor>]: InstanceType<TCtor>[K] extends (...args: infer Args) => any
      ? (...args: Args) => ProxiedVNode<TCtor>
      : InstanceType<TCtor>[K]
  }
```

This enables method chaining on VNodes:

```typescript
const vnode = Box({ id: "box" })
// Pending calls are recorded, replayed when instantiated
```

## h() Function

The `h()` (hyperscript) function creates VNodes, similar to `React.createElement`:

```typescript
// With class constructor
function h<TCtor extends RenderableConstructor<any>>(
  type: TCtor,
  props?: TCtor extends RenderableConstructor<infer P> ? P : never,
  ...children: VChild[]
): ProxiedVNode<TCtor>

// With functional construct
function h<P>(
  type: FunctionalConstruct<P>,
  props?: P,
  ...children: VChild[]
): VNode<P>

// Generic overload
function h<P>(
  type: Construct<P>,
  props?: P,
  ...children: VChild[]
): VNode<P> | ProxiedVNode<any>
```

### Example

```typescript
const vnode = h(BoxRenderable,
  { backgroundColor: "#1e1e2e", padding: 1 },
  h(TextRenderable, { fg: "#cdd6f4" }, "Hello, World!")
)
```

## Construct Functions

Pre-built VNode factory functions for each component:

```typescript
import {
  Box, Text, Input, Select, TabSelect,
  ScrollBox, Code, ASCIIFont, FrameBuffer, Generic
} from "@opentui/core/renderables/composition/constructs"

function Box(props?: BoxOptions, ...children: VChild[]): ProxiedVNode<typeof BoxRenderable>
function Text(props?: TextOptions, ...children: VChild[]): ProxiedVNode<typeof TextRenderable>
function Input(props?: InputRenderableOptions, ...children: VChild[]): ProxiedVNode<typeof InputRenderable>
function Select(props?: SelectRenderableOptions, ...children: VChild[]): ProxiedVNode<typeof SelectRenderable>
function TabSelect(props?: TabSelectRenderableOptions, ...children: VChild[]): ProxiedVNode<typeof TabSelectRenderable>
function ScrollBox(props?: ScrollBoxOptions, ...children: VChild[]): ProxiedVNode<typeof ScrollBoxRenderable>
function Code(props: CodeOptions, ...children: VChild[]): ProxiedVNode<typeof CodeRenderable>
function ASCIIFont(props?: ASCIIFontOptions, ...children: VChild[]): ProxiedVNode<typeof ASCIIFontRenderable>
function FrameBuffer(props: FrameBufferOptions, ...children: VChild[]): ProxiedVNode<typeof FrameBufferRenderable>
function Generic(props?: VRenderableOptions, ...children: VChild[]): ProxiedVNode<typeof VRenderable>
```

### Example

```typescript
const vnode = Box(
  { backgroundColor: "#1e1e2e", flexDirection: "column" },
  Text({ fg: "#cdd6f4" }, "Label"),
  Input({ placeholder: "Enter text..." })
)
```

## instantiate()

Converts a VNode into an actual Renderable instance:

```typescript
function instantiate<NodeType extends VNode | Renderable>(
  ctx: RenderContext,
  node: NodeType
): InstantiateFn<NodeType>

type InstantiateFn<NodeType extends VNode | Renderable> = Renderable & {
  __node?: NodeType
}
```

### Example

```typescript
const vnode = Box({ padding: 1 }, Text({}, "Hello"))
const renderable = instantiate(ctx, vnode)
renderer.root.add(renderable)
```

## isVNode() and maybeMakeRenderable()

### isVNode

```typescript
function isVNode(node: any): node is VNode
```

### maybeMakeRenderable

Convert a VNode, Renderable, or unknown value to a Renderable:

```typescript
function maybeMakeRenderable(
  ctx: RenderContext,
  node: Renderable | VNode<any, any[]> | unknown
): Renderable | null
```

Returns `null` if the input is not a valid VNode or Renderable.

## VRenderable

A concrete `Renderable` subclass that accepts a custom render function as a prop. This allows functional-style custom rendering without subclassing:

```typescript
interface VRenderableOptions extends RenderableOptions<VRenderable> {
  render?: (
    this: VRenderable | VRenderableOptions,
    buffer: OptimizedBuffer,
    deltaTime: number,
    renderable: VRenderable
  ) => void
}

class VRenderable extends Renderable {
  constructor(ctx: RenderContext, options: VRenderableOptions)
  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void
}
```

### Example

```typescript
const custom = new VRenderable(ctx, {
  width: 20,
  height: 3,
  render(buffer, deltaTime, renderable) {
    buffer.drawText("Custom!", 0, 0, RGBA.fromHex("#ffffff"))
  },
})
```

Via construct function:

```typescript
const vnode = Generic({
  width: 20,
  height: 3,
  render(buffer, deltaTime, renderable) {
    buffer.drawText("Custom!", 0, 0, RGBA.fromHex("#ffffff"))
  },
})
```

## vstyles

Text styling helper functions for use with `TextNodeRenderable`:

```typescript
import { vstyles } from "@opentui/core/renderables/composition/constructs"
```

### Available Styles

```typescript
// Text attributes
vstyles.bold(...children: (string | TextNodeRenderable)[]): TextNodeRenderable
vstyles.italic(...children): TextNodeRenderable
vstyles.underline(...children): TextNodeRenderable
vstyles.dim(...children): TextNodeRenderable
vstyles.blink(...children): TextNodeRenderable
vstyles.inverse(...children): TextNodeRenderable
vstyles.hidden(...children): TextNodeRenderable
vstyles.strikethrough(...children): TextNodeRenderable

// Combined attributes
vstyles.boldItalic(...children): TextNodeRenderable
vstyles.boldUnderline(...children): TextNodeRenderable
vstyles.italicUnderline(...children): TextNodeRenderable
vstyles.boldItalicUnderline(...children): TextNodeRenderable

// Colors
vstyles.color(color: string | RGBA, ...children): TextNodeRenderable
vstyles.fg(color: string | RGBA, ...children): TextNodeRenderable
vstyles.bgColor(bgColor: string | RGBA, ...children): TextNodeRenderable
vstyles.bg(bgColor: string | RGBA, ...children): TextNodeRenderable

// Custom attributes bitmask
vstyles.styled(attributes?: number, ...children): TextNodeRenderable
```

### Example

```typescript
const vnode = Text({},
  "Normal ",
  vstyles.bold("Bold"),
  " ",
  vstyles.italic("Italic"),
  " ",
  vstyles.fg("#f38ba8", "Red"),
  " ",
  vstyles.boldItalic("Bold+Italic")
)
```

## delegate()

The `delegate` function maps property/method access on a parent to nested children, enabling component composition with clean external APIs:

```typescript
// On instantiated renderables
function delegate<Factory extends InstantiateFn<any>, ...>(
  mapping: ValidateShape<Mapping, TargetMap>,
  vnode: Factory
): Renderable

// On ProxiedVNodes
function delegate<ConstructorType extends RenderableConstructor<any>, ...>(
  mapping: ValidateShape<Mapping, TargetMap>,
  vnode: ProxiedVNode<ConstructorType>
): ProxiedVNode<ConstructorType>

// On plain VNodes
function delegate<ConstructorType extends RenderableConstructor<any>, ...>(
  mapping: ValidateShape<Mapping, string>,
  vnode: VNode & { type: ConstructorType }
): VNode
```

### Type Safety

```typescript
type DelegateMap<T> = Partial<Record<keyof T, string>>
type ValidateShape<Given, AllowedKeys> = {
  [K in keyof Given]: K extends keyof AllowedKeys ? NonNullable<Given[K]> : never
}
```

### Example

```typescript
const vnode = delegate(
  { value: "input.value", focus: "input.focus" },
  Box({},
    Text({}, "Label:"),
    Input({ id: "input", placeholder: "Type here..." })
  )
)

const instance = instantiate(ctx, vnode)
// instance.value -> delegates to input.value
// instance.focus() -> delegates to input.focus()
```

## wrapWithDelegates()

Low-level function to apply a delegate map to an existing renderable instance:

```typescript
function wrapWithDelegates<T extends InstanceType<RenderableConstructor>>(
  instance: T,
  delegateMap: Record<string, string> | undefined
): T
```

## Complete Example

```typescript
import {
  Box, Text, Input, Select,
  vstyles, instantiate, delegate
} from "@opentui/core"

function buildForm(options: SelectOption[]) {
  return Box(
    {
      id: "form",
      backgroundColor: "#1e1e2e",
      flexDirection: "column",
      padding: 2,
      gap: 1,
    },
    Text({ fg: "#cdd6f4" },
      vstyles.bold("Select an option:")
    ),
    Select({
      id: "selector",
      options,
      selectedIndex: 0,
    }),
    Text({ fg: "#6c7086" },
      "Or enter custom value:"
    ),
    Input({
      id: "custom",
      placeholder: "Type here...",
    }),
  )
}

// Instantiate and add to tree
const form = instantiate(ctx, buildForm(options))
renderer.root.add(form)

// Access nested components by id
const selector = form.findDescendantById("selector")
const input = form.findDescendantById("custom")
```

## Related

- [Components README](../components/README.md) -- full list of available components
- [FrameBuffer](../components/frame-buffer.md) -- for raw custom rendering
- [Text](../components/text.md) -- TextNodeRenderable used by vstyles
