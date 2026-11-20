/**
 * File names of the bundled Windows sandbox executables (built from
 * `crates/cowork-win-sandbox/` and the Rust command runner). The Rust server's
 * `cowork-sandbox` crate drives them at runtime; the packaging and build scripts
 * locate, copy and hash them.
 */
export const WINDOWS_SANDBOX_HELPER_NAME = "cowork-win-sandbox.exe";
export const WINDOWS_SANDBOX_SETUP_NAME = "codex-windows-sandbox-setup.exe";
export const WINDOWS_SANDBOX_COMMAND_RUNNER_NAME = "codex-command-runner.exe";
export const WINDOWS_SANDBOX_HASH_MANIFEST_NAME = "cowork-win-sandbox.sha256.json";
