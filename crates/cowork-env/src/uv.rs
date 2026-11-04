use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use cowork_config::canonicalize_sync;
use cowork_sandbox::scratch_roots;
use tokio::process::Command;
use uuid::Uuid;

use crate::error::{EnvError, Result};

/// Canonical environment pointers describing a `uv` cache and optional active `.venv`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UvEnvironmentPaths {
    pub cache_dir: PathBuf,
    pub venv_dir: Option<PathBuf>,
    pub venv_bin_dir: Option<PathBuf>,
    pub python_executable: PathBuf,
    pub offline: bool,
    pub wheelhouse_dir: Option<PathBuf>,
}

/// Configuration for `UvPythonManager`.
#[derive(Debug, Clone)]
pub struct UvManagerConfig {
    /// Cowork home root (`~/.cowork`, honoring `COWORK_HOME_OVERRIDE`).
    pub cowork_home: PathBuf,
    /// Explicit `uv` binary path (typically `<runtime>/dependencies/bin/uv`).
    pub uv_binary: Option<PathBuf>,
    /// Sealed base runtime Python executable (`<runtime>/dependencies/python/bin/python3`).
    pub base_python: PathBuf,
    /// Optional offline `.whl` wheelhouse directory (`<runtime>/wheels`).
    pub wheelhouse_dir: Option<PathBuf>,
    /// Enforce offline package resolution (`--offline --no-index`).
    pub offline: bool,
    /// Command timeout for `uv venv` and `uv pip install`.
    pub timeout: Duration,
}

/// RAII handle to an isolated, disposable `.venv` backed by `<cowork_home>/cache/uv`.
#[derive(Debug)]
pub struct EphemeralPythonEnv {
    venv_dir: PathBuf,
    python_executable: PathBuf,
    env_paths: UvEnvironmentPaths,
    cleaned: bool,
}

impl EphemeralPythonEnv {
    pub fn venv_dir(&self) -> &Path {
        &self.venv_dir
    }

    pub fn python_executable(&self) -> &Path {
        &self.python_executable
    }

    pub fn env_paths(&self) -> &UvEnvironmentPaths {
        &self.env_paths
    }

    pub fn cleanup(mut self) -> Result<()> {
        self.cleaned = true;
        if self.venv_dir.exists() {
            std::fs::remove_dir_all(&self.venv_dir)?;
        }
        Ok(())
    }
}

impl Drop for EphemeralPythonEnv {
    fn drop(&mut self) {
        if !self.cleaned && self.venv_dir.exists() {
            let _ = std::fs::remove_dir_all(&self.venv_dir);
        }
    }
}

/// Manages `<cowork_home>/cache/uv` and provisions cached or ephemeral virtual environments
/// without mutating sealed base runtime directories.
#[derive(Debug, Clone)]
pub struct UvPythonManager {
    cfg: UvManagerConfig,
}

impl UvPythonManager {
    pub fn new(cfg: UvManagerConfig) -> Self {
        Self { cfg }
    }

    /// Returns `<cowork_home>/cache/uv`.
    pub fn cache_dir(&self) -> PathBuf {
        self.cfg.cowork_home.join("cache").join("uv")
    }

    /// Returns `<cowork_home>/cache/uv/venvs` for content-addressed reusable environments.
    pub fn cached_venvs_dir(&self) -> PathBuf {
        self.cache_dir().join("venvs")
    }

    pub fn base_env_paths(&self) -> UvEnvironmentPaths {
        UvEnvironmentPaths {
            cache_dir: self.cache_dir(),
            venv_dir: None,
            venv_bin_dir: None,
            python_executable: self.cfg.base_python.clone(),
            offline: self.cfg.offline,
            wheelhouse_dir: self.cfg.wheelhouse_dir.clone(),
        }
    }

    fn resolve_uv_binary(&self) -> Result<PathBuf> {
        if let Some(explicit) = &self.cfg.uv_binary
            && explicit.is_file()
        {
            return Ok(explicit.clone());
        }
        if let Some(parent) = self.cfg.base_python.parent() {
            let sibling_name = if cfg!(windows) { "uv.exe" } else { "uv" };
            let candidate = parent.join(sibling_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(EnvError::UvUnavailable(format!(
            "No managed uv binary configured (base_python={})",
            self.cfg.base_python.display()
        )))
    }

    fn default_link_mode() -> &'static str {
        if cfg!(target_os = "macos") {
            "clone"
        } else if cfg!(target_os = "windows") {
            "hardlink"
        } else {
            "copy"
        }
    }

    fn venv_bin_and_python(venv_dir: &Path) -> (PathBuf, PathBuf) {
        if cfg!(windows) {
            let bin = venv_dir.join("Scripts");
            let py = bin.join("python.exe");
            (bin, py)
        } else {
            let bin = venv_dir.join("bin");
            let py3 = bin.join("python3");
            let py = if py3.exists() {
                py3
            } else {
                bin.join("python")
            };
            (bin, py)
        }
    }

    async fn run_uv(&self, args: &[String]) -> Result<()> {
        let uv_bin = self.resolve_uv_binary()?;
        let cache_dir = self.cache_dir();
        std::fs::create_dir_all(&cache_dir)?;

        let mut env: HashMap<String, String> = HashMap::new();
        if cowork_sandbox::host_platform() == "win32" {
            for sys_key in [
                "SystemRoot",
                "WINDIR",
                "TEMP",
                "TMP",
                "PATHEXT",
                "ComSpec",
                "PATH",
            ] {
                if let Ok(val) = std::env::var(sys_key) {
                    env.insert(sys_key.to_owned(), val);
                }
            }
        } else {
            env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
        }
        env.insert(
            "UV_CACHE_DIR".to_owned(),
            cache_dir.to_string_lossy().into_owned(),
        );
        env.insert("UV_PYTHON_PREFERENCE".to_owned(), "only-system".to_owned());
        env.insert("UV_NO_MANAGED_PYTHON".to_owned(), "1".to_owned());
        env.insert("UV_PYTHON_DOWNLOADS".to_owned(), "never".to_owned());
        env.insert(
            "UV_LINK_MODE".to_owned(),
            Self::default_link_mode().to_owned(),
        );
        if self.cfg.offline {
            env.insert("UV_OFFLINE".to_owned(), "1".to_owned());
            env.insert("UV_NO_INDEX".to_owned(), "1".to_owned());
        }
        if let Some(wh) = &self.cfg.wheelhouse_dir {
            env.insert(
                "UV_FIND_LINKS".to_owned(),
                wh.to_string_lossy().into_owned(),
            );
        }

        let mut cmd = Command::new(&uv_bin);
        cmd.args(args)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);

        let child = cmd.spawn().map_err(|e| {
            EnvError::UvFailed(format!("Failed spawning {}: {e}", uv_bin.display()))
        })?;
        let pid = child.id();

        match tokio::time::timeout(self.cfg.timeout, child.wait_with_output()).await {
            Ok(Ok(out)) => {
                if out.status.success() {
                    Ok(())
                } else {
                    Err(EnvError::UvFailed(format!(
                        "uv {:?} exited with {:?}: {}",
                        args,
                        out.status.code(),
                        String::from_utf8_lossy(&out.stderr).trim()
                    )))
                }
            }
            Ok(Err(e)) => Err(EnvError::UvFailed(format!("uv wait failed: {e}"))),
            Err(_) => {
                #[cfg(unix)]
                if let Some(raw_pid) = pid {
                    unsafe {
                        let _ = libc::killpg(raw_pid as i32, libc::SIGKILL);
                    }
                }
                Err(EnvError::UvFailed(format!(
                    "uv {:?} timed out after {}ms",
                    args,
                    self.cfg.timeout.as_millis()
                )))
            }
        }
    }

    /// Creates an isolated ephemeral `.venv` in canonical scratch space and optionally installs `packages`.
    pub async fn provision_ephemeral_venv(&self, packages: &[&str]) -> Result<EphemeralPythonEnv> {
        let scratch_base = scratch_roots(None)
            .into_iter()
            .next()
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&scratch_base)?;
        let canonical_scratch = canonicalize_sync(&scratch_base);
        let venv_dir =
            canonical_scratch.join(format!("cowork-uv-venv-{}", Uuid::new_v4().simple()));

        let cache_dir = self.cache_dir();
        std::fs::create_dir_all(&cache_dir)?;

        let venv_args = vec![
            "venv".to_owned(),
            "--no-project".to_owned(),
            "--python".to_owned(),
            self.cfg.base_python.to_string_lossy().into_owned(),
            "--cache-dir".to_owned(),
            cache_dir.to_string_lossy().into_owned(),
            "--link-mode".to_owned(),
            Self::default_link_mode().to_owned(),
            venv_dir.to_string_lossy().into_owned(),
        ];

        if let Err(err) = self.run_uv(&venv_args).await {
            let _ = std::fs::remove_dir_all(&venv_dir);
            return Err(err);
        }

        let (venv_bin, venv_py) = Self::venv_bin_and_python(&venv_dir);

        if !packages.is_empty() {
            let mut pip_args = vec![
                "pip".to_owned(),
                "install".to_owned(),
                "--python".to_owned(),
                venv_py.to_string_lossy().into_owned(),
                "--cache-dir".to_owned(),
                cache_dir.to_string_lossy().into_owned(),
                "--link-mode".to_owned(),
                Self::default_link_mode().to_owned(),
            ];
            if self.cfg.offline {
                pip_args.push("--offline".to_owned());
                pip_args.push("--no-index".to_owned());
            }
            if let Some(wh) = &self.cfg.wheelhouse_dir {
                pip_args.push("--find-links".to_owned());
                pip_args.push(wh.to_string_lossy().into_owned());
            }
            for pkg in packages {
                pip_args.push((*pkg).to_owned());
            }
            if let Err(err) = self.run_uv(&pip_args).await {
                let _ = std::fs::remove_dir_all(&venv_dir);
                return Err(err);
            }
        }

        let (_, resolved_py) = Self::venv_bin_and_python(&venv_dir);
        let env_paths = UvEnvironmentPaths {
            cache_dir,
            venv_dir: Some(venv_dir.clone()),
            venv_bin_dir: Some(venv_bin),
            python_executable: resolved_py.clone(),
            offline: self.cfg.offline,
            wheelhouse_dir: self.cfg.wheelhouse_dir.clone(),
        };

        Ok(EphemeralPythonEnv {
            venv_dir,
            python_executable: resolved_py,
            env_paths,
            cleaned: false,
        })
    }

    /// Provisions or reuses a content-addressed cached `.venv` under `<cowork_home>/cache/uv/venvs/<blake3>`,
    /// serializing concurrent builds via an `fs4` file lock.
    pub async fn ensure_cached_venv(&self, packages: &[&str]) -> Result<UvEnvironmentPaths> {
        let mut sorted_pkgs: Vec<&str> = packages.to_vec();
        sorted_pkgs.sort_unstable();
        let mut hasher = blake3::Hasher::new();
        hasher.update(self.cfg.base_python.to_string_lossy().as_bytes());
        for pkg in &sorted_pkgs {
            hasher.update(b"\0");
            hasher.update(pkg.as_bytes());
        }
        let key = hasher.finalize().to_hex().to_string();

        let venvs_root = self.cached_venvs_dir();
        std::fs::create_dir_all(&venvs_root)?;
        let target_venv = venvs_root.join(&key[..24]);
        let ready_marker = target_venv.join(".cowork-uv-ready");

        if ready_marker.is_file() {
            let (bin, py) = Self::venv_bin_and_python(&target_venv);
            return Ok(UvEnvironmentPaths {
                cache_dir: self.cache_dir(),
                venv_dir: Some(target_venv),
                venv_bin_dir: Some(bin),
                python_executable: py,
                offline: self.cfg.offline,
                wheelhouse_dir: self.cfg.wheelhouse_dir.clone(),
            });
        }

        let lock_path = venvs_root.join(format!("{}.lock", &key[..24]));
        let lock_file = tokio::task::spawn_blocking(move || -> Result<File> {
            let f = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(false)
                .open(&lock_path)?;
            <File as fs4::FileExt>::lock(&f)?;
            Ok(f)
        })
        .await
        .map_err(|e| EnvError::Lock(format!("uv cache lock join failed: {e}")))??;

        let res = async {
            if !ready_marker.is_file() {
                if target_venv.exists() {
                    let _ = std::fs::remove_dir_all(&target_venv);
                }
                let cache_dir = self.cache_dir();
                let venv_args = vec![
                    "venv".to_owned(),
                    "--no-project".to_owned(),
                    "--python".to_owned(),
                    self.cfg.base_python.to_string_lossy().into_owned(),
                    "--cache-dir".to_owned(),
                    cache_dir.to_string_lossy().into_owned(),
                    "--link-mode".to_owned(),
                    Self::default_link_mode().to_owned(),
                    target_venv.to_string_lossy().into_owned(),
                ];
                self.run_uv(&venv_args).await?;
                let (_, py) = Self::venv_bin_and_python(&target_venv);
                if !sorted_pkgs.is_empty() {
                    let mut pip_args = vec![
                        "pip".to_owned(),
                        "install".to_owned(),
                        "--python".to_owned(),
                        py.to_string_lossy().into_owned(),
                        "--cache-dir".to_owned(),
                        cache_dir.to_string_lossy().into_owned(),
                    ];
                    if self.cfg.offline {
                        pip_args.push("--offline".to_owned());
                        pip_args.push("--no-index".to_owned());
                    }
                    if let Some(wh) = &self.cfg.wheelhouse_dir {
                        pip_args.push("--find-links".to_owned());
                        pip_args.push(wh.to_string_lossy().into_owned());
                    }
                    for pkg in &sorted_pkgs {
                        pip_args.push((*pkg).to_owned());
                    }
                    self.run_uv(&pip_args).await?;
                }
                std::fs::write(&ready_marker, b"ok\n")?;
            }
            let (bin, py) = Self::venv_bin_and_python(&target_venv);
            Ok(UvEnvironmentPaths {
                cache_dir: self.cache_dir(),
                venv_dir: Some(target_venv),
                venv_bin_dir: Some(bin),
                python_executable: py,
                offline: self.cfg.offline,
                wheelhouse_dir: self.cfg.wheelhouse_dir.clone(),
            })
        }
        .await;

        let _ = <File as fs4::FileExt>::unlock(&lock_file);
        res
    }
}
