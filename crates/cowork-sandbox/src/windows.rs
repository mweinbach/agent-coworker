use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use chrono::DateTime;
use cowork_config::{canonicalize_sync, resolve_home_dir};
use serde::Deserialize;
use serde_json::Value;

use crate::env_utils::{get_env, host_platform};
use crate::policy::{
    SandboxPolicy, policy_allows_network, scratch_roots, tmp_scratch_roots, with_tmp_scratch,
};
use crate::{SandboxCommand, SandboxType, TransformedCommand};

pub const WINDOWS_SANDBOX_HELPER_NAME: &str = "cowork-win-sandbox.exe";
pub const WINDOWS_SANDBOX_SETUP_NAME: &str = "codex-windows-sandbox-setup.exe";
pub const WINDOWS_SANDBOX_COMMAND_RUNNER_NAME: &str = "codex-command-runner.exe";
pub const WINDOWS_SANDBOX_HASH_MANIFEST_NAME: &str = "cowork-win-sandbox.sha256.json";

/// Setup state marker schema version shared by `cowork-win-sandbox` and `codex app-server`.
pub const CODEX_WINDOWS_SANDBOX_SETUP_VERSION: u64 = 5;

const IMAGE_FILE_MACHINE_I386: u16 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64: u16 = 0xaa64;

/// Resolves the Windows sandbox state home (`COWORK_WIN_SANDBOX_HOME` override or `~/.cowork`).
///
/// Honors `COWORK_HOME_OVERRIDE` and ignores `HOME` on `win32`.
pub fn windows_sandbox_home(env: &HashMap<String, String>) -> PathBuf {
    windows_sandbox_home_for_platform(env, host_platform())
}

/// Platform-parameterized variant of `windows_sandbox_home` for cross-platform unit tests.
pub fn windows_sandbox_home_for_platform(env: &HashMap<String, String>, platform: &str) -> PathBuf {
    if let Some(override_dir) = get_env(env, "COWORK_WIN_SANDBOX_HOME", platform) {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Some(home_override) = get_env(env, "COWORK_HOME_OVERRIDE", platform) {
        let trimmed = home_override.trim();
        if !trimmed.is_empty() {
            return join_cowork_dir(trimmed, platform);
        }
    }
    if platform == "win32" {
        if let Some(user_profile) = get_env(env, "USERPROFILE", "win32") {
            let trimmed = user_profile.trim();
            if !trimmed.is_empty() {
                return join_cowork_dir(trimmed, "win32");
            }
        }
        if let (Some(drive), Some(home_path)) = (
            get_env(env, "HOMEDRIVE", "win32"),
            get_env(env, "HOMEPATH", "win32"),
        ) {
            let combined = format!("{}{}", drive.trim(), home_path.trim());
            if !combined.is_empty() {
                return join_cowork_dir(&combined, "win32");
            }
        }
    }
    resolve_home_dir(env, platform).join(".cowork")
}

fn join_cowork_dir(home_base: &str, platform: &str) -> PathBuf {
    if platform == "win32"
        && (home_base.contains('\\') || home_base.as_bytes().get(1) == Some(&b':'))
    {
        let trimmed = home_base.trim_end_matches(['\\', '/']);
        PathBuf::from(format!(r"{trimmed}\.cowork"))
    } else {
        PathBuf::from(home_base).join(".cowork")
    }
}

/// Builds a `cowork-win-sandbox.exe run ...` command enforcing `policy`.
pub fn build_windows_sandbox_command(
    helper_path: &Path,
    inner: &SandboxCommand,
    policy: &SandboxPolicy,
    cwd: &Path,
    env_source: &HashMap<String, String>,
) -> TransformedCommand {
    let win_scratch = scratch_roots(Some("win32"));
    let (mode_arg, writable_roots): (&str, Vec<PathBuf>) = match policy {
        SandboxPolicy::DangerFullAccess { .. } => ("network-only", Vec::new()),
        SandboxPolicy::NoProjectWrite { project_roots, .. } => {
            let scratch = tmp_scratch_roots(project_roots, &win_scratch);
            if scratch.is_empty() {
                ("read-only", Vec::new())
            } else {
                ("workspace-write", dedupe_win_roots(&scratch))
            }
        }
        SandboxPolicy::ReadOnly { .. } => ("read-only", Vec::new()),
        SandboxPolicy::WorkspaceWrite {
            writable_roots: raw,
            ..
        } => {
            let roots = if !raw.is_empty() {
                with_tmp_scratch(raw, &win_scratch)
            } else {
                tmp_scratch_roots(&[cwd.to_path_buf()], &win_scratch)
            };
            ("workspace-write", dedupe_win_roots(&roots))
        }
    };

    let sandbox_home = windows_sandbox_home(env_source);
    let mut args: Vec<String> = vec![
        "run".to_owned(),
        "--sandbox-home".to_owned(),
        sandbox_home.to_string_lossy().into_owned(),
        "--mode".to_owned(),
        mode_arg.to_owned(),
        "--cwd".to_owned(),
        cwd.to_string_lossy().into_owned(),
    ];

    for root in &writable_roots {
        args.push("--writable-root".to_owned());
        args.push(root.to_string_lossy().into_owned());
    }

    let network_allowed = policy_allows_network(policy);
    if network_allowed {
        args.push("--allow-network".to_owned());
    }

    args.push("--".to_owned());
    args.push(inner.file.clone());
    args.extend(inner.args.iter().cloned());

    let mut env = HashMap::new();
    env.insert("COWORK_SANDBOX".to_owned(), "windows".to_owned());
    if !network_allowed {
        env.insert("COWORK_SANDBOX_NETWORK_DISABLED".to_owned(), "1".to_owned());
    }

    TransformedCommand {
        file: helper_path.to_string_lossy().into_owned(),
        args,
        env,
        sandbox: SandboxType::Windows,
        unsandboxed: false,
    }
}

fn dedupe_win_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for r in roots {
        let resolved = if host_platform() == "win32" {
            canonicalize_sync(r)
        } else {
            r.clone()
        };
        let key = resolved.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            out.push(resolved);
        }
    }
    out
}

/// Reads the 16-bit COFF `Machine` identifier from a Windows PE executable header.
pub fn read_windows_pe_machine(binary_path: &Path) -> Option<u16> {
    let mut f = File::open(binary_path).ok()?;
    let mut dos = [0u8; 64];
    f.read_exact(&mut dos).ok()?;
    if dos[0] != b'M' || dos[1] != b'Z' {
        return None;
    }
    let pe_offset = u32::from_le_bytes([dos[0x3c], dos[0x3d], dos[0x3e], dos[0x3f]]) as u64;
    if pe_offset < 64 {
        return None;
    }
    f.seek(SeekFrom::Start(pe_offset)).ok()?;
    let mut pe_head = [0u8; 6];
    f.read_exact(&mut pe_head).ok()?;
    if &pe_head[0..4] != b"PE\0\0" {
        return None;
    }
    Some(u16::from_le_bytes([pe_head[4], pe_head[5]]))
}

/// Checks whether a PE executable matches the expected Windows target architecture (`"arm64"`, `"x64"`, `"ia32"`).
pub fn is_native_windows_binary(binary_path: &Path, expected_arch: &str) -> bool {
    let expected_machine = match expected_arch {
        "arm64" | "aarch64" => IMAGE_FILE_MACHINE_ARM64,
        "x64" | "x86_64" => IMAGE_FILE_MACHINE_AMD64,
        "ia32" | "x86" => IMAGE_FILE_MACHINE_I386,
        _ => return false,
    };
    read_windows_pe_machine(binary_path) == Some(expected_machine)
}

/// Parsed `cowork-win-sandbox.sha256.json` manifest produced by `scripts/windowsSandboxBundle.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsSandboxHashManifest {
    pub schema_version: u32,
    pub rust_target: String,
    pub files: HashMap<String, String>,
}

/// Loads `cowork-win-sandbox.sha256.json` from `bundle_dir` if present and valid (`schemaVersion == 1`).
pub fn load_windows_sandbox_hash_manifest(bundle_dir: &Path) -> Option<WindowsSandboxHashManifest> {
    let raw = std::fs::read_to_string(bundle_dir.join(WINDOWS_SANDBOX_HASH_MANIFEST_NAME)).ok()?;
    let manifest: WindowsSandboxHashManifest = serde_json::from_str(&raw).ok()?;
    if manifest.schema_version != 1 {
        return None;
    }
    Some(manifest)
}

/// Verifies Windows Authenticode signature on `file_path` via offline-safe native `WinVerifyTrust`
/// (`WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE`), never spawning `powershell.exe`.
#[cfg(windows)]
pub fn verify_windows_authenticode(file_path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    #[repr(C)]
    struct WinTrustFileInfo {
        cb_struct: u32,
        pcwsz_file_path: *const u16,
        h_file: isize,
        pg_known_subject: *const Guid,
    }

    #[repr(C)]
    struct WinTrustData {
        cb_struct: u32,
        p_policy_callback_data: *mut core::ffi::c_void,
        p_sip_client_data: *mut core::ffi::c_void,
        dw_ui_choice: u32,
        fdw_revocation_checks: u32,
        dw_union_choice: u32,
        p_file: *mut WinTrustFileInfo,
        dw_state_action: u32,
        h_wvt_state_data: isize,
        pwsz_url_reference: *const u16,
        dw_prov_flags: u32,
        dw_ui_context: u32,
        p_signature_settings: *mut core::ffi::c_void,
    }

    #[link(name = "wintrust")]
    unsafe extern "system" {
        fn WinVerifyTrust(
            hwnd: isize,
            pg_action_id: *const Guid,
            p_wvt_data: *mut WinTrustData,
        ) -> i32;
    }

    // WINTRUST_ACTION_GENERIC_VERIFY_V2 = {00AAC56B-CD44-11d0-8CC2-00C04FC295EE}
    const ACTION_GENERIC_VERIFY_V2: Guid = Guid {
        data1: 0x00aa_c56b,
        data2: 0xcd44,
        data3: 0x11d0,
        data4: [0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee],
    };
    const INVALID_HANDLE_VALUE: isize = -1;
    const WTD_UI_NONE: u32 = 2;
    const WTD_REVOKE_NONE: u32 = 0;
    const WTD_CHOICE_FILE: u32 = 1;
    const WTD_STATEACTION_VERIFY: u32 = 1;
    const WTD_STATEACTION_CLOSE: u32 = 2;
    const WTD_REVOCATION_CHECK_NONE: u32 = 0x0000_0010;
    const WTD_CACHE_ONLY_URL_RETRIEVAL: u32 = 0x0000_1000;

    let wide_path: Vec<u16> = file_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut file_info = WinTrustFileInfo {
        cb_struct: core::mem::size_of::<WinTrustFileInfo>() as u32,
        pcwsz_file_path: wide_path.as_ptr(),
        h_file: 0,
        pg_known_subject: core::ptr::null(),
    };

    let mut data = WinTrustData {
        cb_struct: core::mem::size_of::<WinTrustData>() as u32,
        p_policy_callback_data: core::ptr::null_mut(),
        p_sip_client_data: core::ptr::null_mut(),
        dw_ui_choice: WTD_UI_NONE,
        fdw_revocation_checks: WTD_REVOKE_NONE,
        dw_union_choice: WTD_CHOICE_FILE,
        p_file: &mut file_info,
        dw_state_action: WTD_STATEACTION_VERIFY,
        h_wvt_state_data: 0,
        pwsz_url_reference: core::ptr::null(),
        dw_prov_flags: WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE,
        dw_ui_context: 0,
        p_signature_settings: core::ptr::null_mut(),
    };

    // SAFETY: `WinVerifyTrust` is called with valid `cb_struct`-sized structs, a NUL-terminated
    // UTF-16 path alive across both calls, and `WTD_STATEACTION_CLOSE` always releases state data.
    unsafe {
        let status = WinVerifyTrust(INVALID_HANDLE_VALUE, &ACTION_GENERIC_VERIFY_V2, &mut data);
        data.dw_state_action = WTD_STATEACTION_CLOSE;
        let _ = WinVerifyTrust(INVALID_HANDLE_VALUE, &ACTION_GENERIC_VERIFY_V2, &mut data);
        status == 0
    }
}

#[cfg(not(windows))]
pub fn verify_windows_authenticode(_file_path: &Path) -> bool {
    false
}

/// Synchronizes v5 Windows sandbox setup marker & secret user state newest-wins between
/// `windows_sandbox_home(env)` (`~/.cowork`) and `codex_home` (`~/.cowork/auth/codex-cli`).
///
/// Writes `sandbox_users.json` BEFORE `setup_marker.json` atomically so an interrupted copy never
/// advertises v5 setup readiness for missing credentials, and never consults `~/.codex`.
pub fn sync_codex_windows_sandbox_setup_state(
    codex_home: &Path,
    env: &HashMap<String, String>,
    platform_override: Option<&str>,
) {
    let platform = platform_override.unwrap_or(host_platform());
    if platform != "win32" {
        return;
    }
    let sandbox_home = windows_sandbox_home_for_platform(env, "win32");
    sync_codex_windows_sandbox_setup_state_between(&sandbox_home, codex_home);
}

/// Direct two-directory v5 setup state synchronizer shared with `cowork-providers`.
pub fn sync_codex_windows_sandbox_setup_state_between(sandbox_home: &Path, codex_home: &Path) {
    let mut candidate_homes: Vec<PathBuf> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();
    for dir in [sandbox_home, codex_home] {
        let key = dir
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase();
        if seen_keys.insert(key) {
            candidate_homes.push(dir.to_path_buf());
        }
    }
    if candidate_homes.len() < 2 {
        return;
    }

    let mut freshest: Option<SetupStateCandidate> = None;
    for dir in &candidate_homes {
        if let Some(cand) = read_valid_setup_state(dir)
            && freshest
                .as_ref()
                .is_none_or(|prev| cand.timestamp_ms > prev.timestamp_ms)
        {
            freshest = Some(cand);
        }
    }

    let Some(winner) = freshest else {
        return;
    };

    for target_home in &candidate_homes {
        if target_home == &winner.home_dir {
            continue;
        }
        if let Some(existing) = read_valid_setup_state(target_home)
            && existing.marker_raw == winner.marker_raw
            && existing.users_raw == winner.users_raw
        {
            continue;
        }
        // Write `sandbox_users.json` FIRST and `setup_marker.json` LAST.
        if write_atomic_private(
            &target_home
                .join(".sandbox-secrets")
                .join("sandbox_users.json"),
            &winner.users_raw,
        )
        .is_ok()
        {
            let _ = write_atomic_private(
                &target_home.join(".sandbox").join("setup_marker.json"),
                &winner.marker_raw,
            );
        }
    }
}

struct SetupStateCandidate {
    home_dir: PathBuf,
    marker_raw: String,
    users_raw: String,
    timestamp_ms: i64,
}

fn read_valid_setup_state(home_dir: &Path) -> Option<SetupStateCandidate> {
    let marker_path = home_dir.join(".sandbox").join("setup_marker.json");
    let users_path = home_dir.join(".sandbox-secrets").join("sandbox_users.json");

    let marker_raw = std::fs::read_to_string(&marker_path).ok()?;
    let users_raw = std::fs::read_to_string(&users_path).ok()?;

    let marker_json: Value = serde_json::from_str(&marker_raw).ok()?;
    let users_json: Value = serde_json::from_str(&users_raw).ok()?;

    if marker_json.get("version").and_then(Value::as_u64)
        != Some(CODEX_WINDOWS_SANDBOX_SETUP_VERSION)
    {
        return None;
    }
    let users_non_empty = users_json
        .get("users")
        .and_then(Value::as_array)
        .is_some_and(|arr| !arr.is_empty());
    if !users_non_empty {
        return None;
    }

    let created_ms = marker_json
        .get("created_at")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis());

    let timestamp_ms = match created_ms {
        Some(ms) => ms,
        None => std::fs::metadata(&marker_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    };

    Some(SetupStateCandidate {
        home_dir: home_dir.to_path_buf(),
        marker_raw,
        users_raw,
        timestamp_ms,
    })
}

fn write_atomic_private(dest: &Path, content: &str) -> std::io::Result<()> {
    static NEXT_NONCE: AtomicU64 = AtomicU64::new(1);
    let Some(parent) = dest.parent() else {
        return Err(std::io::Error::other("missing parent directory"));
    };
    std::fs::create_dir_all(parent)?;
    let nonce = NEXT_NONCE.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(
        ".{}.tmp-{}-{}",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("sync"),
        std::process::id(),
        nonce
    ));
    if let Err(err) = std::fs::write(&tmp, content.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}
