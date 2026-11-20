# Cursor Cloud Environment

Load this file only when running inside Cursor Cloud.

## Runtime

Bun is installed at `~/.bun/bin/bun`. Ensure `$BUN_INSTALL/bin` is on `PATH` (the update script handles this). No Docker or external services are required.

## Services

| Service          | Command         | Notes                                                                                  |
| ---------------- | --------------- | -------------------------------------------------------------------------------------- |
| WebSocket server | `bun run serve` | Listens on `ws://127.0.0.1:7337/ws`. Add `--json` for machine-readable startup output. |
| Desktop app      | `bun run start` | Starts the server automatically.                                                       |
| CLI REPL         | `bun run cli`   | Also auto-starts the server. Needs TTY input.                                          |

For headless/cloud testing, prefer `bun run serve` and interact via WebSocket (see `docs/websocket-protocol.md`).

## Notes

- `bun run test` runs the full TypeScript/client/black-box suite. All tests are deterministic and require no network or API keys. TypeScript test files live in `test/`; Rust workspace tests (including `cowork-desktop`) run via `cargo test --workspace`.
- A small number of tests are skipped by default (remote MCP integration tests requiring network).
- **Lint philosophy**: `biome.json` is tuned to catch LLM-generated code failure modes. Type-safety erosion (`noExplicitAny`, `noNonNullAssertion`, `noBannedTypes`), React lifecycle bugs (`useExhaustiveDependencies`, `noAssignInExpressions`, `noArrayIndexKey`), and error-handling camouflage (`noUselessCatch`, `noEmptyBlock`) are all surfaced. New code should not introduce new violations.
- `bun run start` builds `cowork-server` and launches the native Rune desktop app (`crates/cowork-desktop/`). For headless UI inspection, run `cargo run -p cowork-desktop --bin cowork-desktop -- --scene chat-demo --snap /tmp/chat.png`.
