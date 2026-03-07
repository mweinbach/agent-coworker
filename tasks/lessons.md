# Lessons

- Scope websocket `try/catch` blocks to decode/parse only; never wrap consumer event callbacks in the same catch path.
- Keep fallback stream IDs lifecycle-stable: do not seed with per-chunk indices, and align id-less `tool_input_*` and `tool_*` call/result IDs to the same fallback call key.
- For live production-loop validation, avoid over-constraining tool-call order unless the ordering itself is the behavior under test; assert required tool usage, not first-call sequencing.
- For live desktop UI testing in this repo, default to the Playwright/CDP workflow first; relaunch Electron with `COWORK_ELECTRON_REMOTE_DEBUG=1` instead of relying only on lighter wrappers.
- For desktop UI bugs in the shadcn/ai-elements surface, fix the component composition and spacing locally before adding new state/layout plumbing.
- For dense desktop agent timelines, collapse reasoning and tool traces into a shared secondary disclosure before trying to restyle dozens of inline cards.
- For grouped desktop tool traces, do not nest the full `ToolCard` disclosure stack inside the `Thinking` disclosure; use a flat, readable step list and visually verify the expanded state, not just the collapsed summary.
- For grouped desktop trace cleanup, merge adjacent tool rows by lifecycle compatibility and result shape, not just by matching tool name, and verify the header layout inside the real three-column shell because viewport breakpoints alone can hide narrow-panel collisions.
- When default skills are meant to live in `~/.cowork/skills`, move the bootstrap into shared runtime startup and widen read-only permissions for `skillsDirs`; do not solve it in a desktop-only wrapper or by only changing bundled app assets.
- For workspace-clutter complaints, inspect the actual user workspace path and generated artifact set first; prevent disposable scaffolding at the prompt/skill layer before considering UI hiding rules.
- For desktop chat file listings, auto-link bare absolute local file paths in the Streamdown remark transform and shorten labels to basenames there; do not rely on the model to author markdown links or try to fix it only at the anchor component layer.
