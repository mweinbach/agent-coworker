//! The mobile pairing ticket must advertise a LAN address the phone can reach when the listener
//! binds a wildcard host. The adapter list here mirrors what `GetAdaptersAddresses` reports on a
//! typical Windows machine (loopback pseudo-interface, Ethernet, Hyper-V switch, Teredo, scoped
//! link-local IPv6 and APIPA), since Windows enumeration itself cannot run on Linux CI.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use cowork_server::mobile_h3::opentunnel::OpenTunnelServerConfig;
use cowork_server::mobile_h3::server::{StartMobileH3ServerOptions, start_mobile_h3_server};
use cowork_server::mobile_h3::ticket::decode_cowork_pairing_ticket;
use cowork_server::startup::{InterfaceAddrInfo, resolve_listening_hints_from_interfaces};
use cowork_server::{ServerOptions, start_server};
use uuid::Uuid;

fn iface(address: &str, is_ipv6: bool, internal: bool) -> InterfaceAddrInfo {
    InterfaceAddrInfo {
        address: address.to_owned(),
        is_ipv6,
        internal,
    }
}

/// Addresses of the adapters that are up on a typical Windows host, in adapter order.
fn windows_adapter_addresses() -> Vec<InterfaceAddrInfo> {
    vec![
        // Loopback Pseudo-Interface 1 (IF_TYPE_SOFTWARE_LOOPBACK).
        iface("::1", true, true),
        iface("127.0.0.1", false, true),
        // Ethernet.
        iface("fe80::1c2b:3d4e:5f60:7182%12", true, false),
        iface("192.168.1.23", false, false),
        // vEthernet (Default Switch).
        iface("172.24.32.1", false, false),
        // Teredo Tunneling Pseudo-Interface.
        iface("2001:0:2851:782c:1c2b:3d4e:5f60:7182", true, false),
        // An adapter that fell back to APIPA.
        iface("169.254.77.12", false, false),
    ]
}

#[test]
fn wildcard_hints_from_windows_adapters_lead_with_lan_addresses() {
    let hints = resolve_listening_hints_from_interfaces("0.0.0.0", &windows_adapter_addresses());
    assert_eq!(
        hints,
        vec![
            "192.168.1.23",
            "172.24.32.1",
            "2001:0:2851:782c:1c2b:3d4e:5f60:7182",
            "169.254.77.12",
            "127.0.0.1",
        ]
    );

    let v6_hints = resolve_listening_hints_from_interfaces("::", &windows_adapter_addresses());
    assert_eq!(v6_hints.first().map(String::as_str), Some("192.168.1.23"));
    assert_eq!(v6_hints.last().map(String::as_str), Some("::1"));

    // Only the loopback adapter up: the ticket can only fall back to loopback.
    let loopback_only =
        resolve_listening_hints_from_interfaces("0.0.0.0", &windows_adapter_addresses()[..2]);
    assert_eq!(loopback_only, vec!["127.0.0.1"]);

    // Explicit bind hosts are advertised as-is.
    assert_eq!(
        resolve_listening_hints_from_interfaces(" 192.168.1.23 ", &[]),
        vec!["192.168.1.23"]
    );
}

#[tokio::test]
async fn direct_mode_ticket_hosts_include_the_lan_address() {
    let base_dir = std::env::temp_dir().join(format!("cowork-h3-lan-hints-{}", Uuid::new_v4()));
    let home_dir = base_dir.join("home");
    let userdata_dir = base_dir.join("userdata");
    let workspace_dir = base_dir.join("workspace");
    for dir in [&home_dir, &userdata_dir, &workspace_dir] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let home_dir = std::fs::canonicalize(&home_dir).unwrap();
    let userdata_dir = std::fs::canonicalize(&userdata_dir).unwrap();
    let workspace_dir = std::fs::canonicalize(&workspace_dir).unwrap();

    let mut env = HashMap::new();
    env.insert("HOME".into(), home_dir.to_string_lossy().into_owned());
    env.insert(
        "COWORK_HOME_OVERRIDE".into(),
        home_dir.to_string_lossy().into_owned(),
    );
    for key in [
        "COWORK_ELECTRON_USER_DATA_DIR",
        "COWORK_DESKTOP_USER_DATA_DIR",
    ] {
        env.insert(key.into(), userdata_dir.to_string_lossy().into_owned());
    }
    env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
    env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
    env.insert("COWORK_OPENTUNNEL_DISABLE".into(), "1".into());
    env.insert("LM_STUDIO_BASE_URL".into(), "http://127.0.0.1:9".into());

    let server = start_server(ServerOptions {
        working_directory: workspace_dir,
        host: "127.0.0.1".into(),
        port: 0,
        yolo: false,
        mobile_h3: false,
        mobile_h3_host: "127.0.0.1".into(),
        mobile_h3_port: 0,
        homedir: Some(home_dir.clone()),
        built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        env,
    })
    .await
    .unwrap();

    let host_hints =
        resolve_listening_hints_from_interfaces("0.0.0.0", &windows_adapter_addresses());
    let mobile_h3 = start_mobile_h3_server(StartMobileH3ServerOptions {
        runtime: server.runtime().clone(),
        // Bind loopback so the test opens no LAN listener; the hints are what the ticket carries.
        hostname: "127.0.0.1".into(),
        port: Some(0),
        host_hints: host_hints.clone(),
        store_root_path: home_dir.join(".cowork"),
        enable_h3: true,
        rotate_tls: false,
        sse_keepalive_interval: Some(Duration::from_secs(60)),
        open_tunnel: Some(OpenTunnelServerConfig {
            enabled: Some(false),
            ..Default::default()
        }),
    })
    .await
    .unwrap();

    let info = mobile_h3.info.read().clone();
    let ticket = decode_cowork_pairing_ticket(&info.ticket).unwrap();
    assert_eq!(ticket.hosts, host_hints);
    assert_eq!(
        ticket.hosts.first().map(String::as_str),
        Some("192.168.1.23")
    );
    assert_eq!(ticket.port, info.port);
    assert_eq!(info.host_hints, host_hints);
    assert_eq!(info.url, format!("https://192.168.1.23:{}", info.port));

    mobile_h3.stop().await;
    server.shutdown().await;
    let _ = std::fs::remove_dir_all(&base_dir);
}
