use std::collections::HashSet;
#[cfg(unix)]
use std::net::IpAddr;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

pub type MobileH3AdminState = crate::mobile_h3::server::MobileH3Server;

pub use cowork_env::{RuntimeBootstrapProgress, StartupProgressEvent};

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

/// Lists the unicast addresses of every adapter that is up, like libuv's `uv_interface_addresses`
/// (Node's `os.networkInterfaces()`): adapters whose `OperStatus` is not up are skipped, and the
/// software loopback adapter is reported as internal.
#[cfg(windows)]
fn enumerate_system_interfaces() -> Vec<InterfaceAddrInfo> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
        GetAdaptersAddresses, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6,
    };

    const WORD: usize = std::mem::size_of::<u64>();
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut out = Vec::new();
    // `u64` words keep the buffer 8-byte aligned, as `IP_ADAPTER_ADDRESSES_LH` requires.
    let mut buf: Vec<u64> = Vec::new();
    let mut size_bytes: u32 = 16 * 1024;
    let mut fetched = false;
    for _ in 0..4 {
        buf.resize((size_bytes as usize).div_ceil(WORD).max(1), 0);
        let mut len = u32::try_from(buf.len() * WORD).unwrap_or(u32::MAX);
        // SAFETY: `buf` is writable for `len` bytes and suitably aligned; the reserved pointer is null.
        let rc = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_UNSPEC),
                flags,
                std::ptr::null(),
                buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut len,
            )
        };
        if rc == ERROR_SUCCESS {
            fetched = true;
            break;
        }
        if rc != ERROR_BUFFER_OVERFLOW {
            return out;
        }
        size_bytes = len;
    }
    if !fetched {
        return out;
    }

    // SAFETY: on `ERROR_SUCCESS` the buffer holds a null-terminated linked list of adapters whose
    // address lists and sockaddrs all point into `buf`, which outlives this walk. Sockaddrs are read
    // with `read_unaligned` after checking the family and the reported length.
    unsafe {
        let mut adapter: *const IP_ADAPTER_ADDRESSES_LH = buf.as_ptr().cast();
        while !adapter.is_null() {
            let entry = &*adapter;
            if entry.OperStatus == IfOperStatusUp {
                let internal = entry.IfType == IF_TYPE_SOFTWARE_LOOPBACK;
                let mut unicast = entry.FirstUnicastAddress.cast_const();
                while !unicast.is_null() {
                    let addr = &*unicast;
                    let sockaddr = addr.Address.lpSockaddr.cast_const();
                    let sockaddr_len = usize::try_from(addr.Address.iSockaddrLength).unwrap_or(0);
                    if !sockaddr.is_null() && sockaddr_len >= std::mem::size_of::<SOCKADDR>() {
                        let family = std::ptr::read_unaligned(sockaddr).sa_family;
                        if family == AF_INET && sockaddr_len >= std::mem::size_of::<SOCKADDR_IN>() {
                            let sin = std::ptr::read_unaligned(sockaddr.cast::<SOCKADDR_IN>());
                            let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr));
                            out.push(InterfaceAddrInfo {
                                address: ip.to_string(),
                                is_ipv6: false,
                                internal: internal || ip.is_loopback(),
                            });
                        } else if family == AF_INET6
                            && sockaddr_len >= std::mem::size_of::<SOCKADDR_IN6>()
                        {
                            let sin6 = std::ptr::read_unaligned(sockaddr.cast::<SOCKADDR_IN6>());
                            let ip = Ipv6Addr::from(sin6.sin6_addr.u.Byte);
                            out.push(InterfaceAddrInfo {
                                address: ip.to_string(),
                                is_ipv6: true,
                                internal: internal || ip.is_loopback(),
                            });
                        }
                    }
                    unicast = addr.Next.cast_const();
                }
            }
            adapter = entry.Next.cast_const();
        }
    }
    out
}

#[cfg(not(any(unix, windows)))]
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
