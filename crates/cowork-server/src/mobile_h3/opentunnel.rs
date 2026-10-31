use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use chrono::Utc;
use cowork_config::{ensure_private_dir_sync, write_text_file_atomic};
use futures_util::{SinkExt, StreamExt};
use parking_lot::{Mutex, RwLock};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use rcgen::{CertificateParams, DnType, KeyPair, PKCS_ECDSA_P256_SHA256};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::mobile_h3::cert::{
    CERT_RENEWAL_BUFFER_MS, EphemeralQuicCertificate, certificate_from_pem,
    resolve_h3_pairing_store_dir,
};

pub const DEFAULT_OPENTUNNEL_API_URL: &str = "https://opentunnel.xyz";
const OPENTUNNEL_IDENTITY_FILE_NAME: &str = "opentunnel-identity.json";
pub const DEFAULT_CERT_POLL_INTERVAL: Duration = Duration::from_secs(1);
pub const DEFAULT_CERT_POLL_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_ATTACH_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_HEARTBEAT_MS: u64 = 15_000;

pub(crate) fn ensure_default_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

#[derive(Debug, Clone, Default)]
pub struct OpenTunnelServerConfig {
    pub enabled: Option<bool>,
    pub required: bool,
    pub api_url: Option<String>,
    pub tunnel_name: Option<String>,
    pub public_port: Option<u16>,
    pub poll_interval: Option<Duration>,
    pub poll_timeout: Option<Duration>,
    pub attach_timeout: Option<Duration>,
}

#[derive(Debug, Clone)]
pub struct OpenTunnelProvisionOptions {
    pub store_root_path: PathBuf,
    pub api_url: String,
    pub tunnel_name: Option<String>,
    pub force_rotate: bool,
    pub poll_interval: Duration,
    pub poll_timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenTunnelCertificateBundle {
    pub cert: EphemeralQuicCertificate,
    pub tunnel_id: String,
    pub hostname: String,
    pub token: String,
    pub api_url: String,
}

#[derive(Debug, Clone)]
pub struct OpenTunnelBridgeOptions {
    pub api_url: String,
    pub tunnel_id: String,
    pub token: String,
    pub local_host: String,
    pub local_port: u16,
    pub attach_timeout: Duration,
    pub reconnect_base_delay: Duration,
    pub reconnect_max_delay: Duration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedOpenTunnelIdentity {
    version: u8,
    api_url: String,
    id: String,
    hostname: String,
    token: String,
    private_key_pem: String,
    certificate_pem: String,
    chain_pem: String,
    expiry: i64,
}

pub fn normalize_api_url(raw: Option<&str>) -> String {
    let trimmed = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_OPENTUNNEL_API_URL);
    trimmed.trim_end_matches('/').to_owned()
}

fn to_websocket_base_url(api_url: &str) -> String {
    if let Some(rest) = api_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = api_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        api_url.to_owned()
    }
}

fn resolve_identity_path(store_root: &Path) -> PathBuf {
    resolve_h3_pairing_store_dir(store_root).join(OPENTUNNEL_IDENTITY_FILE_NAME)
}

fn encode_path_segment(seg: &str) -> String {
    utf8_percent_encode(seg, NON_ALPHANUMERIC).to_string()
}

fn bundle_from_identity(
    identity: &PersistedOpenTunnelIdentity,
) -> anyhow::Result<OpenTunnelCertificateBundle> {
    let full_chain_pem = if identity.chain_pem.trim().is_empty() {
        format!("{}\n", identity.certificate_pem.trim())
    } else {
        format!(
            "{}\n{}\n",
            identity.certificate_pem.trim(),
            identity.chain_pem.trim()
        )
    };
    let cert = certificate_from_pem(&full_chain_pem, &identity.private_key_pem)?;
    Ok(OpenTunnelCertificateBundle {
        cert,
        tunnel_id: identity.id.clone(),
        hostname: identity.hostname.clone(),
        token: identity.token.clone(),
        api_url: identity.api_url.clone(),
    })
}

fn read_persisted_identity(
    store_root: &Path,
    expected_api_url: &str,
) -> Option<OpenTunnelCertificateBundle> {
    let raw = std::fs::read_to_string(resolve_identity_path(store_root)).ok()?;
    let identity: PersistedOpenTunnelIdentity = serde_json::from_str(&raw).ok()?;
    if identity.version != 1
        || identity.api_url != expected_api_url
        || identity.id.trim().is_empty()
        || identity.hostname.trim().is_empty()
        || identity.token.trim().is_empty()
        || identity.private_key_pem.trim().is_empty()
        || identity.certificate_pem.trim().is_empty()
    {
        return None;
    }
    let now_ms = Utc::now().timestamp_millis();
    if identity.expiry.saturating_sub(now_ms) <= CERT_RENEWAL_BUFFER_MS {
        return None;
    }
    bundle_from_identity(&identity).ok()
}

fn write_persisted_identity(
    store_root: &Path,
    identity: &PersistedOpenTunnelIdentity,
) -> anyhow::Result<()> {
    let dir = resolve_h3_pairing_store_dir(store_root);
    ensure_private_dir_sync(&dir)?;
    let path = resolve_identity_path(store_root);
    let serialized = serde_json::to_string_pretty(identity)?;
    write_text_file_atomic(&path, &serialized, Some(0o600))?;
    Ok(())
}

async fn clear_persisted_identity(
    store_root: &Path,
    override_api_url: Option<&str>,
    http: &reqwest::Client,
) {
    let path = resolve_identity_path(store_root);
    if let Ok(raw) = std::fs::read_to_string(&path)
        && let Ok(parsed) = serde_json::from_str::<Value>(&raw)
    {
        let id = parsed
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let token = parsed
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let stored_api = parsed.get("apiUrl").and_then(Value::as_str);
        if !id.is_empty() && !token.is_empty() {
            let api = normalize_api_url(override_api_url.or(stored_api));
            let url = format!("{api}/api/tunnel/{}", encode_path_segment(id));
            let _ = http.delete(url).bearer_auth(token).send().await;
        }
    }
    let _ = std::fs::remove_file(&path);
}

pub fn create_open_tunnel_csr(hostname: &str) -> anyhow::Result<(String, String)> {
    let trimmed = hostname.trim();
    if trimmed.is_empty() {
        anyhow::bail!("OpenTunnel CSR hostname cannot be empty.");
    }
    let key_pair = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
    let sans = vec![trimmed.to_owned(), format!("*.{trimmed}")];
    let mut params = CertificateParams::new(sans)?;
    params.distinguished_name.push(DnType::CommonName, trimmed);
    let csr = params.serialize_request(&key_pair)?;
    Ok((csr.pem()?, key_pair.serialize_pem()))
}

pub fn encode_open_tunnel_binary_frame(conn: u32, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&conn.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub fn decode_open_tunnel_binary_frame(raw: &[u8]) -> Option<(u32, &[u8])> {
    if raw.len() < 4 {
        return None;
    }
    let conn = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]);
    Some((conn, &raw[4..]))
}

pub async fn load_or_provision_open_tunnel_identity(
    options: OpenTunnelProvisionOptions,
) -> anyhow::Result<OpenTunnelCertificateBundle> {
    ensure_default_crypto_provider();
    let api_url = normalize_api_url(Some(&options.api_url));
    let http = reqwest::Client::builder().no_proxy().build()?;

    if options.force_rotate {
        clear_persisted_identity(&options.store_root_path, Some(&api_url), &http).await;
    } else if let Some(existing) = read_persisted_identity(&options.store_root_path, &api_url) {
        return Ok(existing);
    }

    let create_res = http
        .post(format!("{api_url}/api/tunnel"))
        .json(&json!({
            "name": options.tunnel_name.as_deref().unwrap_or("cowork"),
        }))
        .send()
        .await?;
    if !create_res.status().is_success() {
        anyhow::bail!(
            "OpenTunnel creation failed with HTTP {}.",
            create_res.status().as_u16()
        );
    }
    let created: Value = create_res.json().await?;
    let tunnel_id = created
        .pointer("/tunnel/id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    let hostname = created
        .pointer("/tunnel/hostname")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    let token = created
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    if tunnel_id.is_empty() || hostname.is_empty() || token.is_empty() {
        anyhow::bail!("OpenTunnel creation response was missing tunnel id, hostname, or token.");
    }

    let (csr_pem, private_key_pem) = create_open_tunnel_csr(&hostname)?;
    let cert_url = format!(
        "{api_url}/api/tunnel/{}/certificate",
        encode_path_segment(&tunnel_id)
    );
    let bind_res = http
        .post(&cert_url)
        .bearer_auth(&token)
        .json(&json!({ "csr": csr_pem }))
        .send()
        .await?;
    if !bind_res.status().is_success() {
        anyhow::bail!(
            "OpenTunnel certificate binding failed with HTTP {}.",
            bind_res.status().as_u16()
        );
    }

    let mut cert_status: Value = bind_res.json().await.unwrap_or_else(|_| json!({}));
    let poll_interval = options.poll_interval.max(Duration::from_millis(10));
    let poll_timeout = options.poll_timeout.max(poll_interval);
    let started = Instant::now();

    while cert_status.pointer("/state/type").and_then(Value::as_str) != Some("ready") {
        if cert_status.pointer("/state/type").and_then(Value::as_str) == Some("failed") {
            let err_msg = cert_status
                .pointer("/state/error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            anyhow::bail!("OpenTunnel certificate issuance failed: {err_msg}.");
        }
        if started.elapsed() >= poll_timeout {
            anyhow::bail!("Timed out waiting for OpenTunnel certificate issuance.");
        }
        tokio::time::sleep(poll_interval).await;
        let poll_res = http.get(&cert_url).bearer_auth(&token).send().await?;
        if !poll_res.status().is_success() {
            anyhow::bail!(
                "OpenTunnel certificate poll failed with HTTP {}.",
                poll_res.status().as_u16()
            );
        }
        cert_status = poll_res.json().await?;
    }

    let certificate_pem = cert_status
        .pointer("/state/certificate")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let chain_pem = cert_status
        .pointer("/state/chain")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let expiry = cert_status
        .pointer("/state/expiry")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let identity = PersistedOpenTunnelIdentity {
        version: 1,
        api_url,
        id: tunnel_id,
        hostname,
        token,
        private_key_pem,
        certificate_pem,
        chain_pem,
        expiry,
    };
    write_persisted_identity(&options.store_root_path, &identity)?;
    bundle_from_identity(&identity)
}

enum MuxWriteCmd {
    Data(Vec<u8>),
    End,
    Reset,
}

struct ActiveMuxConn {
    token: u64,
    cmd_tx: mpsc::UnboundedSender<MuxWriteCmd>,
    task: JoinHandle<()>,
}

pub struct OpenTunnelBridgeHandle {
    session: Arc<RwLock<String>>,
    routes: Arc<RwLock<Vec<String>>>,
    stopped: Arc<AtomicBool>,
    stop_notify: Arc<Notify>,
    supervisor_task: JoinHandle<()>,
}

impl OpenTunnelBridgeHandle {
    pub fn session(&self) -> String {
        self.session.read().clone()
    }

    pub fn routes(&self) -> Vec<String> {
        self.routes.read().clone()
    }

    pub async fn stop(self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.stop_notify.notify_waiters();
        let _ = tokio::time::timeout(Duration::from_secs(3), self.supervisor_task).await;
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_local_tcp_mux_conn(
    conn_id: u32,
    conn_token: u64,
    local_host: String,
    local_port: u16,
    ws_out_tx: mpsc::UnboundedSender<WsMessage>,
    active_conns: Arc<Mutex<HashMap<u32, ActiveMuxConn>>>,
    mut cmd_rx: mpsc::UnboundedReceiver<MuxWriteCmd>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let tcp = match TcpStream::connect((local_host.as_str(), local_port)).await {
            Ok(s) => s,
            Err(_) => {
                let removed = {
                    let mut map = active_conns.lock();
                    if map.get(&conn_id).is_some_and(|e| e.token == conn_token) {
                        map.remove(&conn_id).is_some()
                    } else {
                        false
                    }
                };
                if removed {
                    let _ = ws_out_tx.send(WsMessage::Text(
                        serde_json::to_string(&json!({
                            "type": "reset",
                            "conn": conn_id,
                            "code": "upstream_error"
                        }))
                        .unwrap_or_default()
                        .into(),
                    ));
                }
                return;
            }
        };

        let (mut rd, mut wr) = tcp.into_split();
        let write_task = tokio::spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                match cmd {
                    MuxWriteCmd::Data(bytes) => {
                        if wr.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    MuxWriteCmd::End => {
                        let _ = wr.shutdown().await;
                        break;
                    }
                    MuxWriteCmd::Reset => {
                        break;
                    }
                }
            }
        });

        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) => {
                    let still_active = active_conns
                        .lock()
                        .get(&conn_id)
                        .is_some_and(|e| e.token == conn_token);
                    if still_active {
                        let _ = ws_out_tx.send(WsMessage::Text(
                            serde_json::to_string(&json!({
                                "type": "end",
                                "conn": conn_id
                            }))
                            .unwrap_or_default()
                            .into(),
                        ));
                    }
                    break;
                }
                Ok(n) => {
                    let still_active = active_conns
                        .lock()
                        .get(&conn_id)
                        .is_some_and(|e| e.token == conn_token);
                    if !still_active {
                        break;
                    }
                    let frame = encode_open_tunnel_binary_frame(conn_id, &buf[..n]);
                    if ws_out_tx.send(WsMessage::Binary(frame.into())).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let removed = {
                        let mut map = active_conns.lock();
                        if map.get(&conn_id).is_some_and(|e| e.token == conn_token) {
                            map.remove(&conn_id).is_some()
                        } else {
                            false
                        }
                    };
                    if removed {
                        let _ = ws_out_tx.send(WsMessage::Text(
                            serde_json::to_string(&json!({
                                "type": "reset",
                                "conn": conn_id,
                                "code": "upstream_error"
                            }))
                            .unwrap_or_default()
                            .into(),
                        ));
                    }
                    break;
                }
            }
        }

        write_task.abort();
        let mut map = active_conns.lock();
        if map.get(&conn_id).is_some_and(|e| e.token == conn_token) {
            map.remove(&conn_id);
        }
    })
}

async fn run_single_bridge_session(
    ws_url: &str,
    options: &OpenTunnelBridgeOptions,
    session_out: &Arc<RwLock<String>>,
    routes_out: &Arc<RwLock<Vec<String>>>,
    stop_notify: &Arc<Notify>,
    stopped: &Arc<AtomicBool>,
    mut initial_attach_tx: Option<oneshot::Sender<anyhow::Result<()>>>,
) -> anyhow::Result<()> {
    let mut req = ws_url.into_client_request()?;
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static("opentunnel"),
    );

    let connect_res = tokio::time::timeout(
        options.attach_timeout,
        tokio_tungstenite::connect_async(req),
    )
    .await;

    let (ws_stream, _) = match connect_res {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            let err = anyhow::anyhow!("OpenTunnel WebSocket connection error: {e}");
            if let Some(tx) = initial_attach_tx.take() {
                let _ = tx.send(Err(anyhow::anyhow!("{err}")));
            }
            return Err(err);
        }
        Err(_) => {
            let err = anyhow::anyhow!("Timed out attaching to OpenTunnel bridge.");
            if let Some(tx) = initial_attach_tx.take() {
                let _ = tx.send(Err(anyhow::anyhow!("{err}")));
            }
            return Err(err);
        }
    };

    let (mut ws_sink, mut ws_rx) = ws_stream.split();
    let (ws_out_tx, mut ws_out_rx) = mpsc::unbounded_channel::<WsMessage>();

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = ws_out_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.close().await;
    });

    let _ = ws_out_tx.send(WsMessage::Text(
        serde_json::to_string(&json!({
            "type": "attach",
            "token": options.token,
            "transport": "ws",
            "routes": ["@", "cowork"],
            "client": {
                "version": "0.1.0",
                "max_conns": 256
            }
        }))?
        .into(),
    ));

    let active_conns: Arc<Mutex<HashMap<u32, ActiveMuxConn>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let mut next_conn_token: u64 = 1;
    let mut attached = false;
    let mut heartbeat_task: Option<JoinHandle<()>> = None;
    let attach_deadline = tokio::time::Instant::now() + options.attach_timeout;

    loop {
        let stop_fut = stop_notify.notified();
        tokio::pin!(stop_fut);
        if stopped.load(Ordering::SeqCst) {
            break;
        }

        let next_msg = if !attached {
            tokio::select! {
                _ = &mut stop_fut => break,
                _ = tokio::time::sleep_until(attach_deadline) => {
                    let err = anyhow::anyhow!("Timed out attaching to OpenTunnel bridge.");
                    if let Some(tx) = initial_attach_tx.take() {
                        let _ = tx.send(Err(anyhow::anyhow!("{err}")));
                    }
                    writer_task.abort();
                    return Err(err);
                }
                m = ws_rx.next() => m,
            }
        } else {
            tokio::select! {
                _ = &mut stop_fut => break,
                m = ws_rx.next() => m,
            }
        };

        let Some(Ok(msg)) = next_msg else {
            if !attached && let Some(tx) = initial_attach_tx.take() {
                let _ = tx.send(Err(anyhow::anyhow!(
                    "OpenTunnel WebSocket closed before attach completed."
                )));
            }
            break;
        };

        match msg {
            WsMessage::Binary(bin) => {
                if let Some((conn_id, payload)) = decode_open_tunnel_binary_frame(&bin)
                    && let Some(entry) = active_conns.lock().get(&conn_id)
                {
                    let _ = entry.cmd_tx.send(MuxWriteCmd::Data(payload.to_vec()));
                }
            }
            WsMessage::Text(txt) => {
                let Ok(ctrl) = serde_json::from_str::<Value>(txt.as_str()) else {
                    continue;
                };
                match ctrl.get("type").and_then(Value::as_str) {
                    Some("attached") => {
                        let sess = ctrl
                            .get("session")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        let routes: Vec<String> = ctrl
                            .get("routes")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_default();
                        let hb_ms = ctrl
                            .get("heartbeat_ms")
                            .and_then(Value::as_u64)
                            .unwrap_or(DEFAULT_HEARTBEAT_MS)
                            .max(1_000);

                        *session_out.write() = sess;
                        *routes_out.write() = routes;
                        attached = true;

                        if let Some(old_hb) = heartbeat_task.take() {
                            old_hb.abort();
                        }
                        let hb_tx = ws_out_tx.clone();
                        heartbeat_task = Some(tokio::spawn(async move {
                            let mut ticker = tokio::time::interval(Duration::from_millis(hb_ms));
                            ticker.tick().await;
                            loop {
                                ticker.tick().await;
                                let ping = serde_json::to_string(&json!({
                                    "type": "ping",
                                    "time_sent": Utc::now().timestamp_millis(),
                                }))
                                .unwrap_or_default();
                                if hb_tx.send(WsMessage::Text(ping.into())).is_err() {
                                    break;
                                }
                            }
                        }));

                        if let Some(tx) = initial_attach_tx.take() {
                            let _ = tx.send(Ok(()));
                        }
                    }
                    Some("attach_error") => {
                        let detail = ctrl
                            .get("code")
                            .and_then(Value::as_str)
                            .or_else(|| ctrl.get("message").and_then(Value::as_str))
                            .unwrap_or("rejected");
                        let err = anyhow::anyhow!("OpenTunnel attach failed: {detail}.");
                        if let Some(tx) = initial_attach_tx.take() {
                            let _ = tx.send(Err(anyhow::anyhow!("{err}")));
                        }
                        break;
                    }
                    Some("open") => {
                        let Some(conn_u64) = ctrl.get("conn").and_then(Value::as_u64) else {
                            continue;
                        };
                        let Ok(conn_id) = u32::try_from(conn_u64) else {
                            continue;
                        };
                        let token = next_conn_token;
                        next_conn_token += 1;
                        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
                        if let Some(prev) = active_conns.lock().remove(&conn_id) {
                            let _ = prev.cmd_tx.send(MuxWriteCmd::Reset);
                            prev.task.abort();
                        }
                        let task = spawn_local_tcp_mux_conn(
                            conn_id,
                            token,
                            options.local_host.clone(),
                            options.local_port,
                            ws_out_tx.clone(),
                            Arc::clone(&active_conns),
                            cmd_rx,
                        );
                        active_conns.lock().insert(
                            conn_id,
                            ActiveMuxConn {
                                token,
                                cmd_tx,
                                task,
                            },
                        );
                    }
                    Some("end") => {
                        if let Some(conn_u64) = ctrl.get("conn").and_then(Value::as_u64)
                            && let Ok(conn_id) = u32::try_from(conn_u64)
                            && let Some(entry) = active_conns.lock().get(&conn_id)
                        {
                            let _ = entry.cmd_tx.send(MuxWriteCmd::End);
                        }
                    }
                    Some("reset") => {
                        if let Some(conn_u64) = ctrl.get("conn").and_then(Value::as_u64)
                            && let Ok(conn_id) = u32::try_from(conn_u64)
                            && let Some(prev) = active_conns.lock().remove(&conn_id)
                        {
                            let _ = prev.cmd_tx.send(MuxWriteCmd::Reset);
                            prev.task.abort();
                        }
                    }
                    Some("ping") => {
                        let ts = ctrl.get("time_sent").and_then(Value::as_i64).unwrap_or(0);
                        let _ = ws_out_tx.send(WsMessage::Text(
                            serde_json::to_string(&json!({
                                "type": "pong",
                                "time_sent": ts,
                            }))
                            .unwrap_or_default()
                            .into(),
                        ));
                    }
                    _ => {}
                }
            }
            WsMessage::Close(_) => {
                if !attached && let Some(tx) = initial_attach_tx.take() {
                    let _ = tx.send(Err(anyhow::anyhow!(
                        "OpenTunnel WebSocket closed before attach completed."
                    )));
                }
                break;
            }
            _ => {}
        }
    }

    if let Some(hb) = heartbeat_task.take() {
        hb.abort();
    }
    let drained: Vec<ActiveMuxConn> = active_conns.lock().drain().map(|(_, v)| v).collect();
    for entry in drained {
        let _ = entry.cmd_tx.send(MuxWriteCmd::Reset);
        entry.task.abort();
    }
    drop(ws_out_tx);
    let _ = tokio::time::timeout(Duration::from_millis(500), writer_task).await;
    Ok(())
}

pub async fn connect_open_tunnel_bridge(
    options: OpenTunnelBridgeOptions,
) -> anyhow::Result<OpenTunnelBridgeHandle> {
    ensure_default_crypto_provider();
    let api_url = normalize_api_url(Some(&options.api_url));
    let ws_url = format!(
        "{}/api/tunnel/{}/connect",
        to_websocket_base_url(&api_url),
        encode_path_segment(&options.tunnel_id)
    );

    let session = Arc::new(RwLock::new(String::new()));
    let routes = Arc::new(RwLock::new(Vec::<String>::new()));
    let stopped = Arc::new(AtomicBool::new(false));
    let stop_notify = Arc::new(Notify::new());
    let (attach_tx, attach_rx) = oneshot::channel::<anyhow::Result<()>>();

    let sess_clone = Arc::clone(&session);
    let routes_clone = Arc::clone(&routes);
    let stopped_clone = Arc::clone(&stopped);
    let stop_notify_clone = Arc::clone(&stop_notify);
    let opts_clone = options.clone();

    let supervisor_task = tokio::spawn(async move {
        let mut first_attach = Some(attach_tx);
        let mut attempt: u32 = 0;

        loop {
            let res = run_single_bridge_session(
                &ws_url,
                &opts_clone,
                &sess_clone,
                &routes_clone,
                &stop_notify_clone,
                &stopped_clone,
                first_attach.take(),
            )
            .await;

            if stopped_clone.load(Ordering::SeqCst) {
                break;
            }
            // If the very first attach failed, exit the supervisor loop immediately.
            if attempt == 0 && res.is_err() && sess_clone.read().is_empty() {
                break;
            }
            attempt = attempt.saturating_add(1);
            let mult = 1u64 << attempt.saturating_sub(1).min(10);
            let delay = opts_clone
                .reconnect_base_delay
                .saturating_mul(mult as u32)
                .min(opts_clone.reconnect_max_delay);

            let stop_fut = stop_notify_clone.notified();
            tokio::pin!(stop_fut);
            if stopped_clone.load(Ordering::SeqCst) {
                break;
            }
            tokio::select! {
                _ = &mut stop_fut => break,
                _ = tokio::time::sleep(delay) => {}
            }
        }
    });

    match attach_rx.await {
        Ok(Ok(())) => Ok(OpenTunnelBridgeHandle {
            session,
            routes,
            stopped,
            stop_notify,
            supervisor_task,
        }),
        Ok(Err(err)) => {
            stopped.store(true, Ordering::SeqCst);
            stop_notify.notify_waiters();
            supervisor_task.abort();
            Err(err)
        }
        Err(_) => {
            stopped.store(true, Ordering::SeqCst);
            stop_notify.notify_waiters();
            supervisor_task.abort();
            anyhow::bail!("OpenTunnel bridge attach task exited unexpectedly.")
        }
    }
}
