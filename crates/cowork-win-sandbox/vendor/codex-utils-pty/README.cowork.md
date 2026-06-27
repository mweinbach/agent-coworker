# Vendored Codex PTY compatibility patch

This directory is copied from `openai/codex` commit
`eb8c1ee85f18d055d00b3a0912dd0e55e62a82e8`, crate `codex-rs/utils/pty`.

The only runtime source change is an explicit `as RawHandle` cast in
`src/win/conpty.rs`, required by Rust 1.96's stricter raw-handle type checking.
Workspace-inherited dependency declarations were expanded into pinned ordinary
crate dependencies so this crate can build outside the Codex workspace. Upstream
tests and Bazel metadata are omitted; Cowork builds only the Windows library and
exercises it through the native enforcement integration suite.
