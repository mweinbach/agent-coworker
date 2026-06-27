//! Cowork's Windows sandbox runner.
//!
//! The enforcement engine is pinned to OpenAI Codex's audited Windows sandbox
//! implementation. It uses capability-SID ACLs, dedicated online/offline
//! identities, WFP rules, restricted tokens, and a kill-on-close Job Object.

#[cfg(windows)]
mod win {
    use anyhow::{Context, Result, bail};
    use codex_protocol::config_types::WindowsSandboxLevel;
    use codex_protocol::models::PermissionProfile;
    use codex_protocol::permissions::NetworkSandboxPolicy;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use codex_windows_sandbox::{
        ResolvedWindowsSandboxPermissions, SandboxSetupRequest, SetupRootOverrides,
        WindowsSandboxSessionRequest, forward_sandbox_session_stdio, run_elevated_setup,
        sandbox_setup_is_complete, spawn_windows_sandbox_session_for_level,
    };
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use std::fs;
    use std::net::{SocketAddr, TcpStream};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[derive(Debug)]
    struct Options {
        action: String,
        mode: String,
        writable_roots: Vec<PathBuf>,
        cwd: PathBuf,
        sandbox_home: PathBuf,
        allow_network: bool,
        command: Vec<String>,
    }

    #[derive(Deserialize, Serialize)]
    struct ProbeResult {
        schema_version: u32,
        ready: bool,
        filesystem: bool,
        network: bool,
        process: bool,
        integrity: bool,
        setup_required: bool,
    }

    #[derive(Deserialize, Serialize)]
    struct ProbeChildResult {
        allowed_write: bool,
        outside_write_blocked: bool,
        metadata_write_blocked: bool,
        junction_write_blocked: bool,
        child_write_blocked: bool,
        temp_write_allowed: bool,
        network_blocked: bool,
    }

    fn parse_args() -> Result<Options> {
        let mut args = std::env::args().skip(1);
        let action = args.next().unwrap_or_else(|| "run".to_string());
        if !matches!(action.as_str(), "probe" | "setup" | "run") {
            bail!("expected probe, setup, or run; got {action}");
        }
        let mut mode = "workspace-write".to_string();
        let mut writable_roots = Vec::new();
        let mut cwd = std::env::current_dir().context("resolve current directory")?;
        let mut sandbox_home = dirs_next::home_dir()
            .unwrap_or_else(|| cwd.clone())
            .join(".cowork");
        let mut allow_network = false;
        let mut command = Vec::new();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--mode" => mode = args.next().context("missing value for --mode")?,
                "--writable-root" => writable_roots.push(PathBuf::from(
                    args.next().context("missing value for --writable-root")?,
                )),
                "--cwd" => cwd = PathBuf::from(args.next().context("missing value for --cwd")?),
                "--sandbox-home" => {
                    sandbox_home =
                        PathBuf::from(args.next().context("missing value for --sandbox-home")?)
                }
                "--allow-network" => allow_network = true,
                "--" => {
                    command = args.collect();
                    break;
                }
                other => bail!("unexpected argument: {other}"),
            }
        }
        if action == "run" && command.is_empty() {
            bail!("missing command after --");
        }
        if !cwd.is_absolute() || !sandbox_home.is_absolute() {
            bail!("--cwd and --sandbox-home must be absolute");
        }
        if writable_roots.iter().any(|root| !root.is_absolute()) {
            bail!("every --writable-root must be absolute");
        }
        if writable_roots.is_empty() && mode == "workspace-write" {
            writable_roots.push(cwd.clone());
        }
        Ok(Options {
            action,
            mode,
            writable_roots,
            cwd,
            sandbox_home,
            allow_network,
            command,
        })
    }

    fn absolute(path: &Path) -> Result<AbsolutePathBuf> {
        AbsolutePathBuf::from_absolute_path(path)
            .map_err(|err| anyhow::anyhow!("invalid absolute path {}: {err}", path.display()))
    }

    fn permission_profile(opts: &Options) -> Result<PermissionProfile> {
        let network = if opts.allow_network {
            NetworkSandboxPolicy::Enabled
        } else {
            NetworkSandboxPolicy::Restricted
        };
        match opts.mode.as_str() {
            // The upstream Windows sandbox deliberately refuses an unrestricted
            // filesystem profile: its WFP rules are bound to restricted sandbox
            // identities. Keep this mode conservatively writable in cwd and the
            // managed temp roots while enforcing the requested network policy.
            "network-only" => Ok(PermissionProfile::workspace_write_with(
                &[absolute(&opts.cwd)?],
                network,
                false,
                false,
            )),
            "read-only" | "no-project-write" => Ok(PermissionProfile::read_only()),
            "workspace-write" => {
                let roots = opts
                    .writable_roots
                    .iter()
                    .map(|root| absolute(root))
                    .collect::<Result<Vec<_>>>()?;
                Ok(PermissionProfile::workspace_write_with(
                    &roots, network, false, false,
                ))
            }
            other => bail!("unsupported sandbox mode: {other}"),
        }
    }

    fn protected_metadata(opts: &Options) -> Vec<PathBuf> {
        opts.writable_roots
            .iter()
            .flat_map(|root| {
                [
                    root.join(".git"),
                    root.join(".agents"),
                    root.join(".codex"),
                    root.join(".cowork"),
                ]
            })
            .collect()
    }

    fn workspace_roots(opts: &Options) -> Result<Vec<AbsolutePathBuf>> {
        let roots = if opts.writable_roots.is_empty() {
            vec![opts.cwd.clone()]
        } else {
            opts.writable_roots.clone()
        };
        roots.iter().map(|root| absolute(root)).collect()
    }

    fn setup(opts: &Options) -> Result<()> {
        let profile = permission_profile(opts)?;
        let roots = workspace_roots(opts)?;
        let permissions =
            ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots(
                &profile, &roots,
            )?;
        let env_map = std::env::vars().collect::<HashMap<_, _>>();
        run_elevated_setup(
            SandboxSetupRequest {
                permissions: &permissions,
                command_cwd: &opts.cwd,
                env_map: &env_map,
                codex_home: &opts.sandbox_home,
                proxy_enforced: false,
            },
            SetupRootOverrides {
                deny_write_paths: Some(protected_metadata(opts)),
                ..Default::default()
            },
        )
    }

    fn next_arg(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<PathBuf> {
        Ok(PathBuf::from(
            args.next()
                .with_context(|| format!("missing value for {flag}"))?,
        ))
    }

    fn probe_grandchild() -> Result<i32> {
        let destination = std::env::args()
            .nth(2)
            .context("probe-grandchild requires a destination")?;
        Ok(if fs::write(destination, b"escape").is_ok() {
            0
        } else {
            9
        })
    }

    fn probe_child() -> Result<i32> {
        let mut args = std::env::args().skip(2);
        let mut allowed = None;
        let mut blocked = None;
        let mut metadata = None;
        let mut junction = None;
        let mut child_blocked = None;
        let mut temp_allowed = None;
        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--allowed" => allowed = Some(next_arg(&mut args, &flag)?),
                "--blocked" => blocked = Some(next_arg(&mut args, &flag)?),
                "--metadata" => metadata = Some(next_arg(&mut args, &flag)?),
                "--junction" => junction = Some(next_arg(&mut args, &flag)?),
                "--child-blocked" => child_blocked = Some(next_arg(&mut args, &flag)?),
                "--temp-allowed" => temp_allowed = Some(next_arg(&mut args, &flag)?),
                other => bail!("unexpected probe-child argument: {other}"),
            }
        }
        let allowed = allowed.context("probe-child requires --allowed")?;
        let blocked = blocked.context("probe-child requires --blocked")?;
        let metadata = metadata.context("probe-child requires --metadata")?;
        let junction = junction.context("probe-child requires --junction")?;
        let child_blocked = child_blocked.context("probe-child requires --child-blocked")?;
        let temp_allowed = temp_allowed.context("probe-child requires --temp-allowed")?;
        let child_status = Command::new(std::env::current_exe()?)
            .arg("probe-grandchild")
            .arg(&child_blocked)
            .status()
            .context("spawn sandbox probe grandchild")?;
        let network_target = SocketAddr::from(([1, 1, 1, 1], 443));
        let result = ProbeChildResult {
            allowed_write: fs::write(&allowed, b"allowed").is_ok() && allowed.is_file(),
            outside_write_blocked: fs::write(&blocked, b"blocked").is_err() && !blocked.exists(),
            metadata_write_blocked: fs::write(&metadata, b"blocked").is_err() && !metadata.exists(),
            junction_write_blocked: fs::write(&junction, b"blocked").is_err() && !junction.exists(),
            child_write_blocked: !child_status.success() && !child_blocked.exists(),
            temp_write_allowed: fs::write(&temp_allowed, b"allowed").is_ok()
                && temp_allowed.is_file(),
            network_blocked: TcpStream::connect_timeout(&network_target, Duration::from_secs(2))
                .is_err(),
        };
        println!("{}", serde_json::to_string(&result)?);
        Ok(0)
    }

    async fn collect_probe_result(
        mut spawned: codex_utils_pty::SpawnedProcess,
    ) -> Result<ProbeChildResult> {
        let exit_code = spawned
            .exit_rx
            .await
            .context("sandbox probe exit channel closed")?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        while let Ok(Some(chunk)) =
            tokio::time::timeout(Duration::from_millis(250), spawned.stdout_rx.recv()).await
        {
            stdout.extend_from_slice(&chunk);
        }
        while let Ok(Some(chunk)) =
            tokio::time::timeout(Duration::from_millis(250), spawned.stderr_rx.recv()).await
        {
            stderr.extend_from_slice(&chunk);
        }
        if exit_code != 0 {
            bail!(
                "sandbox enforcement probe child exited {exit_code}: {}",
                String::from_utf8_lossy(&stderr)
            );
        }
        serde_json::from_slice(&stdout).context("parse sandbox enforcement probe output")
    }

    async fn probe(opts: &Options) -> Result<ProbeResult> {
        if !sandbox_setup_is_complete(&opts.sandbox_home) {
            return Ok(ProbeResult {
                schema_version: 1,
                ready: false,
                filesystem: false,
                network: false,
                process: false,
                integrity: true,
                setup_required: true,
            });
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "cowork-sandbox-probe-{}-{nonce}",
            std::process::id()
        ));
        let workspace = base.join("workspace");
        // The managed profile intentionally permits TEMP/TMP writes, so the
        // denial target must live outside both the workspace and host temp.
        let outside = opts
            .sandbox_home
            .parent()
            .unwrap_or(&opts.cwd)
            .join(format!(
                "cowork-sandbox-probe-outside-{}-{nonce}",
                std::process::id()
            ));
        let metadata_dir = workspace.join(".git");
        fs::create_dir_all(&metadata_dir)?;
        fs::create_dir_all(&outside)?;
        let junction_dir = workspace.join("junction");
        let junction_status = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction_dir)
            .arg(&outside)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .context("create sandbox probe junction")?;
        if !junction_status.success() {
            let _ = fs::remove_dir_all(&base);
            let _ = fs::remove_dir_all(&outside);
            bail!("failed to create sandbox probe junction");
        }

        let allowed_file = workspace.join("allowed.txt");
        let blocked_file = outside.join("blocked.txt");
        let metadata_file = metadata_dir.join("config");
        let junction_file = junction_dir.join("junction-escape.txt");
        let child_blocked_file = outside.join("child-escape.txt");
        let temp_allowed_file = base.join("temp-allowed.txt");
        let profile_opts = Options {
            action: "run".to_string(),
            mode: "workspace-write".to_string(),
            writable_roots: vec![workspace.clone()],
            cwd: workspace.clone(),
            sandbox_home: opts.sandbox_home.clone(),
            allow_network: false,
            command: Vec::new(),
        };
        let profile = permission_profile(&profile_opts)?;
        let roots = workspace_roots(&profile_opts)?;
        let deny_write = protected_metadata(&profile_opts)
            .iter()
            .filter_map(|candidate| absolute(candidate).ok())
            .collect::<Vec<_>>();
        let command = vec![
            std::env::current_exe()?.to_string_lossy().into_owned(),
            "probe-child".to_string(),
            "--allowed".to_string(),
            allowed_file.to_string_lossy().into_owned(),
            "--blocked".to_string(),
            blocked_file.to_string_lossy().into_owned(),
            "--metadata".to_string(),
            metadata_file.to_string_lossy().into_owned(),
            "--junction".to_string(),
            junction_file.to_string_lossy().into_owned(),
            "--child-blocked".to_string(),
            child_blocked_file.to_string_lossy().into_owned(),
            "--temp-allowed".to_string(),
            temp_allowed_file.to_string_lossy().into_owned(),
        ];
        let spawned = spawn_windows_sandbox_session_for_level(WindowsSandboxSessionRequest {
            permission_profile: &profile,
            workspace_roots: &roots,
            codex_home: &opts.sandbox_home,
            command,
            cwd: &workspace,
            env_map: std::env::vars().collect(),
            windows_sandbox_level: WindowsSandboxLevel::Elevated,
            proxy_enforced: false,
            timeout_ms: Some(30_000),
            read_roots_override: None,
            read_roots_include_platform_defaults: true,
            write_roots_override: None,
            deny_read_paths_override: &[],
            deny_write_paths_override: &deny_write,
            tty: false,
            stdin_open: false,
            use_private_desktop: false,
        })
        .await;
        let child = match spawned {
            Ok(spawned) => collect_probe_result(spawned).await,
            Err(error) => Err(error),
        };
        let _ = fs::remove_dir(&junction_dir);
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&outside);
        let child = child?;
        let filesystem = child.allowed_write
            && child.outside_write_blocked
            && child.metadata_write_blocked
            && child.junction_write_blocked
            && child.temp_write_allowed;
        let ready = filesystem && child.network_blocked && child.child_write_blocked;
        Ok(ProbeResult {
            schema_version: 1,
            ready,
            filesystem,
            network: child.network_blocked,
            process: child.child_write_blocked,
            integrity: true,
            setup_required: !ready,
        })
    }

    async fn run(opts: Options) -> Result<i32> {
        let profile = permission_profile(&opts)?;
        let roots = workspace_roots(&opts)?;
        let deny_write = protected_metadata(&opts)
            .iter()
            .filter_map(|path| absolute(path).ok())
            .collect::<Vec<_>>();
        let env_map = std::env::vars().collect::<HashMap<_, _>>();
        let spawned = spawn_windows_sandbox_session_for_level(WindowsSandboxSessionRequest {
            permission_profile: &profile,
            workspace_roots: &roots,
            codex_home: &opts.sandbox_home,
            command: opts.command,
            cwd: &opts.cwd,
            env_map,
            windows_sandbox_level: WindowsSandboxLevel::Elevated,
            proxy_enforced: false,
            timeout_ms: None,
            read_roots_override: None,
            read_roots_include_platform_defaults: true,
            write_roots_override: None,
            deny_read_paths_override: &[],
            deny_write_paths_override: &deny_write,
            tty: false,
            stdin_open: true,
            use_private_desktop: false,
        })
        .await?;
        Ok(forward_sandbox_session_stdio(spawned).await)
    }

    pub fn main() -> Result<i32> {
        match std::env::args().nth(1).as_deref() {
            Some("probe-child") => return probe_child(),
            Some("probe-grandchild") => return probe_grandchild(),
            _ => {}
        }
        let opts = parse_args()?;
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(async {
                match opts.action.as_str() {
                    "probe" => {
                        let result = probe(&opts).await?;
                        println!("{}", serde_json::to_string(&result)?);
                        Ok(if result.ready { 0 } else { 3 })
                    }
                    "setup" => {
                        setup(&opts)?;
                        let result = probe(&opts).await?;
                        println!("{}", serde_json::to_string(&result)?);
                        Ok(if result.ready { 0 } else { 4 })
                    }
                    "run" => run(opts).await,
                    _ => unreachable!(),
                }
            })
    }
}

fn main() {
    #[cfg(windows)]
    match win::main() {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("cowork-win-sandbox: {err:#}");
            std::process::exit(2);
        }
    }

    #[cfg(not(windows))]
    {
        eprintln!("cowork-win-sandbox is only supported on Windows");
        std::process::exit(2);
    }
}
