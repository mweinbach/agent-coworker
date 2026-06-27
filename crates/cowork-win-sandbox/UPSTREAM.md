# Upstream provenance

The Windows sandbox engine and the two native helper entrypoints are derived
from `openai/codex` commit
`eb8c1ee85f18d055d00b3a0912dd0e55e62a82e8`, licensed under Apache-2.0:

- `src/bin/codex-command-runner/` comes from
  `codex-rs/codex-command-runner/src/`.
- `src/bin/codex-windows-sandbox-setup/` comes from
  `codex-rs/codex-windows-sandbox-setup/src/`.
- `vendor/codex-utils-pty/` comes from `codex-rs/utils/pty/`; its local
  compatibility change is documented in `vendor/codex-utils-pty/README.cowork.md`.

Cowork's `src/main.rs` is the policy adapter that exposes the `probe`, `setup`,
and `run` contracts, adds protected metadata paths, and requires the native
enforcement probe before the TypeScript layer treats Windows as sandboxed.

Upstream license: <https://github.com/openai/codex/blob/eb8c1ee85f18d055d00b3a0912dd0e55e62a82e8/LICENSE>
