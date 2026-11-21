//! Feature view modules owned by individual swarm authors.
//!
//! Each submodule is owned exclusively by its assigned author:
//! - `chat`: `crates/cowork-desktop/src/views/chat/`
//! - `settings`: `crates/cowork-desktop/src/views/settings/`
//! - `shell`: `crates/cowork-desktop/src/views/shell/`

use rune::El;

pub mod chat;
pub mod preview;
pub mod settings;
pub mod shell;

/// Output returned by child feature views (`chat` and `settings`) for composition
/// inside the `shell` frame and top-level overlay stack.
pub struct SubviewOutput {
    pub content: El,
    pub overlays: Vec<El>,
}
