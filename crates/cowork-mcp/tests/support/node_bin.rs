//! Absolute path of the real Node.js binary for stdio MCP fixtures.
//!
//! Fixtures spawn `node` with an isolated, empty `HOME`. On a developer machine `node` on `PATH`
//! is often a version-manager shim (Vite+, Volta, asdf, ...) that needs its per-user cache under
//! the real `HOME`, so a bare `node` stalls or fails inside the isolated environment. Ask the shim
//! for the binary it ultimately runs, using this test process's inherited environment, and spawn
//! that path instead.

use std::path::PathBuf;
use std::sync::OnceLock;

pub fn node_bin() -> String {
    static NODE: OnceLock<String> = OnceLock::new();
    NODE.get_or_init(|| {
        let out = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("`node` must be on PATH to run the stdio MCP fixtures");
        assert!(
            out.status.success(),
            "`node -p process.execPath` failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let exec_path = String::from_utf8(out.stdout)
            .expect("process.execPath is UTF-8")
            .trim()
            .to_owned();
        assert!(!exec_path.is_empty(), "`node` reported an empty execPath");
        std::fs::canonicalize(&exec_path)
            .unwrap_or_else(|_| PathBuf::from(&exec_path))
            .to_string_lossy()
            .into_owned()
    })
    .clone()
}
