use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

pub type MobileH3AdminState = crate::mobile_h3::server::MobileH3Server;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfaceAddrInfo {
    pub address: String,
    pub is_ipv6: bool,
    pub internal: bool,
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn is_link_local_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 169 && octets[1] == 254
}

fn is_link_local_ipv6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

pub fn resolve_listening_hints_from_interfaces(
    host: &str,
    interfaces: &[InterfaceAddrInfo],
) -> Vec<String> {
    let trimmed = host.trim();
    if trimmed != "0.0.0.0" && trimmed != "::" {
        return vec![trimmed.to_owned()];
    }

    let mut private_v4 = Vec::new();
    let mut public_v4 = Vec::new();
    let mut global_v6 = Vec::new();
    let mut link_local_v4 = Vec::new();

    for entry in interfaces {
        if entry.internal {
            continue;
        }
        let addr_clean = entry
            .address
            .split('%')
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        if addr_clean.is_empty() {
            continue;
        }
        if entry.is_ipv6 {
            if let Ok(v6) = addr_clean.parse::<Ipv6Addr>()
                && !v6.is_loopback()
                && !v6.is_unspecified()
                && !is_link_local_ipv6(v6)
            {
                global_v6.push(addr_clean);
            }
        } else if let Ok(v4) = addr_clean.parse::<Ipv4Addr>() {
            if v4.is_loopback() || v4.is_unspecified() {
                continue;
            }
            if is_private_ipv4(v4) {
                private_v4.push(addr_clean);
            } else if is_link_local_ipv4(v4) {
                link_local_v4.push(addr_clean);
            } else {
                public_v4.push(addr_clean);
            }
        }
    }

    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    for candidate in private_v4
        .into_iter()
        .chain(public_v4)
        .chain(global_v6)
        .chain(link_local_v4)
    {
        if seen.insert(candidate.clone()) {
            ordered.push(candidate);
        }
    }

    let fallback = if trimmed == "::" { "::1" } else { "127.0.0.1" };
    if seen.insert(fallback.to_owned()) {
        ordered.push(fallback.to_owned());
    }
    ordered
}

#[cfg(unix)]
fn enumerate_system_interfaces() -> Vec<InterfaceAddrInfo> {
    let mut out = Vec::new();
    // SAFETY: `getifaddrs` initializes `ifap` on return `0` and `freeifaddrs` frees the list before returning.
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) != 0 || ifap.is_null() {
            return out;
        }
        let mut cur = ifap;
        while !cur.is_null() {
            let ifa = &*cur;
            let flags = ifa.ifa_flags as i32;
            let is_up = (flags & libc::IFF_UP) != 0;
            let is_loopback = (flags & libc::IFF_LOOPBACK) != 0;
            if is_up && !ifa.ifa_addr.is_null() {
                let family = i32::from((*ifa.ifa_addr).sa_family);
                if family == libc::AF_INET {
                    let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                    out.push(InterfaceAddrInfo {
                        address: IpAddr::V4(ip).to_string(),
                        is_ipv6: false,
                        internal: is_loopback || ip.is_loopback(),
                    });
                } else if family == libc::AF_INET6 {
                    let sin6 = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                    let ip = Ipv6Addr::from(sin6.sin6_addr.s6_addr);
                    out.push(InterfaceAddrInfo {
                        address: IpAddr::V6(ip).to_string(),
                        is_ipv6: true,
                        internal: is_loopback || ip.is_loopback(),
                    });
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(ifap);
    }
    out
}

#[cfg(not(unix))]
fn enumerate_system_interfaces() -> Vec<InterfaceAddrInfo> {
    Vec::new()
}

/// Resolves connectable host hints for `0.0.0.0` / `::` or explicit bind hosts.
pub fn resolve_listening_hints(host: &str) -> Vec<String> {
    let trimmed = host.trim();
    if trimmed != "0.0.0.0" && trimmed != "::" {
        return vec![trimmed.to_owned()];
    }
    let interfaces = enumerate_system_interfaces();
    resolve_listening_hints_from_interfaces(trimmed, &interfaces)
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
