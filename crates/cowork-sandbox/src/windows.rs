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
    absolutize_host_path(&windows_sandbox_home_for_platform(env, host_platform()))
}

/// Resolves `path` against the server process cwd (TS `path.resolve`) so a relative value can
/// never be re-resolved against the session workspace the helper is spawned in.
fn absolutize_host_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
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
    let cwd_abs = absolutize_host_path(cwd);
    let cwd = cwd_abs.as_path();
    let (mode_arg, writable_roots) = windows_mode_and_writable_roots(policy, cwd);

    sync_windows_sandbox_for_env_if_applicable(env_source);
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
    env.insert(
        "COWORK_SANDBOX".to_owned(),
        SandboxType::Windows.as_str().to_owned(),
    );
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

/// Maps `policy` to the helper `--mode` and its `--writable-root` set (TS
/// `buildWindowsSandboxCommand` parity). `danger-full-access` (only wrapped when `network` is
/// off) runs as `network-only`, which the helper still confines to `cwd` plus explicit writable
/// roots, so it gets `cwd` and the filtered temp scratch like the other writable policies.
fn windows_mode_and_writable_roots(
    policy: &SandboxPolicy,
    cwd: &Path,
) -> (&'static str, Vec<PathBuf>) {
    let win_scratch = scratch_roots(Some("win32"));
    match policy {
        SandboxPolicy::DangerFullAccess { .. } => (
            "network-only",
            dedupe_win_roots(&with_tmp_scratch(&[cwd.to_path_buf()], &win_scratch)),
        ),
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
    }
}

fn dedupe_win_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for r in roots {
        let resolved = if host_platform() == "win32" {
            absolutize_host_path(&canonicalize_sync(r))
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

/// Best-effort pre-probe / pre-command Windows setup-state sync between Cowork's sandbox home
/// and `<cowork_home>/auth/codex-cli`.
///
/// On non-Windows hosts (cross-platform unit tests), runs only when `env` provides an isolated
/// home override so ambient `~/.cowork` is never touched.
pub(crate) fn sync_windows_sandbox_for_env_if_applicable(env: &HashMap<String, String>) {
    let platform = host_platform();
    if platform == "win32" {
        let sandbox_home = windows_sandbox_home_for_platform(env, "win32");
        let cowork_home = explicit_cowork_home_from_env(env, "win32")
            .unwrap_or_else(|| resolve_home_dir(env, "win32").join(".cowork"));
        let codex_home = cowork_home.join("auth").join("codex-cli");
        sync_codex_windows_sandbox_setup_state_between(&sandbox_home, &codex_home);
        return;
    }

    let explicit_sbx = get_env(env, "COWORK_WIN_SANDBOX_HOME", platform)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let explicit_cowork = explicit_cowork_home_from_env(env, platform);

    match (explicit_sbx, explicit_cowork) {
        (Some(sbx_home), Some(cowork_home)) => {
            sync_codex_windows_sandbox_setup_state_between(
                &sbx_home,
                &cowork_home.join("auth").join("codex-cli"),
            );
        }
        (Some(sbx_home), None) => {
            let codex_home = sbx_home.join("auth").join("codex-cli");
            sync_codex_windows_sandbox_setup_state_between(&sbx_home, &codex_home);
        }
        (None, Some(cowork_home)) => {
            let codex_home = cowork_home.join("auth").join("codex-cli");
            sync_codex_windows_sandbox_setup_state_between(&cowork_home, &codex_home);
        }
        (None, None) => {}
    }
}

fn explicit_cowork_home_from_env(env: &HashMap<String, String>, platform: &str) -> Option<PathBuf> {
    if let Some(home_override) = get_env(env, "COWORK_HOME_OVERRIDE", platform) {
        let trimmed = home_override.trim();
        if !trimmed.is_empty() {
            return Some(join_cowork_dir(trimmed, platform));
        }
    }
    if let Some(user_profile) = get_env(env, "USERPROFILE", "win32") {
        let trimmed = user_profile.trim();
        if !trimmed.is_empty() {
            return Some(join_cowork_dir(trimmed, "win32"));
        }
    }
    if let (Some(drive), Some(home_path)) = (
        get_env(env, "HOMEDRIVE", "win32"),
        get_env(env, "HOMEPATH", "win32"),
    ) {
        let combined = format!("{}{}", drive.trim(), home_path.trim());
        if !combined.is_empty() {
            return Some(join_cowork_dir(&combined, "win32"));
        }
    }
    if platform != "win32"
        && let Some(home) = get_env(env, "HOME", platform)
    {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join(".cowork"));
        }
    }
    None
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
    if users_json.get("version").and_then(Value::as_u64)
        != Some(CODEX_WINDOWS_SANDBOX_SETUP_VERSION)
    {
        return None;
    }
    let valid_user_record = |key: &str| {
        users_json
            .get(key)
            .and_then(Value::as_object)
            .is_some_and(|obj| {
                obj.get("username")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                    && obj
                        .get("password")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
            })
    };
    if !valid_user_record("offline") || !valid_user_record("online") {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn arg_after<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        args.windows(2)
            .filter(|w| w[0] == flag)
            .map(|w| w[1].as_str())
            .collect()
    }

    #[test]
    fn danger_full_access_without_network_grants_cwd_and_temp_scratch() {
        // A cwd outside the temp dir so the scratch root is not filtered as over-scoping it.
        let cwd = Path::new("/cowork-test-nonexistent/workspace");
        let (mode, roots) = windows_mode_and_writable_roots(
            &SandboxPolicy::DangerFullAccess {
                network: Some(false),
            },
            cwd,
        );
        assert_eq!(mode, "network-only");
        // On a Windows host the rooted-but-driveless cwd is absolutized onto the current drive.
        let abs_cwd = std::path::absolute(cwd).unwrap();
        assert!(roots.contains(&abs_cwd), "{roots:?}");
        for scratch in scratch_roots(Some("win32")) {
            // Roots are canonicalized on Windows hosts (8.3 short names, trailing separators).
            let canonical = cowork_config::canonicalize_sync(&scratch);
            assert!(
                roots.contains(&scratch) || roots.contains(&canonical),
                "{scratch:?} missing: {roots:?}"
            );
        }
        // Parity with workspace-write over the same root.
        let (_, ww_roots) = windows_mode_and_writable_roots(
            &SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![cwd.to_path_buf()],
                writable_root_kinds: HashMap::new(),
                network: false,
            },
            cwd,
        );
        assert_eq!(roots, ww_roots);

        let cmd = build_windows_sandbox_command(
            Path::new("/opt/cowork/cowork-win-sandbox.exe"),
            &SandboxCommand::new("cmd.exe", ["/c", "echo hi"]),
            &SandboxPolicy::DangerFullAccess {
                network: Some(false),
            },
            cwd,
            &HashMap::new(),
        );
        let writable = arg_after(&cmd.args, "--writable-root");
        assert!(
            writable.contains(&abs_cwd.to_str().unwrap()),
            "{:?}",
            cmd.args
        );
        assert!(writable.len() > 1, "temp scratch missing: {:?}", cmd.args);
    }

    #[test]
    fn relative_sandbox_home_and_cwd_are_absolutized_against_the_server_cwd() {
        let server_cwd = std::env::current_dir().unwrap();
        let mut env = HashMap::new();
        env.insert(
            "COWORK_WIN_SANDBOX_HOME".to_owned(),
            "cowork-test-relative-sbx-home".to_owned(),
        );
        assert_eq!(
            windows_sandbox_home(&env),
            server_cwd.join("cowork-test-relative-sbx-home")
        );
        let cmd = build_windows_sandbox_command(
            Path::new("/opt/cowork/cowork-win-sandbox.exe"),
            &SandboxCommand::new("cmd.exe", ["/c", "echo hi"]),
            &SandboxPolicy::ReadOnly { network: false },
            Path::new("relative-ws"),
            &env,
        );
        for flag in ["--sandbox-home", "--cwd"] {
            let values = arg_after(&cmd.args, flag);
            assert_eq!(values.len(), 1, "{flag}: {:?}", cmd.args);
            assert!(Path::new(values[0]).is_absolute(), "{flag}: {:?}", cmd.args);
        }
        assert_eq!(
            arg_after(&cmd.args, "--cwd"),
            [server_cwd.join("relative-ws").to_str().unwrap()]
        );
        assert!(!server_cwd.join("cowork-test-relative-sbx-home").exists());
    }
}
