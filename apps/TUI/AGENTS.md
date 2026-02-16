# TUI Guidelines

This file applies to everything under `apps/TUI/`.

## Solid.js Reactivity Rules (CRITICAL)

Solid.js component functions run **once**. Signal reads outside a tracking scope (JSX expressions, `createEffect`, `createMemo`) are NOT reactive. Violating this causes UI that never updates when state changes.

### Never use `if`/`return` for conditional rendering

```tsx
// BAD — reads stage() once at init, never updates when stage changes
function MyDialog() {
  if (stage() === "step1") {
    return <StepOne />;
  }
  if (stage() === "step2") {
    return <StepTwo />;
  }
  return <Fallback />;
}

// GOOD — reactive, re-evaluates when stage() changes
function MyDialog() {
  return (
    <Switch fallback={<Fallback />}>
      <Match when={stage() === "step1"}><StepOne /></Match>
      <Match when={stage() === "step2"}><StepTwo /></Match>
    </Switch>
  );
}
```

### Use the right Solid.js primitive

| Pattern | Use |
|---|---|
| Show/hide one thing | `<Show when={signal()}>` |
| Pick one of N branches | `<Switch>` + `<Match>` |
| Render a list | `<For each={signal()}>` |
| Derived value | `createMemo(() => ...)` |
| Side effect on change | `createEffect(() => ...)` |

### Where signal reads ARE tracked

- Inside JSX: `<text>{count()}</text>`
- Inside `createEffect(() => { ... })`
- Inside `createMemo(() => { ... })`
- Inside `<Show when={...}>`, `<Match when={...}>`, `<For each={...}>`

### Where signal reads are NOT tracked

- Top-level component body: `const x = signal();` — runs once
- `if (signal()) return <JSX />` — runs once, dead after init
- Event handlers: `onClick={() => signal()}` — fine, runs on each click (not a tracking issue)
- Inside `onMount` / `onCleanup` — runs once by design

## OpenTUI Event Model

Understanding how OpenTUI routes keyboard events is essential for correct input handling.

### Event flow

1. **Raw input** → `KeyHandler.processInput()` → emits `"keypress"` with a `KeyEvent`
2. **Global listeners** run first (registered via `useKeyboard` hook)
   - If any listener calls `e.stopPropagation()`, remaining global listeners and all renderable handlers are skipped
3. **`defaultPrevented` gate** — if any global listener called `e.preventDefault()`, renderable handlers are **skipped entirely**
4. **Focused element handler** runs (registered internally when `focused` prop is set)
   - Calls `onKeyDown` handler first
   - If `defaultPrevented` is still false after `onKeyDown`, calls built-in `handleKeyPress` (text input, submit, cursor movement, etc.)

### Implications

- `useKeyboard` callbacks must NOT call `e.preventDefault()` for keys they don't handle — doing so blocks focused elements from receiving those keys.
- When a dialog is open, the global handler in `app.tsx` should `return` early (without `preventDefault`) to skip global hotkeys while letting dialog components receive events normally.
- `onKeyDown` on a focused element runs BEFORE built-in behavior. If `onKeyDown` calls `e.preventDefault()`, the built-in handler (e.g., `submit()`) is skipped.

### Supported event props on elements

OpenTUI's Solid reconciler handles these event props explicitly:

| Prop | Element | Wired to |
|---|---|---|
| `onSubmit` | `<input>` | `InputRenderableEvents.ENTER` |
| `onChange` | `<input>`, `<select>` | `CHANGE` / `SELECTION_CHANGED` |
| `onInput` | `<input>` | `InputRenderableEvents.INPUT` |
| `onSelect` | `<select>` | `ITEM_SELECTED` |

All other props (including `onKeyDown`, `onMouseDown`) fall through to the `default` case: `node[propName] = value`. This works because `Renderable` has native setters for `onKeyDown` (maps to `_keyListeners["down"]`), `onMouseDown`, etc.

### Key name normalization

OpenTUI uses `"return"` internally for the Enter key. Always use `keyNameFromEvent(e)` which normalizes to `"enter"`. Never compare against `e.key` or `e.name` directly.

## Keyboard And Input Rules

- Normalize keys with `keyNameFromEvent(...)` instead of reading `e.key`/`e.name` directly.
- For OpenTUI `<input>` elements, Enter submission must be wired with `onSubmit`.
- Add a defensive Enter fallback in `onKeyDown` for critical flows, because some terminal/key-parser combinations may not emit the expected submit binding.
- Keep `<input onKeyDown>` focused on navigation and dismissal keys (for example: `up`, `down`, `escape`).
- Keep submission guards (trim/empty checks, validation) in the submit handler used by `onSubmit`.

## Textarea Rules

- For OpenTUI `<textarea>`, keep submit behavior on `onSubmit` + configured key bindings.
- Avoid duplicate submit logic in textarea `onKeyDown`.

## Dialog Patterns

- Select/filter dialogs:
  - Arrow key movement and Escape cancellation belong in `onKeyDown`.
  - Enter selection belongs in the search input `onSubmit`.
- Prompt dialogs:
  - Escape dismissal can stay in `onKeyDown`.
  - Enter submit must be handled by input `onSubmit`.

## Regression Coverage

- When keyboard behavior changes, add/update tests that cover keyboard-only flows.
- Minimum checks:
  - default selection + Enter
  - moved selection + Enter
  - Escape dismiss
  - empty/whitespace submit guards

## Verification

- Run targeted tests for changed TUI behavior.
- Run full `bun test` before finishing when practical.
