//! Plugin `.mcp.json` stdio path resolution must match TS `rebasePluginLocalTransport`
//! (`src/mcp/configRegistry/layers.ts`), ported from the plugin cases in
//! `test/mcp.config-registry.test.ts`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::{AgentConfig, LoadConfigOptions, load_config};
use cowork_mcp::registry::read_mcp_servers_snapshot;
use cowork_mcp::types::{McpServerCatalogEntry, McpServerTransport, McpServersSnapshot};
use serde_json::{Value, json};

struct Fixture {
    tmp: tempfile::TempDir,
    cfg: AgentConfig,
}

impl Fixture {
    fn workspace(&self) -> PathBuf {
        self.tmp.path().join("ws")
    }

    /// Creates `<ws>/.agents/plugins/<name>` with a `.codex-plugin/plugin.json` manifest and
    /// returns its canonical root (the base the registry resolves against).
    fn plugin(&self, name: &str) -> PathBuf {
        let root = self.workspace().join(".agents/plugins").join(name);
        write_json(
            &root.join(".codex-plugin/plugin.json"),
            &json!({
                "name": name,
                "description": "Plugin path helpers",
                "interface": { "displayName": name }
            }),
        );
        fs::canonicalize(&root).unwrap()
    }
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let ws = tmp.path().join("ws");
    fs::create_dir_all(home.join(".cowork/config")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    fs::create_dir_all(tmp.path().join("builtin")).unwrap();
    let mut env = HashMap::new();
    env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".to_owned(),
        home.join(".cowork").to_string_lossy().into_owned(),
    );
    env.insert("COWORK_DISABLE_RUNTIME".to_owned(), "1".to_owned());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".to_owned(), "0".to_owned());
    let cfg = load_config(LoadConfigOptions {
        cwd: Some(ws),
        homedir: Some(home),
        built_in_dir: Some(tmp.path().join("builtin")),
        env: Some(env),
    })
    .unwrap();
    Fixture { tmp, cfg }
}

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

fn write_file(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn find<'a>(snapshot: &'a McpServersSnapshot, name: &str) -> Option<&'a McpServerCatalogEntry> {
    snapshot.servers.iter().find(|s| s.config.name == name)
}

fn stdio(entry: &McpServerCatalogEntry) -> (&str, Option<&[String]>, Option<&str>) {
    match &entry.config.transport {
        McpServerTransport::Stdio {
            command, args, cwd, ..
        } => (command.as_str(), args.as_deref(), cwd.as_deref()),
        other => panic!("expected stdio transport, got {other:?}"),
    }
}

fn p(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn assert_single_warning_containing(snapshot: &McpServersSnapshot, needle: &str) {
    assert_eq!(snapshot.warnings.len(), 1, "{:?}", snapshot.warnings);
    assert!(
        snapshot.warnings[0].contains(needle),
        "warning {:?} should contain {needle:?}",
        snapshot.warnings[0]
    );
}

#[test]
fn plugin_stdio_transports_rebase_only_filesystem_paths_against_plugin_root() {
    let fx = fixture();
    let root = fx.plugin("stdio-toolkit");
    fs::create_dir_all(root.join("runtime")).unwrap();
    write_file(&root.join("bin/server.js"), "// server\n");
    write_file(&root.join("dist/server.mjs"), "// bundled\n");
    write_file(&root.join("nested/server.js"), "// nested\n");
    write_json(
        &root.join(".mcp.json"),
        &json!({
            "mcpServers": {
                "bundledServer": {
                    "type": "stdio",
                    "command": "./bin/server.js",
                    "args": [
                        "./dist/server.mjs",
                        "nested/server.js",
                        "@modelcontextprotocol/server-filesystem",
                        "https://api.example.com",
                        "--port",
                        "7337"
                    ],
                    "cwd": "./runtime"
                },
                "pathServer": { "type": "stdio", "command": "node" }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);

    let (command, args, cwd) = stdio(find(&snapshot, "bundledServer").unwrap());
    assert_eq!(command, p(root.join("bin/server.js")));
    assert_eq!(cwd, Some(p(root.join("runtime")).as_str()));
    assert_eq!(
        args.unwrap(),
        [
            p(root.join("dist/server.mjs")),
            p(root.join("nested/server.js")),
            "@modelcontextprotocol/server-filesystem".to_owned(),
            "https://api.example.com".to_owned(),
            "--port".to_owned(),
            "7337".to_owned(),
        ]
    );

    let (command, args, cwd) = stdio(find(&snapshot, "pathServer").unwrap());
    assert_eq!(command, "node");
    assert_eq!(args, None);
    assert_eq!(cwd, None, "an absent plugin cwd stays absent, as in TS");
}

/// Codex regression: `node nested/server.js` with `cwd: ./runtime` must launch
/// `<plugin>/nested/server.js`, not `<plugin>/runtime/nested/server.js`.
#[test]
fn plugin_bare_relative_script_arg_is_rebased_when_cwd_points_elsewhere() {
    let fx = fixture();
    let root = fx.plugin("bare-arg-toolkit");
    fs::create_dir_all(root.join("runtime")).unwrap();
    write_file(&root.join("nested/server.js"), "// nested\n");
    write_json(
        &root.join(".mcp.json"),
        &json!({
            "mcpServers": {
                "bare": {
                    "command": "node",
                    "args": ["nested/server.js", "missing/file.js", "plain-word", "--flag=x/y"],
                    "cwd": "./runtime"
                }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
    let (command, args, cwd) = stdio(find(&snapshot, "bare").unwrap());
    assert_eq!(command, "node");
    assert_eq!(cwd, Some(p(root.join("runtime")).as_str()));
    assert_eq!(
        args.unwrap(),
        [
            p(root.join("nested/server.js")),
            // Bare relative values that do not exist under the plugin root are left alone.
            "missing/file.js".to_owned(),
            "plain-word".to_owned(),
            "--flag=x/y".to_owned(),
        ]
    );
}

#[test]
fn plugin_bare_cwd_without_dot_prefix_resolves_against_plugin_root() {
    let fx = fixture();
    let root = fx.plugin("bare-cwd-toolkit");
    write_json(
        &root.join(".mcp.json"),
        &json!({
            "mcpServers": {
                "bareCwd": { "command": "node", "cwd": "runtime" }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
    let (_, _, cwd) = stdio(find(&snapshot, "bareCwd").unwrap());
    assert_eq!(cwd, Some(p(root.join("runtime")).as_str()));
}

#[test]
fn plugin_stdio_transports_reject_relative_paths_that_escape_plugin_root() {
    let fx = fixture();
    let root = fx.plugin("escape-toolkit");
    write_json(
        &root.join(".mcp.json"),
        &json!({
            "mcpServers": {
                "escapedServer": {
                    "type": "stdio",
                    "command": "node",
                    "args": ["../outside/server.mjs"],
                    "cwd": "../outside"
                }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(find(&snapshot, "escapedServer").is_none());
    assert_single_warning_containing(
        &snapshot,
        "resolves argument \"../outside/server.mjs\" outside the plugin root",
    );
}

#[test]
fn plugin_stdio_transports_reject_absolute_cwd_outside_plugin_root() {
    let fx = fixture();
    let root = fx.plugin("absolute-cwd-toolkit");
    write_json(
        &root.join(".mcp.json"),
        &json!({
            "mcpServers": {
                "escapedServer": {
                    "type": "stdio",
                    "command": "node",
                    "cwd": p(std::env::temp_dir())
                }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(find(&snapshot, "escapedServer").is_none());
    assert_single_warning_containing(&snapshot, "resolves cwd outside the plugin root");
}

#[cfg(unix)]
#[test]
fn plugin_stdio_transports_reject_symlinked_paths_that_escape_plugin_root() {
    let fx = fixture();
    let root = fx.plugin("symlink-toolkit");
    let outside = fx.workspace().join("outside/server.js");
    write_file(&outside, "// outside\n");
    fs::create_dir_all(root.join("bin")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("bin/server.js")).unwrap();
    write_json(
        &root.join(".mcp.json"),
        &json!({
            "mcpServers": {
                "escapedServer": { "type": "stdio", "command": "./bin/server.js" }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(find(&snapshot, "escapedServer").is_none());
    assert_single_warning_containing(&snapshot, "resolves command outside the plugin root");
}

#[cfg(unix)]
#[test]
fn plugin_bare_relative_symlink_arg_escaping_plugin_root_is_rejected() {
    let fx = fixture();
    let root = fx.plugin("bare-symlink-toolkit");
    let outside = fx.workspace().join("outside/server.js");
    write_file(&outside, "// outside\n");
    fs::create_dir_all(root.join("nested")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("nested/server.js")).unwrap();
    write_json(
        &root.join(".mcp.json"),
        &json!({
            "mcpServers": {
                "escapedServer": { "command": "node", "args": ["nested/server.js"] }
            }
        }),
    );

    let snapshot = read_mcp_servers_snapshot(&fx.cfg).unwrap();
    assert!(find(&snapshot, "escapedServer").is_none());
    assert_single_warning_containing(
        &snapshot,
        "resolves argument \"nested/server.js\" outside the plugin root",
    );
}
