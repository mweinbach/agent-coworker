use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, Request, Response, StatusCode, header};
use axum::routing::any;
use cowork_protocol::{JsonRpcLiteError, JsonRpcLiteResponse, error_codes};
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as AutoConnBuilder;
use hyper_util::service::TowerToHyperService;
use parking_lot::{Mutex, RwLock};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;
use uuid::Uuid;

use crate::mobile_h3::cert::{
    load_or_create_persisted_quic_certificate, persist_h3_listener_port, resolve_persisted_h3_port,
};
use crate::mobile_h3::connection::{DEFAULT_SSE_KEEPALIVE_INTERVAL, H3DeviceConnections};
use crate::mobile_h3::opentunnel::{
    DEFAULT_ATTACH_TIMEOUT, DEFAULT_CERT_POLL_INTERVAL, DEFAULT_CERT_POLL_TIMEOUT,
    OpenTunnelBridgeHandle, OpenTunnelBridgeOptions, OpenTunnelProvisionOptions,
    OpenTunnelServerConfig, connect_open_tunnel_bridge, ensure_default_crypto_provider,
    load_or_provision_open_tunnel_identity, normalize_api_url,
};
use crate::mobile_h3::pairing_store::{
    ExpectedDeviceId, find_h3_trusted_device_by_session_token, forget_h3_trusted_device,
    forget_h3_trusted_devices, list_h3_trusted_devices, load_h3_pairing_store_state,
    remember_h3_trusted_device, update_h3_trusted_device_permissions, verify_h3_session_token,
};
use crate::mobile_h3::permissions::{
    apply_trusted_device_permissions, get_h3_request_denial, get_required_h3_permissions,
    parse_http_jsonrpc_payload, workspace_targets_allowed,
};
use crate::mobile_h3::ticket::{
    CoworkPairingTicket, CoworkTicketScheme, H3PairingSession, create_h3_pairing_session,
    decode_cowork_pairing_ticket, encode_cowork_pairing_ticket, verify_h3_pairing_nonce,
};
use crate::registry::ServerRuntimeState;
use crate::startup::{MobileH3ListeningInfo, MobileTrustedDevice, ShutdownCoordinator};

const MOBILE_DEVICE_ID_HEADER: &str = "x-cowork-mobile-device-id";
const MAX_MOBILE_HTTP_BODY_BYTES: usize = 16 * 1024 * 1024;
const PAIRING_SESSION_LIFETIME_MS: i64 = 10 * 60 * 1000;

#[derive(Clone)]
pub struct StartMobileH3ServerOptions {
    pub runtime: Arc<ServerRuntimeState>,
    pub hostname: String,
    pub port: Option<u16>,
    pub host_hints: Vec<String>,
    pub store_root_path: PathBuf,
    pub enable_h3: bool,
    pub rotate_tls: bool,
    pub sse_keepalive_interval: Option<Duration>,
    pub open_tunnel: Option<OpenTunnelServerConfig>,
}

#[derive(Clone)]
struct MobileH3RouteState {
    runtime: Arc<ServerRuntimeState>,
    store_root_path: PathBuf,
    admin_token: String,
    pairing_session: H3PairingSession,
    pairing_consumed: Arc<AtomicBool>,
    expected_ticket: Arc<RwLock<CoworkPairingTicket>>,
    open_tunnel_active: Arc<AtomicBool>,
    info: Arc<RwLock<MobileH3ListeningInfo>>,
    device_connections: Arc<H3DeviceConnections>,
}

pub struct MobileH3Server {
    pub info: Arc<RwLock<MobileH3ListeningInfo>>,
    local_port: u16,
    store_root_path: PathBuf,
    device_connections: Arc<H3DeviceConnections>,
    open_tunnel_bridge: Mutex<Option<OpenTunnelBridgeHandle>>,
    shutdown: ShutdownCoordinator,
    accept_task: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for MobileH3Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MobileH3Server")
            .field("local_port", &self.local_port)
            .field("info", &*self.info.read())
            .finish()
    }
}

impl MobileH3Server {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub async fn list_trusted_devices(&self) -> Vec<MobileTrustedDevice> {
        let summaries: Vec<MobileTrustedDevice> = list_h3_trusted_devices(&self.store_root_path)
            .await
            .into_iter()
            .map(|d| d.to_summary())
            .collect();
        {
            let mut info = self.info.write();
            info.trusted_devices = summaries.clone();
            if let Some(ref cur) = info.trusted_device {
                info.trusted_device = summaries
                    .iter()
                    .find(|d| d.device_id == cur.device_id)
                    .cloned()
                    .or_else(|| summaries.first().cloned());
            } else {
                info.trusted_device = summaries.first().cloned();
            }
        }
        summaries
    }

    pub async fn update_trusted_device_permissions(
        &self,
        device_id: &str,
        patch: &Map<String, Value>,
    ) -> anyhow::Result<Option<MobileTrustedDevice>> {
        let updated =
            update_h3_trusted_device_permissions(&self.store_root_path, device_id, patch).await?;
        let Some(record) = updated else {
            return Ok(None);
        };
        let revokes_stream = patch.get("conversations").and_then(Value::as_bool) == Some(false)
            || patch.get("workspaceSettings").and_then(Value::as_bool) == Some(false);
        if revokes_stream {
            self.device_connections.close(&record.device_id);
        }

        let summary = record.to_summary();
        let all_summaries: Vec<MobileTrustedDevice> =
            list_h3_trusted_devices(&self.store_root_path)
                .await
                .into_iter()
                .map(|d| d.to_summary())
                .collect();
        {
            let mut info = self.info.write();
            if info
                .trusted_device
                .as_ref()
                .is_some_and(|d| d.device_id == summary.device_id)
            {
                info.trusted_device = Some(summary.clone());
            }
            info.trusted_devices = all_summaries;
        }
        Ok(Some(summary))
    }

    pub async fn revoke_trusted_device(&self, device_id: &str) -> anyhow::Result<bool> {
        let trimmed = device_id.trim();
        self.device_connections.close(trimmed);
        let removed = forget_h3_trusted_device(&self.store_root_path, trimmed).await?;
        // A request that authenticated against the store before `forget` landed may have
        // recreated the connection meanwhile; close it again now that the record is gone (such
        // requests also re-check the store after registering, see `confirm_still_trusted`).
        self.device_connections.close(trimmed);
        let all_summaries: Vec<MobileTrustedDevice> =
            list_h3_trusted_devices(&self.store_root_path)
                .await
                .into_iter()
                .map(|d| d.to_summary())
                .collect();
        {
            let mut info = self.info.write();
            if info
                .trusted_device
                .as_ref()
                .is_some_and(|d| d.device_id == trimmed)
            {
                info.trusted_device = all_summaries.first().cloned();
            }
            info.trusted_devices = all_summaries;
        }
        Ok(removed)
    }

    pub async fn revoke_trusted_devices(&self) -> anyhow::Result<()> {
        self.device_connections.close_all();
        forget_h3_trusted_devices(&self.store_root_path).await?;
        self.device_connections.close_all();
        let mut info = self.info.write();
        info.trusted_device = None;
        info.trusted_devices.clear();
        Ok(())
    }

    pub async fn stop(&self) {
        self.shutdown.trigger();
        self.device_connections.close_all();
        let bridge = self.open_tunnel_bridge.lock().take();
        if let Some(b) = bridge {
            b.stop().await;
        }
        let task = self.accept_task.lock().take();
        if let Some(t) = task {
            let _ = tokio::time::timeout(Duration::from_secs(3), t).await;
        }
    }
}

fn format_url_host(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        return trimmed.to_owned();
    }
    if trimmed.contains(':') {
        format!("[{trimmed}]")
    } else {
        trimmed.to_owned()
    }
}

/// The address the OpenTunnel bridge dials to reach this listener: the bound address, with an
/// unspecified bind (`0.0.0.0` / `::`) mapped to the loopback address of the same family. The
/// result is a bare IP literal, as `TcpStream::connect((host, port))` expects (no brackets).
fn bridge_local_host(bound: std::net::IpAddr) -> String {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    match bound {
        IpAddr::V4(v4) if v4.is_unspecified() => Ipv4Addr::LOCALHOST.to_string(),
        IpAddr::V6(v6) if v6.is_unspecified() => Ipv6Addr::LOCALHOST.to_string(),
        other => other.to_string(),
    }
}

/// Re-reads the pairing store after a request registered a device connection or event stream. A
/// revoke that completed while the request was authenticating closes the device's connections
/// before the request recreated them, so a device that is no longer trusted (under this session
/// token) has its connection closed again and the request is refused.
async fn confirm_still_trusted(
    st: &MobileH3RouteState,
    session_token: Option<&str>,
    device_id_header: Option<&str>,
    device_id: &str,
) -> bool {
    let still_trusted = find_h3_trusted_device_by_session_token(
        &st.store_root_path,
        session_token,
        ExpectedDeviceId::Header(device_id_header),
    )
    .await
    .is_some_and(|record| record.device_id == device_id);
    if !still_trusted {
        st.device_connections.close(device_id);
    }
    still_trusted
}

fn format_bind_addr(host: &str, port: u16) -> String {
    format!("{}:{port}", format_url_host(host))
}

fn parse_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    if raw.len() < 7 || !raw[..7].eq_ignore_ascii_case("bearer ") {
        return None;
    }
    let tok = raw[7..].trim();
    (!tok.is_empty()).then_some(tok)
}

fn plain_text(status: StatusCode, body: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body.to_owned()))
        .unwrap()
}

fn json_response(status: StatusCode, val: &Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(val).unwrap_or_default()))
        .unwrap()
}

fn build_tls_acceptor(cert_pem: &str, key_pem: &str) -> anyhow::Result<TlsAcceptor> {
    ensure_default_crypto_provider();
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("Invalid TLS certificate chain PEM: {e}"))?;
    if certs.is_empty() {
        anyhow::bail!("TLS certificate PEM contained no certificates.");
    }
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
        .map_err(|e| anyhow::anyhow!("Invalid TLS private key PEM: {e}"))?;

    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(cfg)))
}

fn should_enable_open_tunnel(opts: &StartMobileH3ServerOptions, hostname: &str) -> bool {
    if let Some(ref ot) = opts.open_tunnel
        && let Some(explicit) = ot.enabled
    {
        return explicit;
    }
    let env = &opts.runtime.env;
    if env.get("COWORK_OPENTUNNEL_DISABLE").map(String::as_str) == Some("1") {
        return false;
    }
    if env.get("COWORK_OPENTUNNEL_ENABLE").map(String::as_str) == Some("1")
        || opts
            .open_tunnel
            .as_ref()
            .and_then(|o| o.api_url.as_deref())
            .is_some_and(|s| !s.trim().is_empty())
        || env
            .get("COWORK_OPENTUNNEL_URL")
            .is_some_and(|s| !s.trim().is_empty())
    {
        return true;
    }
    if env.get("COWORK_RUNTIME_ALLOW_NETWORK").map(String::as_str) == Some("0") {
        return false;
    }
    if !opts.enable_h3 {
        return false;
    }
    let normalized = hostname.trim().to_ascii_lowercase();
    !matches!(normalized.as_str(), "127.0.0.1" | "localhost" | "::1")
}

async fn handle_mobile_request(
    State(st): State<MobileH3RouteState>,
    req: Request<Body>,
) -> Response<Body> {
    let method = req.method().clone();
    let pathname = req.uri().path().to_owned();
    let headers = req.headers().clone();

    if method == Method::GET && pathname == "/health" {
        return json_response(
            StatusCode::OK,
            &json!({
                "ok": true,
                "h3": false,
                "openTunnel": st.open_tunnel_active.load(Ordering::Acquire),
            }),
        );
    }

    if method == Method::GET && pathname == "/ticket" {
        if parse_bearer_token(&headers) != Some(st.admin_token.as_str()) {
            return json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": "Unauthorized." }),
            );
        }
        let ticket = st.expected_ticket.read().clone();
        return json_response(StatusCode::OK, &json!({ "ticket": ticket }));
    }

    if method == Method::POST && pathname == "/pair" {
        let Ok(body_bytes) = to_bytes(req.into_body(), MAX_MOBILE_HTTP_BODY_BYTES).await else {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "Invalid pairing request." }),
            );
        };
        let Ok(raw_body) = serde_json::from_slice::<Value>(&body_bytes) else {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "Invalid pairing request." }),
            );
        };
        let Some(obj) = raw_body.as_object() else {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "Invalid pairing request." }),
            );
        };
        let raw_ticket = obj.get("ticket").and_then(Value::as_str).unwrap_or("");
        let nonce = obj.get("nonce").and_then(Value::as_str).unwrap_or("");
        let device_id = obj
            .get("deviceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let identity_pub = obj
            .get("identityPub")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let display_name = obj
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim);

        if raw_ticket.is_empty()
            || nonce.is_empty()
            || device_id.is_empty()
            || identity_pub.is_empty()
        {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "Invalid pairing request." }),
            );
        }

        let Ok(decoded) = decode_cowork_pairing_ticket(raw_ticket) else {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "Invalid pairing request." }),
            );
        };

        if st.pairing_consumed.load(Ordering::Acquire)
            || decoded.nonce != nonce
            || !verify_h3_pairing_nonce(&st.pairing_session, nonce)
        {
            return json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": "Pairing session expired." }),
            );
        }

        let expected = st.expected_ticket.read().clone();
        if decoded != expected {
            return json_response(
                StatusCode::BAD_REQUEST,
                &json!({ "error": "Invalid pairing request." }),
            );
        }

        if st.pairing_consumed.swap(true, Ordering::AcqRel) {
            return json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": "Pairing session expired." }),
            );
        }

        let session_token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4().simple());
        let Ok(trusted_record) = remember_h3_trusted_device(
            &st.store_root_path,
            device_id,
            identity_pub,
            display_name,
            &session_token,
        )
        .await
        else {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &json!({ "error": "Failed to persist trusted device." }),
            );
        };

        st.device_connections.close(device_id);
        let summary = trusted_record.to_summary();
        let all_summaries: Vec<MobileTrustedDevice> = list_h3_trusted_devices(&st.store_root_path)
            .await
            .into_iter()
            .map(|d| d.to_summary())
            .collect();
        {
            let mut info = st.info.write();
            info.trusted_device = Some(summary.clone());
            info.trusted_devices = all_summaries;
        }

        return json_response(
            StatusCode::OK,
            &json!({
                "sessionToken": session_token,
                "trustedDevice": {
                    "deviceId": trusted_record.device_id,
                    "fingerprint": trusted_record.fingerprint,
                    "displayName": trusted_record.display_name,
                    "lastPairedAt": trusted_record.last_paired_at,
                    "lastConnectedAt": trusted_record.last_connected_at,
                    "permissions": trusted_record.permissions,
                }
            }),
        );
    }

    if pathname == "/rpc" || pathname == "/events" {
        let session_token = parse_bearer_token(&headers);
        let device_id_header = headers
            .get(MOBILE_DEVICE_ID_HEADER)
            .and_then(|v| v.to_str().ok());
        let is_events = method == Method::GET && pathname == "/events";

        let trusted_device = if is_events {
            verify_h3_session_token(
                &st.store_root_path,
                session_token,
                ExpectedDeviceId::Header(device_id_header),
            )
            .await
            .ok()
            .flatten()
        } else {
            find_h3_trusted_device_by_session_token(
                &st.store_root_path,
                session_token,
                ExpectedDeviceId::Header(device_id_header),
            )
            .await
        };

        let Some(trusted_device) = trusted_device else {
            return json_response(
                StatusCode::UNAUTHORIZED,
                &json!({ "error": "Unauthorized." }),
            );
        };

        if method == Method::POST && pathname == "/rpc" {
            let Ok(body_bytes) = to_bytes(req.into_body(), MAX_MOBILE_HTTP_BODY_BYTES).await else {
                return json_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    &json!({ "error": "Payload too large." }),
                );
            };
            let raw_val = serde_json::from_slice::<Value>(&body_bytes).unwrap_or(Value::Null);
            let message = match parse_http_jsonrpc_payload(&raw_val) {
                Ok(m) => m,
                Err(err_msg) => {
                    return json_response(StatusCode::BAD_REQUEST, &json!({ "error": err_msg }));
                }
            };

            let (conn, created) = st
                .device_connections
                .get_or_create_tracked(&trusted_device.device_id);
            if created
                && !confirm_still_trusted(
                    &st,
                    session_token,
                    device_id_header,
                    &trusted_device.device_id,
                )
                .await
            {
                return json_response(
                    StatusCode::UNAUTHORIZED,
                    &json!({ "error": "Unauthorized." }),
                );
            }
            apply_trusted_device_permissions(&st.runtime, &conn.conn_state, &trusted_device);

            let required = get_required_h3_permissions(&message);
            if let Some(missing) = required
                .into_iter()
                .find(|perm| !perm.is_granted_on(&trusted_device.permissions))
            {
                let key_str = missing.as_str();
                return json_response(
                    StatusCode::FORBIDDEN,
                    &json!({
                        "error": format!("Mobile device permission required: {key_str}."),
                        "permission": key_str,
                    }),
                );
            }

            // Param-level refusals no grant can lift. A request gets an ordinary JSON-RPC error so
            // the client surfaces it inline (a 403 reads as a missing device permission, which
            // granting would not fix); a notification has no id to answer, so it gets the 403.
            if let Some(denial) = get_h3_request_denial(&message, |cwd, paths| {
                workspace_targets_allowed(&st.runtime, cwd, paths)
            }) {
                let error = JsonRpcLiteError::with_data(
                    error_codes::INVALID_REQUEST,
                    denial.message(),
                    json!({ "reason": denial.reason() }),
                );
                if let cowork_protocol::JsonRpcLiteClientMessage::Request(req) = &message {
                    return json_response(
                        StatusCode::OK,
                        &json!(JsonRpcLiteResponse::error(Some(req.id.clone()), error)),
                    );
                }
                return json_response(
                    StatusCode::FORBIDDEN,
                    &json!({ "error": denial.message(), "reason": denial.reason() }),
                );
            }

            let is_request = matches!(
                message,
                cowork_protocol::JsonRpcLiteClientMessage::Request(_)
            );
            match conn.dispatch(message).await {
                Ok(maybe_val) => {
                    if !is_request {
                        return Response::builder()
                            .status(StatusCode::ACCEPTED)
                            .body(Body::empty())
                            .unwrap();
                    }
                    return json_response(StatusCode::OK, &maybe_val.unwrap_or_else(|| json!({})));
                }
                Err(err_msg) => {
                    return json_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        &json!({ "error": err_msg }),
                    );
                }
            }
        }

        if is_events {
            let conn = st
                .device_connections
                .get_or_create(&trusted_device.device_id);
            apply_trusted_device_permissions(&st.runtime, &conn.conn_state, &trusted_device);
            let sse_stream = st
                .device_connections
                .open_sse_stream(&trusted_device.device_id);
            if !confirm_still_trusted(
                &st,
                session_token,
                device_id_header,
                &trusted_device.device_id,
            )
            .await
            {
                drop(sse_stream);
                return json_response(
                    StatusCode::UNAUTHORIZED,
                    &json!({ "error": "Unauthorized." }),
                );
            }
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header(header::CACHE_CONTROL, "no-cache")
                .header(header::CONNECTION, "keep-alive")
                .body(Body::from_stream(sse_stream))
                .unwrap();
        }
    }

    plain_text(StatusCode::NOT_FOUND, "Not found")
}

pub async fn start_mobile_h3_server(
    options: StartMobileH3ServerOptions,
) -> anyhow::Result<Arc<MobileH3Server>> {
    let hostname = if options.hostname.trim().is_empty() {
        "0.0.0.0".to_owned()
    } else {
        options.hostname.trim().to_owned()
    };
    let open_tunnel_cfg = options.open_tunnel.clone().unwrap_or_default();
    let open_tunnel_enabled = should_enable_open_tunnel(&options, &hostname);

    let mut open_tunnel_identity = None;
    if open_tunnel_enabled {
        let api_url = open_tunnel_cfg
            .api_url
            .clone()
            .or_else(|| options.runtime.env.get("COWORK_OPENTUNNEL_URL").cloned())
            .or_else(|| options.runtime.env.get("OPENTUNNEL_API_URL").cloned());
        let normalized_api = normalize_api_url(api_url.as_deref());
        match load_or_provision_open_tunnel_identity(OpenTunnelProvisionOptions {
            store_root_path: options.store_root_path.clone(),
            api_url: normalized_api,
            tunnel_name: open_tunnel_cfg.tunnel_name.clone(),
            force_rotate: options.rotate_tls,
            poll_interval: open_tunnel_cfg
                .poll_interval
                .unwrap_or(DEFAULT_CERT_POLL_INTERVAL),
            poll_timeout: open_tunnel_cfg
                .poll_timeout
                .unwrap_or(DEFAULT_CERT_POLL_TIMEOUT),
        })
        .await
        {
            Ok(bundle) => open_tunnel_identity = Some(bundle),
            Err(err) => {
                if open_tunnel_cfg.required {
                    return Err(err);
                }
            }
        }
    }

    let certificate = match &open_tunnel_identity {
        Some(bundle) => bundle.cert.clone(),
        None => {
            load_or_create_persisted_quic_certificate(&options.store_root_path, options.rotate_tls)?
        }
    };

    let tls_acceptor = build_tls_acceptor(&certificate.cert_pem, &certificate.key_pem)?;
    let preferred_port = resolve_persisted_h3_port(&options.store_root_path, options.port);

    let listener = match TcpListener::bind(format_bind_addr(&hostname, preferred_port)).await {
        Ok(l) => l,
        Err(err) if preferred_port > 0 && err.kind() == std::io::ErrorKind::AddrInUse => {
            TcpListener::bind(format_bind_addr(&hostname, 0)).await?
        }
        Err(err) => return Err(err.into()),
    };

    let local_addr = listener.local_addr()?;
    let local_port = local_addr.port();
    persist_h3_listener_port(&options.store_root_path, local_port)?;

    let pairing_session = create_h3_pairing_session(PAIRING_SESSION_LIFETIME_MS);
    let base_host_hints = if options.host_hints.is_empty() {
        vec!["127.0.0.1".to_owned()]
    } else {
        options.host_hints.clone()
    };

    let mut advertised_host_hints = base_host_hints.clone();
    let mut advertised_port = local_port;
    let mut open_tunnel_bridge = None;

    if let Some(ref bundle) = open_tunnel_identity {
        match connect_open_tunnel_bridge(OpenTunnelBridgeOptions {
            api_url: bundle.api_url.clone(),
            tunnel_id: bundle.tunnel_id.clone(),
            token: bundle.token.clone(),
            local_host: bridge_local_host(local_addr.ip()),
            local_port,
            attach_timeout: open_tunnel_cfg
                .attach_timeout
                .unwrap_or(DEFAULT_ATTACH_TIMEOUT),
            reconnect_base_delay: Duration::from_secs(1),
            reconnect_max_delay: Duration::from_secs(30),
        })
        .await
        {
            Ok(bridge) => {
                let public_port = open_tunnel_cfg.public_port.unwrap_or(443);
                let lan_fallbacks: Vec<String> = base_host_hints
                    .iter()
                    .filter(|h| {
                        let norm = h.trim().to_ascii_lowercase();
                        !matches!(norm.as_str(), "127.0.0.1" | "localhost" | "::1")
                            && norm != bundle.hostname.to_ascii_lowercase()
                    })
                    .map(|h| format!("{}:{local_port}", format_url_host(h)))
                    .collect();
                let mut hints = Vec::with_capacity(1 + lan_fallbacks.len());
                hints.push(bundle.hostname.clone());
                hints.extend(lan_fallbacks);
                advertised_host_hints = hints;
                advertised_port = public_port;
                open_tunnel_bridge = Some(bridge);
            }
            Err(err) => {
                if open_tunnel_cfg.required {
                    return Err(err);
                }
            }
        }
    }

    let admin_token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4().simple());
    let ticket = CoworkPairingTicket {
        v: 1,
        scheme: CoworkTicketScheme::H3,
        hosts: advertised_host_hints.clone(),
        port: advertised_port,
        cert_sha256: certificate.cert_sha256.clone(),
        spki_sha256: certificate.spki_sha256.clone(),
        identity_pub: certificate.identity_pub.clone(),
        nonce: pairing_session.nonce.clone(),
        expires_at: pairing_session.expires_at,
    };
    let ticket_url = encode_cowork_pairing_ticket(&ticket)?;

    let initial_store = load_h3_pairing_store_state(&options.store_root_path).await;
    let trusted_summaries: Vec<MobileTrustedDevice> = initial_store
        .trusted_devices
        .iter()
        .map(|d| d.to_summary())
        .collect();
    let latest_summary = trusted_summaries.first().cloned();

    let primary_host = advertised_host_hints
        .first()
        .map(String::as_str)
        .unwrap_or("127.0.0.1");
    let url = format!(
        "https://{}:{advertised_port}",
        format_url_host(primary_host)
    );

    let info = Arc::new(RwLock::new(MobileH3ListeningInfo {
        url,
        port: advertised_port,
        host_hints: advertised_host_hints,
        ticket: ticket_url,
        admin_token: admin_token.clone(),
        cert_sha256: certificate.cert_sha256,
        spki_sha256: certificate.spki_sha256,
        identity_pub: certificate.identity_pub,
        nonce: pairing_session.nonce.clone(),
        expires_at: pairing_session.expires_at,
        trusted_device: latest_summary,
        trusted_devices: trusted_summaries,
    }));

    let keepalive = options
        .sse_keepalive_interval
        .unwrap_or(DEFAULT_SSE_KEEPALIVE_INTERVAL);
    let device_connections = H3DeviceConnections::new(Arc::clone(&options.runtime), keepalive);
    let open_tunnel_active = Arc::new(AtomicBool::new(open_tunnel_bridge.is_some()));

    let route_state = MobileH3RouteState {
        runtime: Arc::clone(&options.runtime),
        store_root_path: options.store_root_path.clone(),
        admin_token,
        pairing_session,
        pairing_consumed: Arc::new(AtomicBool::new(false)),
        expected_ticket: Arc::new(RwLock::new(ticket)),
        open_tunnel_active,
        info: Arc::clone(&info),
        device_connections: Arc::clone(&device_connections),
    };

    let router = Router::new()
        .route("/{*path}", any(handle_mobile_request))
        .route("/", any(handle_mobile_request))
        .with_state(route_state);

    let shutdown = ShutdownCoordinator::new();
    let accept_shutdown = shutdown.clone();
    let accept_task = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = accept_shutdown.cancelled() => break,
                res = listener.accept() => res,
            };
            let Ok((tcp_stream, _)) = accepted else {
                continue;
            };
            let acceptor = tls_acceptor.clone();
            let app = router.clone();
            let conn_shutdown = accept_shutdown.clone();
            tokio::spawn(async move {
                let Ok(Ok(tls_stream)) =
                    tokio::time::timeout(Duration::from_secs(10), acceptor.accept(tcp_stream))
                        .await
                else {
                    return;
                };
                let io = TokioIo::new(tls_stream);
                let svc = TowerToHyperService::new(app);
                let builder = AutoConnBuilder::new(TokioExecutor::new());
                let conn = builder.serve_connection(io, svc);
                tokio::pin!(conn);
                tokio::select! {
                    _ = conn_shutdown.cancelled() => {
                        conn.as_mut().graceful_shutdown();
                        let _ = tokio::time::timeout(Duration::from_secs(1), &mut conn).await;
                    }
                    _ = &mut conn => {}
                }
            });
        }
    });

    Ok(Arc::new(MobileH3Server {
        info,
        local_port,
        store_root_path: options.store_root_path,
        device_connections,
        open_tunnel_bridge: Mutex::new(open_tunnel_bridge),
        shutdown,
        accept_task: Mutex::new(Some(accept_task)),
    }))
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use super::*;

    #[test]
    fn bridge_dials_the_bound_address_or_loopback_of_the_same_family() {
        assert_eq!(
            bridge_local_host(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
            "127.0.0.1"
        );
        assert_eq!(bridge_local_host(IpAddr::V6(Ipv6Addr::UNSPECIFIED)), "::1");
        assert_eq!(
            bridge_local_host(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))),
            "192.168.1.20"
        );
        let lan_v6: Ipv6Addr = "fd00::20".parse().unwrap();
        assert_eq!(bridge_local_host(IpAddr::V6(lan_v6)), "fd00::20");
        // The host is a bare literal that `TcpStream::connect((host, port))` resolves directly.
        use std::net::ToSocketAddrs;
        for host in ["127.0.0.1", "::1", "fd00::20"] {
            assert!(
                (host, 443).to_socket_addrs().unwrap().next().is_some(),
                "{host}"
            );
        }
    }
}
