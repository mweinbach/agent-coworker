use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use cowork_config::canonicalize_sync;

use crate::policy::{
    SandboxPolicy, WritableRootKind, policy_allows_network, scratch_roots, tmp_scratch_roots,
    with_tmp_scratch,
};
use crate::protected_paths::{
    PROTECTED_SUBDIRS, ProtectedMetadataOptions, WorkspaceProtectedPathsCache,
    protected_metadata_paths,
};
use crate::{SandboxCommand, SandboxType, TransformedCommand};

/// Canonical path to Apple's Seatbelt launcher; never resolved via `PATH`.
pub const MACOS_SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

const SEATBELT_BASE_POLICY: &str = r#"(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))
(allow sysctl-read)
(allow ipc-posix-sem)
(allow pseudo-tty)
(allow file-read-data file-read-metadata file-write-data file-ioctl
  (literal "/dev/ptmx"))
(allow file-read-data file-read-metadata file-write-data file-ioctl
  (regex #"^/dev/ttys[0-9]+$"))"#;

const SEATBELT_NETWORK_POLICY: &str = r#"(allow network-outbound)
(allow network-inbound)
(allow system-socket)
(allow mach-lookup
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.trustd")
  (global-name "com.apple.securityd")
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.networkd")
  (global-name "com.apple.nsurlsessiond")
  (global-name "com.apple.symptom_diagnostics"))"#;

/// Builds a macOS `/usr/bin/sandbox-exec` invocation enforcing `policy` without touching `PATH`.
pub fn build_seatbelt_command(
    inner: &SandboxCommand,
    policy: &SandboxPolicy,
) -> TransformedCommand {
    build_seatbelt_command_with_cache(inner, policy, None)
}

/// Builds a macOS `/usr/bin/sandbox-exec` invocation using an optional `WorkspaceProtectedPathsCache`
/// to avoid per-command workspace walks.
pub fn build_seatbelt_command_with_cache(
    inner: &SandboxCommand,
    policy: &SandboxPolicy,
    cache: Option<&WorkspaceProtectedPathsCache>,
) -> TransformedCommand {
    let mut dir_params: Vec<String> = Vec::new();
    let file_read_policy = "; allow read-only file operations\n(allow file-read*)";

    let file_write_policy = if matches!(policy, SandboxPolicy::DangerFullAccess { .. }) {
        "(allow file-write* (subpath \"/\"))".to_owned()
    } else {
        let darwin_scratch = scratch_roots(Some("darwin"));
        let empty_kinds: HashMap<PathBuf, WritableRootKind> = HashMap::new();
        let (roots, root_kinds): (Vec<PathBuf>, &HashMap<PathBuf, WritableRootKind>) = match policy
        {
            SandboxPolicy::ReadOnly { .. } => (Vec::new(), &empty_kinds),
            SandboxPolicy::NoProjectWrite { project_roots, .. } => (
                tmp_scratch_roots(project_roots, &darwin_scratch),
                &empty_kinds,
            ),
            SandboxPolicy::WorkspaceWrite {
                writable_roots,
                writable_root_kinds,
                ..
            } => (
                with_tmp_scratch(writable_roots, &darwin_scratch),
                writable_root_kinds,
            ),
            SandboxPolicy::DangerFullAccess { .. } => unreachable!(),
        };

        let mut seen_writable: HashSet<PathBuf> = HashSet::new();
        let mut writable_entries: Vec<(PathBuf, bool)> = Vec::new();
        let mut directory_roots: Vec<PathBuf> = Vec::new();
        let mut seen_excluded: HashSet<PathBuf> = HashSet::new();
        let mut excluded_roots: Vec<PathBuf> = Vec::new();

        for r in &roots {
            let resolved = canonicalize_sync(r);
            if !seen_writable.insert(resolved.clone()) {
                continue;
            }
            let explicit_kind = root_kinds
                .get(r)
                .or_else(|| root_kinds.get(&resolved))
                .copied();
            let is_file = match explicit_kind {
                Some(WritableRootKind::File) => true,
                Some(WritableRootKind::Directory) => false,
                None => std::fs::metadata(&resolved).is_ok_and(|m| m.is_file()),
            };
            writable_entries.push((resolved.clone(), is_file));
            if !is_file {
                directory_roots.push(resolved.clone());
                for sub in PROTECTED_SUBDIRS {
                    let cand = canonicalize_sync(&resolved.join(sub));
                    if seen_excluded.insert(cand.clone()) {
                        excluded_roots.push(cand);
                    }
                }
            }
        }

        let nested_protected = protected_metadata_paths(
            &directory_roots,
            ProtectedMetadataOptions {
                platform: Some("darwin"),
                exists: None,
                is_directory: None,
                cache,
            },
        );
        for nested in nested_protected {
            let resolved = canonicalize_sync(&nested);
            if seen_excluded.insert(resolved.clone()) {
                excluded_roots.push(resolved);
            }
        }

        if writable_entries.is_empty() {
            String::new()
        } else {
            let mut root_clauses = Vec::with_capacity(writable_entries.len());
            for (idx, (root, is_file)) in writable_entries.iter().enumerate() {
                let param = format!("WRITABLE_ROOT_{idx}");
                dir_params.push(format!("-D{param}={}", root.to_string_lossy()));
                let matcher = if *is_file { "literal" } else { "subpath" };
                root_clauses.push(format!("({matcher} (param \"{param}\"))"));
            }

            let allow_clause = if root_clauses.len() == 1 {
                root_clauses.remove(0)
            } else {
                format!("(require-any {})", root_clauses.join(" "))
            };

            let mut exclude_clauses = Vec::with_capacity(excluded_roots.len());
            for (idx, excluded) in excluded_roots.iter().enumerate() {
                let param = format!("WRITABLE_EXCLUDED_{idx}");
                dir_params.push(format!("-D{param}={}", excluded.to_string_lossy()));
                exclude_clauses.push(format!("(require-not (subpath (param \"{param}\")))"));
            }

            if exclude_clauses.is_empty() {
                format!("(allow file-write*\n  {allow_clause}\n)")
            } else {
                format!(
                    "(allow file-write*\n  (require-all\n    {allow_clause}\n    {}\n  )\n)",
                    exclude_clauses.join("\n    ")
                )
            }
        }
    };

    let network_allowed = policy_allows_network(policy);
    let mut sections: Vec<&str> = vec![SEATBELT_BASE_POLICY, file_read_policy];
    if !file_write_policy.is_empty() {
        sections.push(&file_write_policy);
    }
    if network_allowed {
        sections.push(SEATBELT_NETWORK_POLICY);
    }
    let full_policy = sections.join("\n");

    let mut args = Vec::with_capacity(3 + dir_params.len() + inner.args.len());
    args.push("-p".to_owned());
    args.push(full_policy);
    args.extend(dir_params);
    args.push("--".to_owned());
    args.push(inner.file.clone());
    args.extend(inner.args.iter().cloned());

    let mut env = HashMap::new();
    env.insert("COWORK_SANDBOX".to_owned(), "seatbelt".to_owned());
    if !network_allowed {
        env.insert("COWORK_SANDBOX_NETWORK_DISABLED".to_owned(), "1".to_owned());
    }

    TransformedCommand {
        file: MACOS_SEATBELT_EXECUTABLE.to_owned(),
        args,
        env,
        sandbox: SandboxType::Seatbelt,
        unsandboxed: false,
    }
}
