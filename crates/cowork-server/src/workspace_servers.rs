//! Native sidecars owned by the browser shell's workspace start/stop routes.
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::registry::ServerRuntimeState;

struct WorkspaceServer {
    stop: oneshot::Sender<()>,
    exited: JoinHandle<()>,
    path: PathBuf,
    yolo: bool,
    url: String,
}

impl WorkspaceServer {
    async fn launch(path: PathBuf, yolo: bool, runtime: &ServerRuntimeState) -> Result<Self> {
        let current = std::env::current_exe()?;
        let executable = if current
            .file_stem()
            .is_some_and(|s| s.to_string_lossy().starts_with("cowork-server"))
        {
            current
        } else {
            // An embedded server (e.g. the CLI) uses the companion sidecar.
            current.with_file_name(format!("cowork-server{}", std::env::consts::EXE_SUFFIX))
        };
        let mut command = Command::new(executable);
        command
            .arg("--dir")
            .arg(&path)
            .args(["--host", "127.0.0.1", "--port", "0", "--json"])
            .env_clear()
            .envs(&runtime.env)
            .env_remove("COWORK_BUILTIN_DIR")
            .env(cowork_config::COWORK_HOME_OVERRIDE_ENV, &runtime.homedir)
            .env("COWORK_DESKTOP_PARENT_MANAGED", "1")
            .env("COWORK_H3_MOBILE_PAIRING", "0")
            .env_remove("COWORK_DESKTOP_STARTUP_EVENTS")
            // The child's web service issues a token specific to its own listener.
            .env_remove("COWORK_BROWSER_ACCESS_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        if runtime.built_in_dir.is_dir() {
            command.env("COWORK_BUILTIN_DIR", &runtime.built_in_dir);
        }
        if yolo {
            command.arg("--yolo");
        }
        let mut child = command
            .spawn()
            .context("Could not start workspace server")?;
        let mut output = BufReader::new(
            child
                .stdout
                .take()
                .context("Missing workspace server stdout")?,
        );
        let url = timeout(Duration::from_secs(15), async {
            let mut line = String::new();
            while output.read_line(&mut line).await? != 0 {
                if let Ok(event) = serde_json::from_str::<Value>(&line)
                    && event["type"] == "server_listening"
                {
                    let mut url = Url::parse(
                        event["url"]
                            .as_str()
                            .context("Missing workspace server URL")?,
                    )?;
                    let token = event["browserAccessToken"]
                        .as_str()
                        .context("Missing workspace browser token")?;
                    url.query_pairs_mut()
                        .append_pair("coworkBrowserToken", token);
                    return Ok(url.to_string());
                }
                line.clear();
            }
            bail!("Workspace server exited before reporting readiness")
        })
        .await
        .context("Workspace server startup timed out")??;
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut output, &mut tokio::io::sink()).await;
        });
        // Hold stdin outside Child::wait(), which otherwise closes it immediately.
        let stdin = child
            .stdin
            .take()
            .context("Missing workspace server stdin")?;
        let (stop, stop_requested) = oneshot::channel();
        let exited = tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                _ = stop_requested => {
                    drop(stdin);
                    if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                        let _ = child.kill().await;
                    }
                }
            }
        });
        Ok(Self {
            stop,
            exited,
            path,
            yolo,
            url,
        })
    }

    async fn stop(self) {
        let _ = self.stop.send(());
        let _ = self.exited.await;
    }
}

type WorkspaceSlot = Arc<Mutex<Option<WorkspaceServer>>>;

#[derive(Default)]
pub(crate) struct WorkspaceServers {
    slots: parking_lot::Mutex<HashMap<String, WorkspaceSlot>>,
    shutdown: CancellationToken,
}

impl fmt::Debug for WorkspaceServers {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Workspace URLs include browser bearer tokens.
        f.debug_struct("WorkspaceServers").finish_non_exhaustive()
    }
}

impl WorkspaceServers {
    pub(crate) async fn start(
        &self,
        id: &str,
        path: &Path,
        yolo: bool,
        runtime: &ServerRuntimeState,
    ) -> Result<String> {
        let slot = {
            let mut slots = self.slots.lock();
            if self.shutdown.is_cancelled() {
                bail!("Workspace server manager is stopped");
            }
            Arc::clone(slots.entry(id.to_owned()).or_default())
        };
        // Only serialize operations for this id; unrelated projects can start independently.
        let mut active = slot.lock().await;
        if let Some(existing) = active.as_ref()
            && existing.path == path
            && existing.yolo == yolo
            && !existing.exited.is_finished()
        {
            return Ok(existing.url.clone());
        }
        if let Some(previous) = active.take() {
            previous.stop().await;
        }
        let launched = tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => bail!("Workspace server manager is stopped"),
            launched = WorkspaceServer::launch(path.to_path_buf(), yolo, runtime) => launched,
        };
        match launched {
            Ok(server) => {
                let url = server.url.clone();
                *active = Some(server);
                Ok(url)
            }
            Err(err) => {
                self.release_empty_slot(id, &slot);
                Err(err)
            }
        }
    }

    pub(crate) async fn status(&self, id: &str) -> (&'static str, Option<String>) {
        let slot = self.slots.lock().get(id).cloned();
        if let Some(slot) = slot {
            let mut active = slot.lock().await;
            if let Some(server) = active.as_ref() {
                if !server.exited.is_finished() {
                    return ("running", Some(server.url.clone()));
                }
                active.take();
                self.release_empty_slot(id, &slot);
                return ("exited", None);
            }
        }
        ("not_found", None)
    }

    pub(crate) async fn stop(&self, id: &str) {
        let slot = self.slots.lock().get(id).cloned();
        if let Some(slot) = slot {
            let mut active = slot.lock().await;
            if let Some(server) = active.take() {
                server.stop().await;
            }
            self.release_empty_slot(id, &slot);
        }
    }

    // Called with the empty slot locked. A concurrent start/stop may already be waiting on it.
    fn release_empty_slot(&self, id: &str, slot: &WorkspaceSlot) {
        let mut slots = self.slots.lock();
        if Arc::strong_count(slot) == 2 {
            slots.remove(id);
        }
    }

    pub(crate) async fn stop_all(&self) {
        self.shutdown.cancel();
        let slots = std::mem::take(&mut *self.slots.lock());
        futures_util::future::join_all(slots.into_values().map(|slot| async move {
            if let Some(server) = slot.lock().await.take() {
                server.stop().await;
            }
        }))
        .await;
    }
}
