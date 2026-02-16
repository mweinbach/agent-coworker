# TUI Guidelines

This file applies to everything under `apps/TUI/`.

## Keyboard And Input Rules

- Normalize keys with `keyNameFromEvent(...)` instead of reading `e.key`/`e.name` directly.
- For OpenTUI `<input>` elements, Enter submission must use `onSubmit`.
- Do not rely on Enter in `<input onKeyDown>` handlers.
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
