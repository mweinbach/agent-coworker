//! `cowork-server __sandbox-exec --print-command` prints the fully transformed backend launch
//! (one JSON object on stdout, exit 0) through the same policy/gate/transform path as real
//! execution, without running anything.

use std::process::Command;

use cowork_config::canonicalize_sync;
use cowork_sandbox::cli::{ParsedSandboxExecArgs, parse_sandbox_exec_args};
use serde_json::Value;

const MARKER: &str = "sandbox-print-command-marker";

fn run_print_command(cwd: &std::path::Path, flags: &[&str]) -> std::process::Output {
    let mut args = vec![
        "__sandbox-exec".to_owned(),
        "--print-command".to_owned(),
        "--cwd".to_owned(),
        cwd.to_string_lossy().into_owned(),
    ];
    args.extend(flags.iter().map(|f| (*f).to_owned()));
    args.extend(["--", "/bin/echo", "hi"].map(str::to_owned));
    Command::new(env!("CARGO_BIN_EXE_cowork-server"))
        .args(&args)
        .env("HOME", cwd)
        .env("COWORK_HOME_OVERRIDE", cwd)
        .env("COWORK_PRINT_COMMAND_MARKER", MARKER)
        .env("OPENAI_API_KEY", "sk-never-leak")
        .env("COWORK_DESKTOP_PARENT_MANAGED", "1")
        .output()
        .expect("spawn cowork-server __sandbox-exec --print-command")
}

fn env_of(json: &Value) -> &serde_json::Map<String, Value> {
    json["env"].as_object().expect("env object")
}

#[test]
fn print_command_flag_is_parsed() {
    let parsed = parse_sandbox_exec_args(
        &["--print-command", "--mode", "read-only", "--", "ls"].map(str::to_owned),
    )
    .unwrap();
    let ParsedSandboxExecArgs::Run(opts) = parsed else {
        panic!("expected Run");
    };
    assert!(opts.print_command);
    assert!(!opts.json_result);
    assert_eq!(opts.command, vec!["ls".to_owned()]);
}

#[test]
fn print_command_reports_unsandboxed_yolo_launch_without_running_it() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = canonicalize_sync(tmp.path());
    let out = run_print_command(&cwd, &["--yolo"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let json: Value = serde_json::from_slice(&out.stdout).expect("one JSON object on stdout");
    assert_eq!(json["sandbox"], "none");
    assert_eq!(json["file"], "/bin/echo");
    assert_eq!(json["args"], serde_json::json!(["hi"]));
    assert_eq!(json["unsandboxed"], true);
    assert_eq!(json["cwd"], cwd.to_string_lossy().as_ref());
    assert_eq!(
        json["enforcement"],
        serde_json::json!({"filesystem": false, "network": false, "process": false, "integrity": false})
    );
    assert_eq!(json["sandboxEnv"], serde_json::json!({}));
    // Unsandboxed `--yolo` inherits the (sanitized) process env, minus the parent-managed flag.
    let env = env_of(&json);
    assert_eq!(
        env.get("COWORK_PRINT_COMMAND_MARKER")
            .and_then(Value::as_str),
        Some(MARKER)
    );
    assert!(!env.contains_key("COWORK_DESKTOP_PARENT_MANAGED"));
}

#[test]
fn print_command_applies_policy_and_backend_transform() {
    let tmp = tempfile::tempdir().unwrap();
    let cwd = canonicalize_sync(tmp.path());
    // `--no-network` is a hard floor: without an enforcing backend the gate fails closed exactly
    // like real execution would.
    let out = run_print_command(&cwd, &["--mode", "workspace-write", "--no-network"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(125) {
        assert!(stderr.contains("SANDBOX_REQUIRED"), "stderr: {stderr}");
        assert!(out.stdout.is_empty(), "nothing may be printed or run");
        return;
    }
    assert_eq!(out.status.code(), Some(0), "stderr: {stderr}");
    let json: Value = serde_json::from_slice(&out.stdout).expect("one JSON object on stdout");
    assert_eq!(json["unsandboxed"], false);
    assert_eq!(
        json["enforcement"],
        serde_json::json!({"filesystem": true, "network": true, "process": true, "integrity": true})
    );
    let env = env_of(&json);
    assert!(!env.contains_key("OPENAI_API_KEY"), "secrets are stripped");
    assert!(!env.contains_key("COWORK_PRINT_COMMAND_MARKER"));
    assert!(!env.contains_key("COWORK_DESKTOP_PARENT_MANAGED"));
    for (key, value) in json["sandboxEnv"].as_object().unwrap() {
        assert_eq!(env.get(key), Some(value), "sandboxEnv is merged into env");
    }
    let args: Vec<&str> = json["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    match json["sandbox"].as_str().unwrap() {
        "linux-bwrap" => {
            assert!(args.contains(&"--unshare-net"), "{args:?}");
            assert_eq!(
                env.get("COWORK_SANDBOX").and_then(Value::as_str),
                Some("linux-bwrap")
            );
            // Inner seccomp launcher: `-- <self_exe> __sandbox-exec --linux-seccomp
            // --deny-network -- <file> <args...>` at the end of the bwrap argv.
            let tail = &args[args.len() - 8..];
            assert_eq!(tail[0], "--", "{args:?}");
            assert!(
                std::path::Path::new(tail[1])
                    .file_stem()
                    .is_some_and(|stem| stem == "cowork-server"),
                "inner launcher re-execs the current binary: {args:?}"
            );
            assert_eq!(
                &tail[2..],
                &[
                    "__sandbox-exec",
                    "--linux-seccomp",
                    "--deny-network",
                    "--",
                    "/bin/echo",
                    "hi"
                ],
                "{args:?}"
            );
        }
        "macos-seatbelt" => {
            assert_eq!(json["file"], "/usr/bin/sandbox-exec");
            assert_eq!(args[0], "-p");
            assert_eq!(&args[args.len() - 2..], &["/bin/echo", "hi"]);
        }
        "windows-sandbox" => {
            assert_eq!(&args[args.len() - 2..], &["/bin/echo", "hi"]);
        }
        other => panic!("unexpected sandbox {other}"),
    }
}
