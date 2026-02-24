# Lessons

- Scope websocket `try/catch` blocks to decode/parse only; never wrap consumer event callbacks in the same catch path.
- Keep fallback stream IDs lifecycle-stable: do not seed with per-chunk indices, and align id-less `tool_input_*` and `tool_*` call/result IDs to the same fallback call key.
