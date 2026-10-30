use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use data_encoding::{BASE32_NOPAD, BASE64URL_NOPAD};
use parking_lot::RwLock;
use rcgen::PublicKeyData;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBootstrapProgress {
    pub phase: String,
    pub version: String,
    pub transferred_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupProgressEvent {
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub component: &'static str,
    pub progress: RuntimeBootstrapProgress,
}

impl StartupProgressEvent {
    pub fn ready(version: impl Into<String>) -> Self {
        Self {
            event_type: "server_startup_progress",
            component: "cowork-runtime",
            progress: RuntimeBootstrapProgress {
                phase: "ready".to_owned(),
                version: version.into(),
                transferred_bytes: None,
                total_bytes: None,
                percent: Some(100),
            },
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileDevicePermissions {
    pub turns: bool,
    pub server_requests: bool,
    pub provider_auth: bool,
    pub mcp_auth: bool,
    pub workspace_settings: bool,
    pub backups: bool,
    pub conversations: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileTrustedDevice {
    pub device_id: String,
    pub fingerprint: String,
    pub display_name: Option<String>,
    pub last_paired_at: Option<String>,
    pub last_connected_at: Option<String>,
    pub permissions: MobileDevicePermissions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileH3ListeningInfo {
    pub url: String,
    pub port: u16,
    pub host_hints: Vec<String>,
    pub ticket: String,
    pub admin_token: String,
    pub cert_sha256: String,
    pub spki_sha256: String,
    pub identity_pub: String,
    pub nonce: String,
    pub expires_at: i64,
    pub trusted_device: Option<MobileTrustedDevice>,
    pub trusted_devices: Vec<MobileTrustedDevice>,
}

/// Manages `--mobile-h3` pairing metadata & trusted device table (`M3` wires full TLS listener).
#[derive(Debug)]
pub struct MobileH3AdminState {
    pub info: RwLock<MobileH3ListeningInfo>,
}

impl MobileH3AdminState {
    pub fn generate(host: &str, requested_port: u16) -> anyhow::Result<Self> {
        let subject_alt_names = vec!["localhost".to_owned(), "127.0.0.1".to_owned()];
        let certified = rcgen::generate_simple_self_signed(subject_alt_names)?;
        let cert_der = certified.cert.der();
        let cert_sha256 = hex::encode(Sha256::digest(cert_der.as_ref()));
        let spki_der = certified.signing_key.subject_public_key_info();
        let spki_sha256 = BASE64URL_NOPAD.encode(&Sha256::digest(&spki_der));
        let identity_pub = BASE64URL_NOPAD.encode(certified.signing_key.public_key_raw());
        let admin_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let nonce = BASE32_NOPAD.encode(Uuid::new_v4().as_bytes());
        let expires_at = chrono::Utc::now().timestamp_millis() + 15 * 60 * 1000;
        let host_hints = resolve_listening_hints(host);
        let connect_host = host_hints
            .first()
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        let port = if requested_port == 0 {
            17443
        } else {
            requested_port
        };
        let url = format!("https://{connect_host}:{port}");
        let ticket_payload = serde_json::to_vec(&serde_json::json!({
            "url": url,
            "certSha256": cert_sha256,
            "spkiSha256": spki_sha256,
            "nonce": nonce,
            "expiresAt": expires_at,
        }))?;
        let ticket = format!("cowork-pair://{}", BASE32_NOPAD.encode(&ticket_payload));

        Ok(Self {
            info: RwLock::new(MobileH3ListeningInfo {
                url,
                port,
                host_hints,
                ticket,
                admin_token,
                cert_sha256,
                spki_sha256,
                identity_pub,
                nonce,
                expires_at,
                trusted_device: None,
                trusted_devices: Vec::new(),
            }),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerListeningEvent {
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub url: String,
    pub ws_url: String,
    pub rpc_url: String,
    pub host: String,
    pub host_hints: Vec<String>,
    pub port: u16,
    pub cwd: String,
    pub browser_access_token: Option<String>,
    pub mobile_h3: Option<MobileH3ListeningInfo>,
}

/// Resolves connectable host hints for `0.0.0.0` / `::` or explicit bind hosts.
pub fn resolve_listening_hints(host: &str) -> Vec<String> {
    let trimmed = host.trim();
    if trimmed != "0.0.0.0" && trimmed != "::" {
        return vec![trimmed.to_owned()];
    }
    if trimmed == "::" {
        vec!["::1".to_owned(), "127.0.0.1".to_owned()]
    } else {
        vec!["127.0.0.1".to_owned()]
    }
}

/// Coordinates idempotent `<10s` graceful shutdown across `stdin` EOF (`COWORK_DESKTOP_PARENT_MANAGED=1`) and OS signals.
#[derive(Debug, Clone)]
pub struct ShutdownCoordinator {
    triggered: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl ShutdownCoordinator {
    pub fn new() -> Self {
        Self {
            triggered: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn trigger(&self) {
        if !self.triggered.swap(true, Ordering::SeqCst) {
            self.notify.notify_waiters();
        }
    }

    pub fn is_triggered(&self) -> bool {
        self.triggered.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        if self.is_triggered() {
            return;
        }
        let notified = self.notify.notified();
        if self.is_triggered() {
            return;
        }
        notified.await;
    }

    /// Spawns background watchers for `SIGINT`, `SIGTERM` (and `SIGHUP` on Unix), plus `stdin` EOF if `parent_managed`.
    pub fn install_process_watchers(&self, parent_managed: bool) {
        let sig_coord = self.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            {
                use tokio::signal::unix::{SignalKind, signal};
                let mut sigterm = signal(SignalKind::terminate()).ok();
                let mut sighup = signal(SignalKind::hangup()).ok();
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = async {
                        if let Some(s) = &mut sigterm {
                            let _ = s.recv().await;
                        } else {
                            std::future::pending::<()>().await;
                        }
                    } => {},
                    _ = async {
                        if let Some(s) = &mut sighup {
                            let _ = s.recv().await;
                        } else {
                            std::future::pending::<()>().await;
                        }
                    } => {},
                }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            sig_coord.trigger();
        });

        if parent_managed {
            let stdin_coord = self.clone();
            tokio::spawn(async move {
                let mut stdin = tokio::io::stdin();
                let mut buf = [0u8; 256];
                loop {
                    match stdin.read(&mut buf).await {
                        Ok(0) | Err(_) => {
                            stdin_coord.trigger();
                            break;
                        }
                        Ok(_) => {}
                    }
                }
            });
        }
    }
}
