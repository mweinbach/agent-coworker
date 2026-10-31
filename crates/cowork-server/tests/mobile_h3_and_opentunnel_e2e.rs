use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message as AxumWsMessage, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, post};
use cowork_server::mobile_h3::cert::{
    certificate_from_pem, create_ephemeral_quic_certificate, fingerprint_x509_der,
    load_or_create_persisted_quic_certificate, persist_h3_listener_port, resolve_persisted_h3_port,
};
use cowork_server::mobile_h3::opentunnel::{
    OpenTunnelProvisionOptions, OpenTunnelServerConfig, create_open_tunnel_csr,
    decode_open_tunnel_binary_frame, encode_open_tunnel_binary_frame,
    load_or_provision_open_tunnel_identity,
};
use cowork_server::mobile_h3::pairing_store::{
    ExpectedDeviceId, find_h3_trusted_device_by_session_token, load_h3_pairing_store_state,
    remember_h3_trusted_device, update_h3_trusted_device_permissions, verify_h3_session_token,
};
use cowork_server::mobile_h3::permissions::{
    MobilePermissionKey, get_required_h3_permissions, parse_http_jsonrpc_payload,
};
use cowork_server::mobile_h3::server::{StartMobileH3ServerOptions, start_mobile_h3_server};
use cowork_server::mobile_h3::ticket::{
    CoworkPairingTicket, CoworkTicketScheme, decode_cowork_pairing_ticket,
    encode_cowork_pairing_ticket,
};
use cowork_server::startup::{InterfaceAddrInfo, resolve_listening_hints_from_interfaces};
use cowork_server::{ServerOptions, start_server};
use data_encoding::BASE64URL_NOPAD;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use uuid::Uuid;

struct IsolatedMobileTestEnv {
    base_dir: PathBuf,
    home_dir: PathBuf,
    workspace_dir: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedMobileTestEnv {
    fn new() -> Self {
        let id = Uuid::new_v4();
        let base_dir = PathBuf::from(format!("/private/tmp/cowork-h3-test-{id}"));
        let home_dir = base_dir.join("home");
        let userdata_dir = base_dir.join("userdata");
        let workspace_dir = base_dir.join("workspace");
        std::fs::create_dir_all(&home_dir).unwrap();
        std::fs::create_dir_all(&userdata_dir).unwrap();
        std::fs::create_dir_all(&workspace_dir).unwrap();

        let home_dir = std::fs::canonicalize(&home_dir).unwrap();
        let userdata_dir = std::fs::canonicalize(&userdata_dir).unwrap();
        let workspace_dir = std::fs::canonicalize(&workspace_dir).unwrap();

        let mut env = HashMap::new();
        env.insert("HOME".into(), home_dir.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            home_dir.to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            userdata_dir.to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            userdata_dir.to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("COWORK_OPENTUNNEL_DISABLE".into(), "1".into());
        env.insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());
        env.insert(
            "OPENCODE_GO_BASE_URL".into(),
            "http://127.0.0.1:9/v1".into(),
        );
        env.insert(
            "OPENCODE_ZEN_BASE_URL".into(),
            "http://127.0.0.1:9/v1".into(),
        );

        Self {
            base_dir,
            home_dir,
            workspace_dir,
            env,
        }
    }

    fn server_options(&self) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace_dir.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo: false,
            mobile_h3: true,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home_dir.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }

    fn store_root(&self) -> PathBuf {
        self.home_dir.join(".cowork")
    }
}

impl Drop for IsolatedMobileTestEnv {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base_dir);
    }
}

/// Custom `rustls` server cert verifier that pins `cert_sha256` AND `spki_sha256` from the `cowork-pair://` ticket,
/// mirroring `apps/mobile/src/features/relay/secureTransportClient.ts`!
#[derive(Debug)]
struct PinnedCertVerifier {
    expected_cert_sha256: String,
    expected_spki_sha256: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl PinnedCertVerifier {
    fn new(expected_cert_sha256: String, expected_spki_sha256: String) -> Self {
        Self {
            expected_cert_sha256,
            expected_spki_sha256,
            provider: Arc::new(rustls::crypto::aws_lc_rs::default_provider()),
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let fp = fingerprint_x509_der(end_entity.as_ref())
            .map_err(|e| rustls::Error::General(format!("invalid x509 cert: {e}")))?;
        if fp.cert_sha256 != self.expected_cert_sha256 {
            return Err(rustls::Error::General(format!(
                "certSha256 pin mismatch: expected {}, got {}",
                self.expected_cert_sha256, fp.cert_sha256
            )));
        }
        if fp.spki_sha256 != self.expected_spki_sha256 {
            return Err(rustls::Error::General(format!(
                "spkiSha256 pin mismatch: expected {}, got {}",
                self.expected_spki_sha256, fp.spki_sha256
            )));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn build_pinned_reqwest_client(cert_sha256: &str, spki_sha256: &str) -> reqwest::Client {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut tls_cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier::new(
            cert_sha256.to_owned(),
            spki_sha256.to_owned(),
        )))
        .with_no_client_auth();
    tls_cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    reqwest::Client::builder()
        .use_preconfigured_tls(tls_cfg)
        .no_proxy()
        .build()
        .unwrap()
}

#[test]
fn x509_quic_certificate_fingerprints_persistence_and_rotation_match_spec() {
    let iso = IsolatedMobileTestEnv::new();
    let store_root = iso.store_root();

    let now_ms = 1_777_328_400_000i64;
    let cert = create_ephemeral_quic_certificate(now_ms, 3_600_000).unwrap();
    assert!(cert.cert_pem.contains("-----BEGIN CERTIFICATE-----"));
    assert!(cert.key_pem.contains("-----BEGIN PRIVATE KEY-----"));
    assert_eq!(cert.cert_sha256.len(), 64);
    assert!(
        cert.cert_sha256
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    assert_eq!(cert.spki_sha256.len(), 43);
    assert!(!cert.identity_pub.is_empty());

    // identity_pub MUST be Base64URL-unpadded SPKI DER, so SHA256(decode(identity_pub)) == spki_sha256
    let spki_der = BASE64URL_NOPAD
        .decode(cert.identity_pub.as_bytes())
        .unwrap();
    let recomputed_spki_sha = BASE64URL_NOPAD.encode(&Sha256::digest(&spki_der));
    assert_eq!(recomputed_spki_sha, cert.spki_sha256);

    let reparsed = certificate_from_pem(&cert.cert_pem, &cert.key_pem).unwrap();
    assert_eq!(reparsed.cert_sha256, cert.cert_sha256);
    assert_eq!(reparsed.spki_sha256, cert.spki_sha256);
    assert_eq!(reparsed.identity_pub, cert.identity_pub);

    // Persisted cert reuses across calls unless force_rotate is set or cert is within 5min of expiry
    let persisted_1 = load_or_create_persisted_quic_certificate(&store_root, false).unwrap();
    let persisted_2 = load_or_create_persisted_quic_certificate(&store_root, false).unwrap();
    assert_eq!(persisted_1.cert_sha256, persisted_2.cert_sha256);
    assert_eq!(persisted_1.identity_pub, persisted_2.identity_pub);

    let rotated = load_or_create_persisted_quic_certificate(&store_root, true).unwrap();
    assert_ne!(rotated.cert_sha256, persisted_1.cert_sha256);

    // Expiring cert (< 5 min left) is automatically replaced
    let expiring = create_ephemeral_quic_certificate(
        chrono::Utc::now().timestamp_millis(),
        60_000, // 1 min < 5 min renewal buffer
    )
    .unwrap();
    let pairing_dir = store_root.join("mobile-pairing");
    std::fs::write(pairing_dir.join("tls-cert.pem"), &expiring.cert_pem).unwrap();
    std::fs::write(pairing_dir.join("tls-key.pem"), &expiring.key_pem).unwrap();
    let renewed = load_or_create_persisted_quic_certificate(&store_root, false).unwrap();
    assert_ne!(renewed.cert_sha256, expiring.cert_sha256);

    // Listener port persistence
    assert_eq!(resolve_persisted_h3_port(&store_root, None), 0);
    persist_h3_listener_port(&store_root, 54321).unwrap();
    assert_eq!(resolve_persisted_h3_port(&store_root, None), 54321);
    assert_eq!(resolve_persisted_h3_port(&store_root, Some(0)), 54321);
    assert_eq!(resolve_persisted_h3_port(&store_root, Some(55555)), 55555);
}

#[test]
fn cowork_pairing_ticket_codec_and_listening_hints_match_ts_contracts() {
    let ticket = CoworkPairingTicket {
        v: 1,
        scheme: CoworkTicketScheme::H3,
        hosts: vec!["192.168.1.40".into(), "100.88.12.9".into()],
        port: 49_555,
        cert_sha256: "a".repeat(64),
        spki_sha256: "b".repeat(43),
        identity_pub: "c".repeat(43),
        nonce: "d".repeat(32),
        expires_at: 1_777_329_000_000,
    };

    let raw = encode_cowork_pairing_ticket(&ticket).unwrap();
    assert!(raw.starts_with("cowork-pair://"));
    let encoded_payload = raw.strip_prefix("cowork-pair://").unwrap();
    // Must use lowercase RFC 4648 base32 without '=' padding
    assert!(
        encoded_payload
            .chars()
            .all(|c| matches!(c, 'a'..='z' | '2'..='7'))
    );

    let decoded = decode_cowork_pairing_ticket(&raw).unwrap();
    assert_eq!(decoded, ticket);

    // Case-insensitive + padded decode compatibility
    let upper_padded = format!(
        "  cowork-pair://{}===  ",
        encoded_payload.to_ascii_uppercase()
    );
    assert_eq!(decode_cowork_pairing_ticket(&upper_padded).unwrap(), ticket);

    // Rejects unknown fields (.strict()), non-cowork-pair schemes, empty hosts, bad pins
    assert!(decode_cowork_pairing_ticket("https://example.com/pair").is_err());
    assert!(decode_cowork_pairing_ticket("cowork-pair://!!!").is_err());

    let mut bad = ticket.clone();
    bad.cert_sha256 = "A".repeat(64); // uppercase hex rejected
    assert!(encode_cowork_pairing_ticket(&bad).is_err());

    // Host hint interface ordering: private IPv4 > public IPv4 > global IPv6 > link-local IPv4 > 127.0.0.1
    let hints = resolve_listening_hints_from_interfaces(
        "0.0.0.0",
        &[
            InterfaceAddrInfo {
                address: "169.254.10.20".into(),
                is_ipv6: false,
                internal: false,
            },
            InterfaceAddrInfo {
                address: "fe80::1".into(),
                is_ipv6: true,
                internal: false,
            },
            InterfaceAddrInfo {
                address: "2001:db8::42".into(),
                is_ipv6: true,
                internal: false,
            },
            InterfaceAddrInfo {
                address: "8.8.4.4".into(),
                is_ipv6: false,
                internal: false,
            },
            InterfaceAddrInfo {
                address: "192.168.1.50".into(),
                is_ipv6: false,
                internal: false,
            },
            InterfaceAddrInfo {
                address: "127.0.0.1".into(),
                is_ipv6: false,
                internal: true,
            },
        ],
    );
    assert_eq!(
        hints,
        vec![
            "192.168.1.50",
            "8.8.4.4",
            "2001:db8::42",
            "169.254.10.20",
            "127.0.0.1"
        ]
    );
}

#[tokio::test]
async fn pairing_store_permissions_grandfathering_and_repair_rules() {
    let iso = IsolatedMobileTestEnv::new();
    let store_root = iso.store_root();

    // 1. Newly paired devices default ALL 7 permissions to false (including conversations)
    let dev = remember_h3_trusted_device(
        &store_root,
        "phone-1",
        "id-pub-1",
        Some("Work Phone"),
        "tok-secret-1",
    )
    .await
    .unwrap();
    assert!(!dev.permissions.turns);
    assert!(!dev.permissions.server_requests);
    assert!(!dev.permissions.provider_auth);
    assert!(!dev.permissions.mcp_auth);
    assert!(!dev.permissions.workspace_settings);
    assert!(!dev.permissions.backups);
    assert!(!dev.permissions.conversations);

    // Grant turns + conversations
    let mut patch = Map::new();
    patch.insert("turns".into(), json!(true));
    patch.insert("conversations".into(), json!(true));
    let updated = update_h3_trusted_device_permissions(&store_root, "phone-1", &patch)
        .await
        .unwrap()
        .unwrap();
    assert!(updated.permissions.turns);
    assert!(updated.permissions.conversations);

    // Re-pairing with SAME identityPub preserves permissions; DIFFERENT identityPub resets to default false!
    let same_id = remember_h3_trusted_device(
        &store_root,
        "phone-1",
        "id-pub-1",
        Some("Work Phone"),
        "tok-secret-2",
    )
    .await
    .unwrap();
    assert!(same_id.permissions.turns);
    assert!(same_id.permissions.conversations);

    let changed_id = remember_h3_trusted_device(
        &store_root,
        "phone-1",
        "id-pub-rotated",
        Some("Work Phone"),
        "tok-secret-3",
    )
    .await
    .unwrap();
    assert!(!changed_id.permissions.turns);
    assert!(!changed_id.permissions.conversations);

    // Missing or mismatched device ID header is rejected; find does NOT bump lastConnectedAt while verify DOES
    assert!(
        find_h3_trusted_device_by_session_token(
            &store_root,
            Some("tok-secret-3"),
            ExpectedDeviceId::Header(None)
        )
        .await
        .is_none()
    );
    assert!(
        find_h3_trusted_device_by_session_token(
            &store_root,
            Some("tok-secret-3"),
            ExpectedDeviceId::Header(Some("   "))
        )
        .await
        .is_none()
    );
    assert!(
        find_h3_trusted_device_by_session_token(
            &store_root,
            Some("tok-secret-3"),
            ExpectedDeviceId::Header(Some("phone-2"))
        )
        .await
        .is_none()
    );

    tokio::time::sleep(Duration::from_millis(15)).await;
    let found = find_h3_trusted_device_by_session_token(
        &store_root,
        Some("tok-secret-3"),
        ExpectedDeviceId::Header(Some("phone-1")),
    )
    .await
    .unwrap();
    assert_eq!(found.last_connected_at, changed_id.last_connected_at);

    let verified = verify_h3_session_token(
        &store_root,
        Some("tok-secret-3"),
        ExpectedDeviceId::Header(Some("phone-1")),
    )
    .await
    .unwrap()
    .unwrap();
    assert_ne!(verified.last_connected_at, changed_id.last_connected_at);

    // Grandfathering legacy devices whose stored JSON permissions lacks `"conversations"`
    let devices_file = store_root.join("mobile-pairing").join("devices.json");
    std::fs::write(
        &devices_file,
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "trustedDevices": [{
                "deviceId": "legacy-phone",
                "identityPub": "legacy-pub",
                "displayName": "Legacy",
                "fingerprint": "1234567890abcdef",
                "sessionTokenHash": "hash",
                "lastPairedAt": "2026-01-01T00:00:00.000Z",
                "lastConnectedAt": null,
                "permissions": {
                    "turns": false,
                    "serverRequests": false,
                    "providerAuth": false,
                    "mcpAuth": false,
                    "workspaceSettings": false,
                    "backups": false
                }
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let loaded = load_h3_pairing_store_state(&store_root).await;
    assert_eq!(loaded.trusted_devices.len(), 1);
    assert!(loaded.trusted_devices[0].permissions.conversations);
}

#[test]
fn permission_matrix_matches_all_h3_method_categories() {
    let check_req = |method: &str| {
        let msg = parse_http_jsonrpc_payload(&json!({ "id": 1, "method": method })).unwrap();
        get_required_h3_permissions(&msg)
    };

    assert_eq!(check_req("initialize"), Vec::<MobilePermissionKey>::new());
    assert_eq!(
        check_req("workspace/list"),
        Vec::<MobilePermissionKey>::new()
    );
    assert_eq!(
        check_req("thread/unsubscribe"),
        Vec::<MobilePermissionKey>::new()
    );
    assert_eq!(
        check_req("cowork/skills/list"),
        Vec::<MobilePermissionKey>::new()
    );
    assert_eq!(
        check_req("cowork/plugins/read"),
        Vec::<MobilePermissionKey>::new()
    );

    assert_eq!(
        check_req("thread/list"),
        vec![MobilePermissionKey::Conversations]
    );
    assert_eq!(
        check_req("thread/resume"),
        vec![MobilePermissionKey::Conversations]
    );
    assert_eq!(check_req("thread/start"), vec![MobilePermissionKey::Turns]);
    assert_eq!(check_req("turn/start"), vec![MobilePermissionKey::Turns]);
    assert_eq!(
        check_req("thread/fork"),
        vec![
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns
        ]
    );
    assert_eq!(
        check_req("command/execute"),
        vec![
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns
        ]
    );
    assert_eq!(
        check_req("task/list"),
        vec![MobilePermissionKey::Conversations]
    );
    assert_eq!(
        check_req("task/create"),
        vec![
            MobilePermissionKey::Conversations,
            MobilePermissionKey::Turns
        ]
    );
    assert_eq!(
        check_req("cowork/workspace/bootstrap"),
        vec![
            MobilePermissionKey::WorkspaceSettings,
            MobilePermissionKey::Conversations
        ]
    );
    assert_eq!(
        check_req("cowork/provider/auth/authorize"),
        vec![MobilePermissionKey::ProviderAuth]
    );
    assert_eq!(
        check_req("cowork/mcp/server/auth/start"),
        vec![MobilePermissionKey::McpAuth]
    );
    assert_eq!(
        check_req("cowork/mcp/server/auth/setApiKey"),
        vec![
            MobilePermissionKey::McpAuth,
            MobilePermissionKey::WorkspaceSettings
        ]
    );
    assert_eq!(
        check_req("cowork/mcp/server/validate"),
        vec![MobilePermissionKey::WorkspaceSettings]
    );
    assert_eq!(
        check_req("cowork/memory/list"),
        vec![MobilePermissionKey::WorkspaceSettings]
    );
    assert_eq!(
        check_req("cowork/plugins/install/preview"),
        vec![MobilePermissionKey::WorkspaceSettings]
    );
    assert_eq!(
        check_req("cowork/skills/install/preview"),
        vec![MobilePermissionKey::WorkspaceSettings]
    );
    assert_eq!(
        check_req("cowork/workspace/spreadsheet/read"),
        vec![MobilePermissionKey::WorkspaceSettings]
    );
    assert_eq!(
        check_req("cowork/backups/workspace/list"),
        vec![MobilePermissionKey::Backups]
    );

    let client_resp =
        parse_http_jsonrpc_payload(&json!({ "id": "srv-1", "result": { "decision": "accept" } }))
            .unwrap();
    assert_eq!(
        get_required_h3_permissions(&client_resp),
        vec![MobilePermissionKey::ServerRequests]
    );
}

#[tokio::test]
async fn full_mobile_tls_pairing_permissions_sse_events_admin_routes_and_port_fallback() {
    let iso = IsolatedMobileTestEnv::new();

    // Occupy a loopback TCP port first to verify occupied-port fallback!
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();

    let mut opts = iso.server_options();
    opts.mobile_h3_port = occupied_port;

    let server = start_server(opts).await.unwrap();
    let listening = server.listening_event();
    let h3 = listening.mobile_h3.expect("mobileH3 listening info");
    assert_ne!(h3.port, occupied_port);
    drop(occupied);

    // 1. Decode `cowork-pair://` ticket and verify pins match listening metadata
    let decoded_ticket = decode_cowork_pairing_ticket(&h3.ticket).unwrap();
    assert_eq!(decoded_ticket.v, 1);
    assert_eq!(decoded_ticket.scheme, CoworkTicketScheme::H3);
    assert_eq!(decoded_ticket.port, h3.port);
    assert_eq!(decoded_ticket.cert_sha256, h3.cert_sha256);
    assert_eq!(decoded_ticket.spki_sha256, h3.spki_sha256);
    assert_eq!(decoded_ticket.identity_pub, h3.identity_pub);
    assert_eq!(decoded_ticket.nonce, h3.nonce);

    // Build TLS client strictly pinned to the ticket's certSha256 + spkiSha256
    let tls_client =
        build_pinned_reqwest_client(&decoded_ticket.cert_sha256, &decoded_ticket.spki_sha256);
    let h3_base = &h3.url;
    let admin_base = format!("http://127.0.0.1:{}", server.port());
    let plain_http = reqwest::Client::new();

    // Verify a client with wrong SPKI pin fails the TLS handshake!
    let wrong_pin_client =
        build_pinned_reqwest_client(&decoded_ticket.cert_sha256, &"z".repeat(43));
    assert!(
        wrong_pin_client
            .get(format!("{h3_base}/health"))
            .send()
            .await
            .is_err()
    );

    // 2. GET /health & GET /ticket on Mobile TLS listener
    let health: Value = tls_client
        .get(format!("{h3_base}/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        health,
        json!({ "ok": true, "h3": false, "openTunnel": false })
    );

    let ticket_unauth = tls_client
        .get(format!("{h3_base}/ticket"))
        .send()
        .await
        .unwrap();
    assert_eq!(ticket_unauth.status(), 401);

    let ticket_auth: Value = tls_client
        .get(format!("{h3_base}/ticket"))
        .bearer_auth(&h3.admin_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_value::<CoworkPairingTicket>(ticket_auth["ticket"].clone()).unwrap(),
        decoded_ticket
    );

    // 3. Tampered ticket fields are rejected with 400 WITHOUT consuming the nonce
    let mut tampered = decoded_ticket.clone();
    tampered.port = if tampered.port == 65535 {
        1
    } else {
        tampered.port + 1
    };
    let tampered_raw = encode_cowork_pairing_ticket(&tampered).unwrap();
    let tampered_res = tls_client
        .post(format!("{h3_base}/pair"))
        .json(&json!({
            "ticket": tampered_raw,
            "nonce": h3.nonce,
            "deviceId": "phone 1/alpha",
            "identityPub": "phone-pub-1",
            "displayName": "Max iPhone"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(tampered_res.status(), 400);

    // 4. Concurrent `/pair` calls: exactly one succeeds (200) and the other gets 401!
    let pair_fut_a = tls_client
        .post(format!("{h3_base}/pair"))
        .json(&json!({
            "ticket": h3.ticket,
            "nonce": h3.nonce,
            "deviceId": "phone 1/alpha",
            "identityPub": "phone-pub-1",
            "displayName": "Max iPhone"
        }))
        .send();
    let pair_fut_b = tls_client
        .post(format!("{h3_base}/pair"))
        .json(&json!({
            "ticket": h3.ticket,
            "nonce": h3.nonce,
            "deviceId": "phone 2/beta",
            "identityPub": "phone-pub-2",
            "displayName": "Other Phone"
        }))
        .send();
    let (res_a, res_b) = tokio::join!(pair_fut_a, pair_fut_b);
    let (res_a, res_b) = (res_a.unwrap(), res_b.unwrap());
    let mut statuses = vec![res_a.status().as_u16(), res_b.status().as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, vec![200, 401]);

    let winner_json: Value = if res_a.status() == 200 {
        res_a.json().await.unwrap()
    } else {
        res_b.json().await.unwrap()
    };
    let session_token = winner_json["sessionToken"].as_str().unwrap().to_owned();
    let paired_device_id = winner_json["trustedDevice"]["deviceId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        winner_json["trustedDevice"]["permissions"],
        json!({
            "turns": false,
            "serverRequests": false,
            "providerAuth": false,
            "mcpAuth": false,
            "workspaceSettings": false,
            "backups": false,
            "conversations": false
        })
    );

    // 5. POST /rpc: initialize + initialized are always-allowed; transport reports h3!
    let init_res = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "cowork-mobile", "version": "1.0.0" }
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(init_res.status(), 200);
    let init_body: Value = init_res.json().await.unwrap();
    assert!(init_body.get("jsonrpc").is_none()); // Outbound omits "jsonrpc": "2.0"!
    assert_eq!(
        init_body["result"]["transport"],
        json!({ "type": "h3", "protocolMode": "h3" })
    );

    let initialized_res = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .json(&json!({ "method": "initialized" }))
        .send()
        .await
        .unwrap();
    assert_eq!(initialized_res.status(), 202);
    assert_eq!(initialized_res.text().await.unwrap(), "");

    // 6. Unauthorized RPC methods are rejected BEFORE handler dispatch (403)
    // Notice `thread/read` has invalid params (`{}` missing `threadId`), so if it reached the JSON-RPC
    // handler it would return 200 with `-32602` Invalid params — getting HTTP 403 proves pre-dispatch rejection!
    let denied_conv = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "thread/read",
            "params": {}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(denied_conv.status(), 403);
    assert_eq!(
        denied_conv.json::<Value>().await.unwrap(),
        json!({
            "error": "Mobile device permission required: conversations.",
            "permission": "conversations"
        })
    );

    let denied_turn = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .json(&json!({
            "id": 3,
            "method": "thread/start",
            "params": {}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(denied_turn.status(), 403);
    assert_eq!(
        denied_turn.json::<Value>().await.unwrap()["permission"],
        json!("turns")
    );

    // 7. Grant `conversations` + `turns` via main HTTP server `/mobile-h3/trusted/{deviceId}/permissions`
    let encoded_id = url::form_urlencoded::byte_serialize(paired_device_id.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    let patch_res = plain_http
        .patch(format!(
            "{admin_base}/mobile-h3/trusted/{encoded_id}/permissions"
        ))
        .bearer_auth(&h3.admin_token)
        .json(&json!({
            "permissions": {
                "conversations": true,
                "turns": true
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_res.status(), 200);
    let patch_json: Value = patch_res.json().await.unwrap();
    assert_eq!(
        patch_json["trustedDevice"]["permissions"]["conversations"],
        json!(true)
    );
    assert_eq!(
        patch_json["trustedDevice"]["permissions"]["turns"],
        json!(true)
    );

    // Now `thread/start` and `thread/list` succeed over Mobile TLS `/rpc`!
    let start_thread_res: Value = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .json(&json!({
            "id": 4,
            "method": "thread/start",
            "params": { "cwd": iso.workspace_dir.to_string_lossy() }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let created_thread_id = start_thread_res["result"]["thread"]["id"]
        .as_str()
        .expect("created thread id")
        .to_owned();

    let list_res: Value = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .json(&json!({
            "id": 5,
            "method": "thread/list",
            "params": { "cwd": iso.workspace_dir.to_string_lossy() }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(list_res["result"]["threads"].is_array());

    let read_res: Value = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .json(&json!({
            "id": 6,
            "method": "thread/read",
            "params": { "threadId": created_thread_id }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(read_res["result"]["thread"]["id"], json!(created_thread_id));

    // 8. Open `GET /events` SSE stream, verify `: cowork events\n\n` banner + live JSON-RPC notification delivery,
    //    and verify replacement stream ownership safety!
    let mut sse_1 = tls_client
        .get(format!("{h3_base}/events"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .send()
        .await
        .unwrap();
    assert_eq!(sse_1.status(), 200);
    let first_chunk = tokio::time::timeout(Duration::from_secs(2), sse_1.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        std::str::from_utf8(&first_chunk).unwrap(),
        ": cowork events\n\n"
    );

    // Open replacement SSE stream `sse_2`, then drop `sse_1` -> connection must stay alive on `sse_2`!
    let mut sse_2 = tls_client
        .get(format!("{h3_base}/events"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .send()
        .await
        .unwrap();
    let second_banner = tokio::time::timeout(Duration::from_secs(2), sse_2.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        std::str::from_utf8(&second_banner).unwrap(),
        ": cowork events\n\n"
    );

    drop(sse_1);
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Trigger a broadcast notification (`workspace/listChanged`) and read it from `sse_2`!
    server.runtime().broadcast_workspace_list_changed();
    let notif_chunk = tokio::time::timeout(Duration::from_secs(2), sse_2.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let notif_text = std::str::from_utf8(&notif_chunk).unwrap();
    assert!(notif_text.starts_with("data: "));
    assert!(notif_text.contains("\"workspace/listChanged\""));

    // 9. Revoking `conversations` closes active SSE stream immediately!
    let revoke_conv = plain_http
        .patch(format!(
            "{admin_base}/mobile-h3/trusted/{encoded_id}/permissions"
        ))
        .bearer_auth(&h3.admin_token)
        .json(&json!({ "permissions": { "conversations": false } }))
        .send()
        .await
        .unwrap();
    assert_eq!(revoke_conv.status(), 200);
    let eof_chunk = tokio::time::timeout(Duration::from_secs(2), sse_2.chunk())
        .await
        .unwrap()
        .unwrap();
    assert!(
        eof_chunk.is_none(),
        "expected SSE stream EOF after conversations permission revocation"
    );

    // 10. Revoking the device via DELETE `/mobile-h3/trusted/{deviceId}` invalidates its sessionToken (401)
    let del_res: Value = plain_http
        .delete(format!("{admin_base}/mobile-h3/trusted/{encoded_id}"))
        .bearer_auth(&h3.admin_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(del_res, json!({ "ok": true, "removed": true }));

    let after_revoke = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(&session_token)
        .header("x-cowork-mobile-device-id", &paired_device_id)
        .json(&json!({ "id": 9, "method": "workspace/list" }))
        .send()
        .await
        .unwrap();
    assert_eq!(after_revoke.status(), 401);

    server.shutdown().await;
}

/// Signs a PEM PKCS#10 CSR with a test CA using `rcgen` for deterministic offline OpenTunnel tests.
fn sign_csr_for_test(csr_pem: &str) -> (String, String, i64) {
    let ca_key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "OpenTunnel Test CA");
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(1));
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);

    let csr = rcgen::CertificateSigningRequestParams::from_pem(csr_pem).unwrap();
    let leaf_cert = csr.signed_by(&issuer).unwrap();
    let expiry_ms = chrono::Utc::now().timestamp_millis() + 24 * 60 * 60 * 1000;
    (leaf_cert.pem(), ca_cert.pem(), expiry_ms)
}

#[derive(Clone)]
struct MockOpenTunnelState {
    calls: Arc<Mutex<Vec<String>>>,
    tunnel_counter: Arc<Mutex<u32>>,
    poll_counter: Arc<Mutex<u32>>,
    latest_signed: Arc<Mutex<Option<(String, String, i64)>>>,
    ws_outbound_tx: Arc<Mutex<Option<mpsc::UnboundedSender<AxumWsMessage>>>>,
    conn_frames: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>>>,
    ping_seen: Arc<tokio::sync::Notify>,
}

async fn start_mock_opentunnel_server()
-> (SocketAddr, MockOpenTunnelState, tokio::task::JoinHandle<()>) {
    let state = MockOpenTunnelState {
        calls: Arc::new(Mutex::new(Vec::new())),
        tunnel_counter: Arc::new(Mutex::new(0)),
        poll_counter: Arc::new(Mutex::new(0)),
        latest_signed: Arc::new(Mutex::new(None)),
        ws_outbound_tx: Arc::new(Mutex::new(None)),
        conn_frames: Arc::new(Mutex::new(HashMap::new())),
        ping_seen: Arc::new(tokio::sync::Notify::new()),
    };

    let router = Router::new()
        .route(
            "/api/tunnel",
            post(
                |State(st): State<MockOpenTunnelState>, body: axum::Json<Value>| async move {
                    st.calls.lock().push("POST /api/tunnel".into());
                    let mut count = st.tunnel_counter.lock();
                    *count += 1;
                    let id = format!("tun_{}", *count);
                    let _name = body.0.get("name").cloned();
                    (
                        StatusCode::CREATED,
                        axum::Json(json!({
                            "tunnel": {
                                "id": id,
                                "hostname": format!("{id}.opentunnel.xyz"),
                                "state": { "type": "pending" }
                            },
                            "token": format!("tok_{}", *count)
                        })),
                    )
                },
            ),
        )
        .route(
            "/api/tunnel/{id}/certificate",
            post(
                |State(st): State<MockOpenTunnelState>,
                 axum::extract::Path(id): axum::extract::Path<String>,
                 headers: HeaderMap,
                 body: axum::Json<Value>| async move {
                    let auth = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_owned();
                    st.calls
                        .lock()
                        .push(format!("POST /api/tunnel/{id}/certificate ({auth})"));
                    let csr = body.0["csr"].as_str().unwrap();
                    let signed = sign_csr_for_test(csr);
                    *st.latest_signed.lock() = Some(signed);
                    *st.poll_counter.lock() = 0;
                    (
                        StatusCode::ACCEPTED,
                        axum::Json(json!({
                            "id": id,
                            "state": { "type": "issuing" }
                        })),
                    )
                },
            )
            .get(
                |State(st): State<MockOpenTunnelState>,
                 axum::extract::Path(id): axum::extract::Path<String>| async move {
                    st.calls
                        .lock()
                        .push(format!("GET /api/tunnel/{id}/certificate"));
                    let mut polls = st.poll_counter.lock();
                    *polls += 1;
                    if *polls < 2 {
                        return axum::Json(json!({
                            "id": id,
                            "state": { "type": "challenge" }
                        }));
                    }
                    let (cert, chain, expiry) = st.latest_signed.lock().clone().unwrap();
                    axum::Json(json!({
                        "id": id,
                        "state": {
                            "type": "ready",
                            "certificate": cert,
                            "chain": chain,
                            "expiry": expiry
                        }
                    }))
                },
            ),
        )
        .route(
            "/api/tunnel/{id}",
            delete(
                |State(st): State<MockOpenTunnelState>,
                 axum::extract::Path(id): axum::extract::Path<String>| async move {
                    st.calls.lock().push(format!("DELETE /api/tunnel/{id}"));
                    StatusCode::NO_CONTENT
                },
            ),
        )
        .route(
            "/api/tunnel/{id}/connect",
            any(
                |State(st): State<MockOpenTunnelState>,
                 headers: HeaderMap,
                 ws: WebSocketUpgrade| async move {
                    let proto = headers
                        .get(header::SEC_WEBSOCKET_PROTOCOL)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    assert!(
                        proto.split(',').any(|p| p.trim() == "opentunnel"),
                        "expected Sec-WebSocket-Protocol: opentunnel, got {proto}"
                    );
                    let mut resp: Response = ws
                        .protocols(["opentunnel"])
                        .on_upgrade(move |socket| async move {
                            let (mut sink, mut stream) = socket.split();
                            let (tx, mut rx) = mpsc::unbounded_channel::<AxumWsMessage>();
                            *st.ws_outbound_tx.lock() = Some(tx.clone());
                            let writer = tokio::spawn(async move {
                                while let Some(msg) = rx.recv().await {
                                    if sink.send(msg).await.is_err() {
                                        break;
                                    }
                                }
                            });
                            while let Some(Ok(msg)) = stream.next().await {
                                match msg {
                                    AxumWsMessage::Text(txt) => {
                                        let Ok(val) = serde_json::from_str::<Value>(txt.as_str())
                                        else {
                                            continue;
                                        };
                                        match val.get("type").and_then(Value::as_str) {
                                            Some("attach") => {
                                                let _ = tx.send(AxumWsMessage::Text(
                                                    serde_json::to_string(&json!({
                                                        "type": "attached",
                                                        "session": "sess_rust_1",
                                                        "routes": ["@", "cowork"],
                                                        "heartbeat_ms": 1_000,
                                                        "idle_timeout_ms": 45_000
                                                    }))
                                                    .unwrap()
                                                    .into(),
                                                ));
                                            }
                                            Some("ping") => {
                                                st.ping_seen.notify_waiters();
                                                let ts = val
                                                    .get("time_sent")
                                                    .and_then(Value::as_i64)
                                                    .unwrap_or(0);
                                                let _ = tx.send(AxumWsMessage::Text(
                                                    serde_json::to_string(&json!({
                                                        "type": "pong",
                                                        "time_sent": ts
                                                    }))
                                                    .unwrap()
                                                    .into(),
                                                ));
                                            }
                                            Some("end") => {
                                                if let Some(conn) =
                                                    val.get("conn").and_then(Value::as_u64)
                                                {
                                                    st.conn_frames.lock().remove(&(conn as u32));
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                    AxumWsMessage::Binary(bin) => {
                                        if let Some((conn, payload)) =
                                            decode_open_tunnel_binary_frame(&bin)
                                            && let Some(conn_tx) = st.conn_frames.lock().get(&conn)
                                        {
                                            let _ = conn_tx.send(payload.to_vec());
                                        }
                                    }
                                    AxumWsMessage::Close(_) => break,
                                    _ => {}
                                }
                            }
                            writer.abort();
                        })
                        .into_response();
                    resp.headers_mut().insert(
                        header::SEC_WEBSOCKET_PROTOCOL,
                        HeaderValue::from_static("opentunnel"),
                    );
                    resp
                },
            ),
        )
        .with_state(state.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (addr, state, task)
}

#[tokio::test]
async fn opentunnel_csr_identity_provisioning_and_multiplexed_tls_relay_end_to_end() {
    let iso = IsolatedMobileTestEnv::new();
    let store_root = iso.store_root();

    // 1. CSR + binary frame codec unit checks
    let (csr_pem, key_pem) = create_open_tunnel_csr("t-abc123.opentunnel.xyz").unwrap();
    assert!(csr_pem.contains("-----BEGIN CERTIFICATE REQUEST-----"));
    assert!(key_pem.contains("-----BEGIN PRIVATE KEY-----"));
    let encoded_frame = encode_open_tunnel_binary_frame(0x0102_0304, b"raw-tls-record");
    assert_eq!(encoded_frame.len(), 4 + "raw-tls-record".len());
    let (decoded_conn, decoded_payload) = decode_open_tunnel_binary_frame(&encoded_frame).unwrap();
    assert_eq!(decoded_conn, 0x0102_0304);
    assert_eq!(decoded_payload, b"raw-tls-record");
    assert!(decode_open_tunnel_binary_frame(&[1, 2, 3]).is_none());

    // 2. Provisioning, persistence reuse, and rotation against mock OpenTunnel HTTP + WS server
    let (relay_addr, relay_state, relay_task) = start_mock_opentunnel_server().await;
    let api_url = format!("http://{relay_addr}");

    let first = load_or_provision_open_tunnel_identity(OpenTunnelProvisionOptions {
        store_root_path: store_root.clone(),
        api_url: api_url.clone(),
        tunnel_name: Some("cowork".into()),
        force_rotate: false,
        poll_interval: Duration::from_millis(10),
        poll_timeout: Duration::from_secs(5),
    })
    .await
    .unwrap();
    assert_eq!(first.tunnel_id, "tun_1");
    assert_eq!(first.hostname, "tun_1.opentunnel.xyz");
    assert_eq!(first.cert.cert_sha256.len(), 64);

    let calls_after_first = relay_state.calls.lock().len();
    let reused = load_or_provision_open_tunnel_identity(OpenTunnelProvisionOptions {
        store_root_path: store_root.clone(),
        api_url: api_url.clone(),
        tunnel_name: Some("cowork".into()),
        force_rotate: false,
        poll_interval: Duration::from_millis(10),
        poll_timeout: Duration::from_secs(5),
    })
    .await
    .unwrap();
    assert_eq!(reused.tunnel_id, "tun_1");
    assert_eq!(reused.cert.cert_sha256, first.cert.cert_sha256);
    assert_eq!(relay_state.calls.lock().len(), calls_after_first);

    let rotated = load_or_provision_open_tunnel_identity(OpenTunnelProvisionOptions {
        store_root_path: store_root.clone(),
        api_url: api_url.clone(),
        tunnel_name: Some("cowork".into()),
        force_rotate: true,
        poll_interval: Duration::from_millis(10),
        poll_timeout: Duration::from_secs(5),
    })
    .await
    .unwrap();
    assert_eq!(rotated.tunnel_id, "tun_2");
    assert!(
        relay_state
            .calls
            .lock()
            .iter()
            .any(|c| c == "DELETE /api/tunnel/tun_1")
    );

    // 3. Start full server + Mobile H3 with OpenTunnel bridge attached to mock relay!
    let base_srv = start_server({
        let mut o = iso.server_options();
        o.mobile_h3 = false;
        o
    })
    .await
    .unwrap();

    let mobile_h3 = start_mobile_h3_server(StartMobileH3ServerOptions {
        runtime: base_srv.runtime().clone(),
        hostname: "127.0.0.1".into(),
        port: Some(0),
        host_hints: vec!["192.168.1.50".into()],
        store_root_path: store_root.clone(),
        enable_h3: true,
        rotate_tls: false,
        sse_keepalive_interval: Some(Duration::from_millis(200)),
        open_tunnel: Some(OpenTunnelServerConfig {
            enabled: Some(true),
            required: true,
            api_url: Some(api_url.clone()),
            tunnel_name: Some("cowork".into()),
            public_port: Some(443),
            poll_interval: Some(Duration::from_millis(10)),
            poll_timeout: Some(Duration::from_secs(5)),
            attach_timeout: Some(Duration::from_secs(5)),
        }),
    })
    .await
    .unwrap();

    let info = mobile_h3.info.read().clone();
    assert_eq!(info.url, "https://tun_2.opentunnel.xyz:443");
    assert_eq!(info.port, 443);
    assert_eq!(info.host_hints[0], "tun_2.opentunnel.xyz");
    assert!(info.host_hints[1].starts_with("192.168.1.50:"));

    // Stand up a local TCP proxy that feeds raw TLS client sockets over the OpenTunnel WebSocket binary bridge!
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let relay_state_for_proxy = relay_state.clone();
    let proxy_task = tokio::spawn(async move {
        let mut next_conn_id: u32 = 100;
        while let Ok((tcp_stream, _)) = proxy_listener.accept().await {
            let conn_id = next_conn_id;
            next_conn_id += 1;
            let st = relay_state_for_proxy.clone();
            tokio::spawn(async move {
                let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
                st.conn_frames.lock().insert(conn_id, tx);
                let Some(ws_tx) = st.ws_outbound_tx.lock().clone() else {
                    return;
                };
                let _ = ws_tx.send(AxumWsMessage::Text(
                    serde_json::to_string(&json!({
                        "type": "open",
                        "conn": conn_id,
                        "sni": "tun_2.opentunnel.xyz",
                        "alpn": "http/1.1"
                    }))
                    .unwrap()
                    .into(),
                ));
                let (mut rd, mut wr) = tcp_stream.into_split();
                let write_task = tokio::spawn(async move {
                    while let Some(chunk) = rx.recv().await {
                        if wr.write_all(&chunk).await.is_err() {
                            break;
                        }
                    }
                    let _ = wr.shutdown().await;
                });
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match rd.read(&mut buf).await {
                        Ok(0) => {
                            let _ = ws_tx.send(AxumWsMessage::Text(
                                serde_json::to_string(&json!({ "type": "end", "conn": conn_id }))
                                    .unwrap()
                                    .into(),
                            ));
                            break;
                        }
                        Ok(n) => {
                            let frame = encode_open_tunnel_binary_frame(conn_id, &buf[..n]);
                            let _ = ws_tx.send(AxumWsMessage::Binary(frame.into()));
                        }
                        Err(_) => {
                            let _ = ws_tx.send(AxumWsMessage::Text(
                                serde_json::to_string(&json!({ "type": "reset", "conn": conn_id }))
                                    .unwrap()
                                    .into(),
                            ));
                            break;
                        }
                    }
                }
                let _ = write_task.await;
            });
        }
    });

    // Connect a real TLS + HTTP client (pinned to OpenTunnel's CSR-issued cert & SPKI!) through the WS bridge!
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut tls_cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier::new(
            info.cert_sha256.clone(),
            info.spki_sha256.clone(),
        )))
        .with_no_client_auth();
    tls_cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    let tunnel_http = reqwest::Client::builder()
        .use_preconfigured_tls(tls_cfg)
        .resolve("tun_2.opentunnel.xyz", proxy_addr)
        .no_proxy()
        .build()
        .unwrap();

    // Verify GET /health over the OpenTunnel WS relay reports `"openTunnel": true`!
    let relay_health: Value = tunnel_http
        .get("https://tun_2.opentunnel.xyz:443/health")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        relay_health,
        json!({ "ok": true, "h3": false, "openTunnel": true })
    );

    // Pair + execute JSON-RPC initialize + workspace/list over the OpenTunnel WS relay!
    let pair_resp: Value = tunnel_http
        .post("https://tun_2.opentunnel.xyz:443/pair")
        .json(&json!({
            "ticket": info.ticket,
            "nonce": info.nonce,
            "deviceId": "tunnel-phone-1",
            "identityPub": "tunnel-phone-pub-1",
            "displayName": "Tunnel Phone"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let tunnel_session_token = pair_resp["sessionToken"].as_str().unwrap();

    let tunnel_init: Value = tunnel_http
        .post("https://tun_2.opentunnel.xyz:443/rpc")
        .bearer_auth(tunnel_session_token)
        .header("x-cowork-mobile-device-id", "tunnel-phone-1")
        .json(&json!({
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": { "name": "mobile-tunnel", "version": "1.0.0" } }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        tunnel_init["result"]["transport"],
        json!({ "type": "h3", "protocolMode": "h3" })
    );

    let _ = tunnel_http
        .post("https://tun_2.opentunnel.xyz:443/rpc")
        .bearer_auth(tunnel_session_token)
        .header("x-cowork-mobile-device-id", "tunnel-phone-1")
        .json(&json!({ "method": "initialized" }))
        .send()
        .await
        .unwrap();

    let ws_list: Value = tunnel_http
        .post("https://tun_2.opentunnel.xyz:443/rpc")
        .bearer_auth(tunnel_session_token)
        .header("x-cowork-mobile-device-id", "tunnel-phone-1")
        .json(&json!({ "id": 2, "method": "workspace/list" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(ws_list["result"]["workspaces"].is_array());

    // Open SSE stream over OpenTunnel WS relay and verify `: cowork events` + `: keepalive`!
    let mut relay_sse = tunnel_http
        .get("https://tun_2.opentunnel.xyz:443/events")
        .bearer_auth(tunnel_session_token)
        .header("x-cowork-mobile-device-id", "tunnel-phone-1")
        .send()
        .await
        .unwrap();
    let c1 = tokio::time::timeout(Duration::from_secs(2), relay_sse.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(std::str::from_utf8(&c1).unwrap(), ": cowork events\n\n");
    let c2 = tokio::time::timeout(Duration::from_secs(2), relay_sse.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(std::str::from_utf8(&c2).unwrap(), ": keepalive\n\n");
    drop(relay_sse);

    // Also verify heartbeat ping was sent over the OpenTunnel WS!
    tokio::time::timeout(Duration::from_secs(3), relay_state.ping_seen.notified())
        .await
        .expect("expected OpenTunnel bridge heartbeat ping");

    let _ = TcpStream::connect(proxy_addr).await; // ensure proxy still clean before teardown
    proxy_task.abort();
    mobile_h3.stop().await;
    base_srv.shutdown().await;
    relay_task.abort();
}

#[tokio::test]
async fn workspace_control_filtering_server_requests_malformed_envelopes_and_bulk_revoke() {
    let iso = IsolatedMobileTestEnv::new();
    let mut opts = iso.server_options();
    opts.mobile_h3 = false;
    opts.env
        .insert("COWORK_H3_MOBILE_PAIRING".into(), "1".into());

    let server = start_server(opts).await.unwrap();
    let h3 = server
        .listening_event()
        .mobile_h3
        .expect("COWORK_H3_MOBILE_PAIRING=1 should start mobile H3");
    let decoded = decode_cowork_pairing_ticket(&h3.ticket).unwrap();
    let tls_client = build_pinned_reqwest_client(&decoded.cert_sha256, &decoded.spki_sha256);
    let plain_http = reqwest::Client::new();
    let h3_base = &h3.url;
    let admin_base = format!("http://127.0.0.1:{}", server.port());

    let pair_res: Value = tls_client
        .post(format!("{h3_base}/pair"))
        .json(&json!({
            "ticket": h3.ticket,
            "nonce": h3.nonce,
            "deviceId": "phone+plus/check",
            "identityPub": "phone-pub-plus",
            "displayName": "Plus Phone"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_token = pair_res["sessionToken"].as_str().unwrap();

    // 1. Malformed envelopes return HTTP 400 before permission or handler dispatch
    for (bad_body, expected_err) in [
        (json!([1, 2, 3]), "JSON-RPC payload must be an object."),
        (json!({ "params": {} }), "JSON-RPC method is required."),
        (
            json!({ "id": true, "method": "initialize" }),
            "JSON-RPC id must be a string or number.",
        ),
        (
            json!({ "id": [], "result": {} }),
            "JSON-RPC response id must be a string or number.",
        ),
    ] {
        let r = tls_client
            .post(format!("{h3_base}/rpc"))
            .bearer_auth(session_token)
            .header("x-cowork-mobile-device-id", "phone+plus/check")
            .json(&bad_body)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400);
        assert_eq!(
            r.json::<Value>().await.unwrap()["error"],
            json!(expected_err)
        );
    }

    // Complete handshake
    let _ = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "phone+plus/check")
        .json(&json!({
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": { "name": "mobile", "version": "1.0.0" } }
        }))
        .send()
        .await
        .unwrap();
    let _ = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "phone+plus/check")
        .json(&json!({ "method": "initialized" }))
        .send()
        .await
        .unwrap();

    // 2. Open SSE stream and call an always-allowed method (`workspace/list`) while `workspaceSettings == false`
    let mut sse = tls_client
        .get(format!("{h3_base}/events"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "phone+plus/check")
        .send()
        .await
        .unwrap();
    let banner = tokio::time::timeout(Duration::from_secs(2), sse.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(std::str::from_utf8(&banner).unwrap(), ": cowork events\n\n");

    let _ = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "phone+plus/check")
        .json(&json!({ "id": 2, "method": "workspace/list" }))
        .send()
        .await
        .unwrap();

    // Trigger workspace control refresh — device MUST NOT receive `cowork/control/event` without `workspaceSettings`!
    server
        .runtime()
        .broadcast_workspace_control_refresh(&iso.workspace_dir)
        .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(120), sse.chunk())
            .await
            .is_err(),
        "cowork/control/event must not be sent when workspaceSettings permission is false"
    );

    // 3. ClientResponse without `serverRequests` permission returns 403
    let denied_srv_resp = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "phone+plus/check")
        .json(&json!({ "id": "srv-req-1", "result": { "decision": "accept" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(denied_srv_resp.status(), 403);
    assert_eq!(
        denied_srv_resp.json::<Value>().await.unwrap()["permission"],
        json!("serverRequests")
    );

    // 4. Grant `workspaceSettings` + `serverRequests` (notice literal `+` in deviceId preserved via %2B/%2F)
    let patch_res = plain_http
        .patch(format!(
            "{admin_base}/mobile-h3/trusted/phone+plus%2Fcheck/permissions"
        ))
        .bearer_auth(&h3.admin_token)
        .json(&json!({
            "permissions": {
                "workspaceSettings": true,
                "serverRequests": true
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_res.status(), 200);

    // Call `cowork/session/state/read` -> now subscribed to workspace control events!
    let state_read = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "phone+plus/check")
        .json(&json!({
            "id": 3,
            "method": "cowork/session/state/read",
            "params": { "cwd": iso.workspace_dir.to_string_lossy() }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(state_read.status(), 200);

    server
        .runtime()
        .broadcast_workspace_control_refresh(&iso.workspace_dir)
        .await;
    let ctrl_chunk = tokio::time::timeout(Duration::from_secs(2), sse.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let ctrl_str = std::str::from_utf8(&ctrl_chunk).unwrap();
    assert!(ctrl_str.contains("\"cowork/control/event\""));

    // ClientResponse now succeeds with 202 and emits `interaction_response_not_found` over SSE
    let allowed_srv_resp = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "phone+plus/check")
        .json(&json!({ "id": "srv-req-1", "result": { "decision": "accept" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(allowed_srv_resp.status(), 202);

    // Drain SSE until we see `interaction_response_not_found`
    let mut saw_err = false;
    for _ in 0..8 {
        if let Ok(Ok(Some(chunk))) = tokio::time::timeout(Duration::from_secs(1), sse.chunk()).await
            && std::str::from_utf8(&chunk)
                .unwrap_or("")
                .contains("interaction_response_not_found")
        {
            saw_err = true;
            break;
        }
    }
    assert!(
        saw_err,
        "expected interaction_response_not_found error frame on SSE"
    );

    // 5. Bulk DELETE `/mobile-h3/trusted` revokes all devices and closes SSE
    let bulk_del: Value = plain_http
        .delete(format!("{admin_base}/mobile-h3/trusted"))
        .bearer_auth(&h3.admin_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bulk_del, json!({ "ok": true }));

    let eof = tokio::time::timeout(Duration::from_secs(2), sse.chunk())
        .await
        .unwrap()
        .unwrap();
    assert!(eof.is_none());

    let listed: Value = plain_http
        .get(format!("{admin_base}/mobile-h3/trusted"))
        .bearer_auth(&h3.admin_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["trustedDevices"], json!([]));

    server.shutdown().await;
}

#[tokio::test]
async fn mobile_tls_withholds_thread_management_tools_without_conversations_permission_and_exposes_when_granted()
 {
    let recorded_tool_sets: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded_ref = Arc::clone(&recorded_tool_sets);

    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(move |body: axum::body::Bytes| {
            let recorded = Arc::clone(&recorded_ref);
            async move {
                let payload: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let names: Vec<String> = payload
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|t| {
                                t.get("function")
                                    .and_then(|f| f.get("name"))
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                if !names.is_empty() {
                    recorded.lock().push(names);
                }

                let sse_body = concat!(
                    "data: {\"id\":\"cmpl-h3\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"}}]}\n\n",
                    "data: {\"id\":\"cmpl-h3\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":10,\"total_tokens\":110}}\n\n",
                    "data: [DONE]\n\n"
                );
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(axum::body::Body::from(sse_body))
                    .unwrap()
            }
        }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let llm_task = tokio::spawn(async move {
        let _ = axum::serve(llm_listener, llm_app).await;
    });

    let mut iso = IsolatedMobileTestEnv::new();
    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{llm_port}/v1"),
    );

    let server = start_server(iso.server_options()).await.unwrap();
    let h3 = server
        .listening_event()
        .mobile_h3
        .expect("mobile h3 active");
    let admin_base = format!("http://127.0.0.1:{}", server.port());
    let h3_base = &h3.url;

    let tls_client = build_pinned_reqwest_client(&h3.cert_sha256, &h3.spki_sha256);
    let plain_http = reqwest::Client::builder().no_proxy().build().unwrap();

    // Pair mobile device
    let pair_json: Value = tls_client
        .post(format!("{h3_base}/pair"))
        .json(&json!({
            "ticket": h3.ticket,
            "nonce": h3.nonce,
            "deviceId": "mobile-turns-only",
            "identityPub": "pub-turns-only",
            "displayName": "Mobile Turns Only"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_token = pair_json["sessionToken"].as_str().unwrap();

    // Grant ONLY `turns: true` (`conversations: false`)
    let patch_turns_only = plain_http
        .patch(format!(
            "{admin_base}/mobile-h3/trusted/mobile-turns-only/permissions"
        ))
        .bearer_auth(&h3.admin_token)
        .json(&json!({
            "permissions": {
                "turns": true,
                "conversations": false
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_turns_only.status(), 200);

    // Open SSE stream so we observe `turn/completed` deterministically
    let mut sse = tls_client
        .get(format!("{h3_base}/events"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "mobile-turns-only")
        .send()
        .await
        .unwrap();
    assert_eq!(sse.status(), 200);

    // Initialize the Mobile TLS JSON-RPC session
    let init_res = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "mobile-turns-only")
        .json(&json!({
            "id": 9,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "cowork-mobile", "version": "1.0.0" }
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(init_res.status(), 200);
    let initialized_res = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "mobile-turns-only")
        .json(&json!({ "method": "initialized" }))
        .send()
        .await
        .unwrap();
    assert_eq!(initialized_res.status(), 202);

    // Start a thread via `POST /rpc`
    let th_start: Value = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "mobile-turns-only")
        .json(&json!({
            "id": 10,
            "method": "thread/start",
            "params": {
                "cwd": iso.workspace_dir.to_string_lossy(),
                "provider": "together",
                "model": "moonshotai/Kimi-K2.5"
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let thread_id = th_start["result"]["thread"]["id"]
        .as_str()
        .expect("thread id")
        .to_owned();

    // Turn 1 (`turns: true, conversations: false`): all 10 `threadManagement` tools MUST be withheld!
    let turn1_res: Value = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "mobile-turns-only")
        .json(&json!({
            "id": 11,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{ "type": "text", "text": "hello from turns-only mobile" }]
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(turn1_res.get("error").is_none(), "turn1_res={turn1_res}");

    let mut saw_t1_done = false;
    let deadline1 = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline1 {
        if let Ok(Ok(Some(chunk))) =
            tokio::time::timeout(Duration::from_millis(500), sse.chunk()).await
            && std::str::from_utf8(&chunk)
                .unwrap_or("")
                .contains("\"turn/completed\"")
        {
            saw_t1_done = true;
            break;
        }
    }
    assert!(saw_t1_done, "expected turn 1 to complete");

    const THREAD_MGMT_TOOLS: &[&str] = &[
        "list_projects",
        "list_threads",
        "read_thread",
        "create_thread",
        "send_message_to_thread",
        "fork_thread",
        "set_thread_title",
        "set_thread_pinned",
        "set_thread_archived",
        "threadManagement",
    ];

    {
        let sets = recorded_tool_sets.lock();
        assert_eq!(sets.len(), 1);
        for forbidden in THREAD_MGMT_TOOLS {
            assert!(
                !sets[0].iter().any(|n| n == forbidden),
                "Mobile TLS with conversations: false MUST NOT expose '{forbidden}', tools were: {:?}",
                sets[0]
            );
        }
    }

    // Now grant `conversations: true` alongside `turns: true`!
    let patch_with_conv = plain_http
        .patch(format!(
            "{admin_base}/mobile-h3/trusted/mobile-turns-only/permissions"
        ))
        .bearer_auth(&h3.admin_token)
        .json(&json!({
            "permissions": {
                "turns": true,
                "conversations": true
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_with_conv.status(), 200);

    let turn2_res: Value = tls_client
        .post(format!("{h3_base}/rpc"))
        .bearer_auth(session_token)
        .header("x-cowork-mobile-device-id", "mobile-turns-only")
        .json(&json!({
            "id": 12,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{ "type": "text", "text": "hello with conversations granted" }]
            }
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(turn2_res.get("error").is_none(), "turn2_res={turn2_res}");

    let mut saw_t2_done = false;
    let deadline2 = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline2 {
        if let Ok(Ok(Some(chunk))) =
            tokio::time::timeout(Duration::from_millis(500), sse.chunk()).await
            && std::str::from_utf8(&chunk)
                .unwrap_or("")
                .contains("\"turn/completed\"")
        {
            saw_t2_done = true;
            break;
        }
    }
    assert!(saw_t2_done, "expected turn 2 to complete");

    {
        let sets = recorded_tool_sets.lock();
        assert_eq!(sets.len(), 2);
        for expected in THREAD_MGMT_TOOLS {
            assert!(
                sets[1].iter().any(|n| n == expected),
                "Mobile TLS with conversations: true MUST expose '{expected}', tools were: {:?}",
                sets[1]
            );
        }
    }

    server.shutdown().await;
    llm_task.abort();
}
