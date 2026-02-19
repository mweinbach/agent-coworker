# Select and TabSelect Components

## SelectRenderable

`SelectRenderable` provides a vertical list selection with optional descriptions, keyboard navigation, scroll indicators, and customizable styling.

**Import:** `import { SelectRenderable, SelectRenderableEvents } from "@opentui/core"`

### Constructor

```typescript
new SelectRenderable(ctx: RenderContext, options: SelectRenderableOptions)
```

### Props

```typescript
interface SelectRenderableOptions extends RenderableOptions<SelectRenderable> {
  options?: SelectOption[]
  selectedIndex?: number

  // Colors
  backgroundColor?: ColorInput
  textColor?: ColorInput
  focusedBackgroundColor?: ColorInput
  focusedTextColor?: ColorInput
  selectedBackgroundColor?: ColorInput
  selectedTextColor?: ColorInput
  descriptionColor?: ColorInput
  selectedDescriptionColor?: ColorInput

  // Behavior
  showScrollIndicator?: boolean
  wrapSelection?: boolean
  showDescription?: boolean

  // Styling
  font?: ASCIIFontName          // ASCII art font for option names
  itemSpacing?: number
  fastScrollStep?: number

  // Key bindings
  keyBindings?: SelectKeyBinding[]
  keyAliasMap?: KeyAliasMap
}

interface SelectOption {
  name: string        // Display text
  description: string // Description text below/beside name
  value?: any         // Associated value
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `options` | `SelectOption[]` | `[]` | List of selectable options |
| `selectedIndex` | `number` | `0` | Initially selected index |
| `backgroundColor` | `ColorInput` | - | Background color |
| `textColor` | `ColorInput` | - | Normal item text color |
| `focusedBackgroundColor` | `ColorInput` | - | Background when component is focused |
| `focusedTextColor` | `ColorInput` | - | Text color when component is focused |
| `selectedBackgroundColor` | `ColorInput` | - | Background of selected item |
| `selectedTextColor` | `ColorInput` | - | Text color of selected item |
| `descriptionColor` | `ColorInput` | - | Description text color |
| `selectedDescriptionColor` | `ColorInput` | - | Description color when selected |
| `showScrollIndicator` | `boolean` | `false` | Show scroll indicator when items overflow |
| `wrapSelection` | `boolean` | `false` | Wrap selection at top/bottom |
| `showDescription` | `boolean` | `true` | Show option descriptions |
| `font` | `ASCIIFontName` | - | ASCII art font for rendering option names |
| `itemSpacing` | `number` | - | Spacing between items |
| `fastScrollStep` | `number` | - | Number of items to skip on fast scroll |
| `keyBindings` | `SelectKeyBinding[]` | - | Custom key bindings |
| `keyAliasMap` | `KeyAliasMap` | - | Key alias mapping |

### Events

```typescript
enum SelectRenderableEvents {
  SELECTION_CHANGED = "selectionChanged",   // Selection index changed
  ITEM_SELECTED = "itemSelected",           // Enter/confirm pressed
}
```

### Actions

```typescript
type SelectAction =
  | "move-up"
  | "move-down"
  | "move-up-fast"
  | "move-down-fast"
  | "select-current"
```

### Properties & Methods

```typescript
class SelectRenderable extends Renderable {
  // Options
  get options(): SelectOption[]
  set options(options: SelectOption[])

  // Selection
  getSelectedOption(): SelectOption | null
  getSelectedIndex(): number
  setSelectedIndex(index: number): void
  set selectedIndex(value: number)

  // Navigation
  moveUp(steps?: number): void
  moveDown(steps?: number): void
  selectCurrent(): void

  // Input
  handleKeyPress(key: KeyEvent): boolean

  // Display
  get showScrollIndicator(): boolean
  set showScrollIndicator(show: boolean)
  get showDescription(): boolean
  set showDescription(show: boolean)
  get wrapSelection(): boolean
  set wrapSelection(wrap: boolean)

  // Colors
  set backgroundColor(value: ColorInput)
  set textColor(value: ColorInput)
  set focusedBackgroundColor(value: ColorInput)
  set focusedTextColor(value: ColorInput)
  set selectedBackgroundColor(value: ColorInput)
  set selectedTextColor(value: ColorInput)
  set descriptionColor(value: ColorInput)
  set selectedDescriptionColor(value: ColorInput)

  // Configuration
  set font(font: ASCIIFontName)
  set itemSpacing(spacing: number)
  set fastScrollStep(step: number)
  set keyBindings(bindings: SelectKeyBinding[])
  set keyAliasMap(aliases: KeyAliasMap)
}
```

### Examples

#### Basic Select

```tsx
const options = [
  { name: "Option 1", description: "First choice", value: 1 },
  { name: "Option 2", description: "Second choice", value: 2 },
  { name: "Option 3", description: "Third choice", value: 3 },
]

<select options={options} selectedIndex={0} />
```

#### Without Descriptions

```tsx
<select options={options} showDescription={false} />
```

#### With Scroll Indicator

```tsx
<select options={manyOptions} showScrollIndicator height={10} />
```

#### Styled Select

```tsx
<select
  options={options}
  backgroundColor="#1e1e2e"
  textColor="#cdd6f4"
  selectedBackgroundColor="#89b4fa"
  selectedTextColor="#1e1e2e"
  descriptionColor="#6c7086"
/>
```

#### Vim-Style Key Bindings

```tsx
const keyBindings = [
  { key: "k", action: "move-up" },
  { key: "j", action: "move-down" },
  { key: "g", action: "move-up-fast" },
  { key: "G", action: "move-down-fast" },
]

<select options={options} keyBindings={keyBindings} />
```

#### Imperative Usage

```typescript
const select = new SelectRenderable(ctx, {
  options: [
    { name: "File", description: "File operations" },
    { name: "Edit", description: "Edit operations" },
    { name: "View", description: "View options" },
  ],
  showScrollIndicator: true,
})

select.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
  console.log("Selection:", select.getSelectedOption())
})

select.on(SelectRenderableEvents.ITEM_SELECTED, () => {
  console.log("Confirmed:", select.getSelectedOption())
})

// Navigate programmatically
select.moveDown()
select.setSelectedIndex(2)
```

### Default Key Bindings

| Key | Action |
|-----|--------|
| Up | Move up |
| Down | Move down |
| PageUp | Move up fast |
| PageDown | Move down fast |
| Enter | Select current |

---

## TabSelectRenderable

`TabSelectRenderable` provides a horizontal tab-style selection with optional descriptions and underline indicator.

**Import:** `import { TabSelectRenderable, TabSelectRenderableEvents } from "@opentui/core"`

### Constructor

```typescript
new TabSelectRenderable(ctx: RenderContext, options: TabSelectRenderableOptions)
```

### Props

```typescript
interface TabSelectRenderableOptions extends Omit<RenderableOptions<TabSelectRenderable>, "height"> {
  height?: number
  options?: TabSelectOption[]
  tabWidth?: number

  // Colors
  backgroundColor?: ColorInput
  textColor?: ColorInput
  focusedBackgroundColor?: ColorInput
  focusedTextColor?: ColorInput
  selectedBackgroundColor?: ColorInput
  selectedTextColor?: ColorInput
  selectedDescriptionColor?: ColorInput

  // Behavior
  showScrollArrows?: boolean
  showDescription?: boolean
  showUnderline?: boolean
  wrapSelection?: boolean

  // Key bindings
  keyBindings?: TabSelectKeyBinding[]
  keyAliasMap?: KeyAliasMap
}

interface TabSelectOption {
  name: string
  description: string
  value?: any
}
```

### Props Table

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `options` | `TabSelectOption[]` | `[]` | Tab options |
| `height` | `number` | auto | Component height |
| `tabWidth` | `number` | - | Fixed width per tab |
| `backgroundColor` | `ColorInput` | - | Background color |
| `textColor` | `ColorInput` | - | Normal tab text color |
| `focusedBackgroundColor` | `ColorInput` | - | Background when component is focused |
| `focusedTextColor` | `ColorInput` | - | Text when focused |
| `selectedBackgroundColor` | `ColorInput` | - | Background of selected tab |
| `selectedTextColor` | `ColorInput` | - | Text of selected tab |
| `selectedDescriptionColor` | `ColorInput` | - | Description text of selected tab |
| `showScrollArrows` | `boolean` | - | Show left/right scroll arrows |
| `showDescription` | `boolean` | - | Show tab descriptions below |
| `showUnderline` | `boolean` | - | Show underline on selected tab |
| `wrapSelection` | `boolean` | - | Wrap selection at edges |
| `keyBindings` | `TabSelectKeyBinding[]` | - | Custom key bindings |
| `keyAliasMap` | `KeyAliasMap` | - | Key alias mapping |

### Events

```typescript
enum TabSelectRenderableEvents {
  SELECTION_CHANGED = "selectionChanged",
  ITEM_SELECTED = "itemSelected",
}
```

### Actions

```typescript
type TabSelectAction = "move-left" | "move-right" | "select-current"
```

### Properties & Methods

```typescript
class TabSelectRenderable extends Renderable {
  // Options
  get options(): TabSelectOption[]
  set options(options: TabSelectOption[])
  setOptions(options: TabSelectOption[]): void

  // Selection
  getSelectedOption(): TabSelectOption | null
  getSelectedIndex(): number
  setSelectedIndex(index: number): void

  // Navigation
  moveLeft(): void
  moveRight(): void
  selectCurrent(): void

  // Input
  handleKeyPress(key: KeyEvent): boolean

  // Tab width
  get tabWidth(): number
  set tabWidth(tabWidth: number)
  setTabWidth(tabWidth: number): void
  getTabWidth(): number

  // Display
  get showDescription(): boolean
  set showDescription(show: boolean)
  get showUnderline(): boolean
  set showUnderline(show: boolean)
  get showScrollArrows(): boolean
  set showScrollArrows(show: boolean)
  get wrapSelection(): boolean
  set wrapSelection(wrap: boolean)

  // Colors
  set backgroundColor(color: ColorInput)
  set textColor(color: ColorInput)
  set focusedBackgroundColor(color: ColorInput)
  set focusedTextColor(color: ColorInput)
  set selectedBackgroundColor(color: ColorInput)
  set selectedTextColor(color: ColorInput)
  set selectedDescriptionColor(color: ColorInput)

  // Configuration
  set keyBindings(bindings: TabSelectKeyBinding[])
  set keyAliasMap(aliases: KeyAliasMap)
}
```

### Examples

#### Basic TabSelect

```tsx
const tabs = [
  { name: "General", description: "General settings", value: "general" },
  { name: "Editor", description: "Editor preferences", value: "editor" },
  { name: "Theme", description: "Theme customization", value: "theme" },
]

<tabselect options={tabs} />
```

#### With Underline

```tsx
<tabselect options={tabs} showUnderline />
```

#### With Scroll Arrows

```tsx
<tabselect options={manyTabs} showScrollArrows tabWidth={15} />
```

#### Imperative Usage

```typescript
const tabSelect = new TabSelectRenderable(ctx, {
  options: tabs,
  showUnderline: true,
  tabWidth: 12,
})

tabSelect.on(TabSelectRenderableEvents.ITEM_SELECTED, () => {
  const tab = tabSelect.getSelectedOption()
  console.log("Selected tab:", tab)
})
```

### Default Key Bindings

| Key | Action |
|-----|--------|
| Left | Move left |
| Right | Move right |
| Enter | Select current |

## Related Components

- [ScrollBox](./scrollbox.md) -- for scrollable lists
- [ASCIIFont](./ascii-font.md) -- used by Select's `font` option
