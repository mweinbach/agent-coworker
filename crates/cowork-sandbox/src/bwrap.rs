use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

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

/// Options controlling `build_bwrap_command` (supporting both production self-exec and synthetic tests).
#[derive(Default)]
pub struct BwrapBuildOptions<'a> {
    /// Path to the `cowork-server` binary used inside `bwrap` for `__sandbox-exec --linux-seccomp`.
    /// Defaults to `COWORK_SANDBOX_EXEC_PATH` or `std::env::current_exe()`.
    pub sandbox_exec_path: Option<&'a Path>,
    pub exists: Option<&'a dyn Fn(&Path) -> bool>,
    pub is_directory: Option<&'a dyn Fn(&Path) -> bool>,
    pub cache: Option<&'a WorkspaceProtectedPathsCache>,
    /// Credential paths (e.g. `~/.ssh`, `~/.cowork/auth`, `<ws>/.cowork/auth`) hidden from the
    /// sandboxed process. Applied to every policy, after all other binds, so no writable or
    /// read-only bind can re-expose them: existing directories are masked with an empty
    /// read-only `--tmpfs`, existing files with `--ro-bind /dev/null`; missing paths are skipped.
    pub read_denied_roots: &'a [PathBuf],
}

/// Resolves the `cowork-server` executable path used for `__sandbox-exec --linux-seccomp`.
pub fn resolve_sandbox_exec_binary(explicit: Option<&Path>) -> String {
    if let Some(p) = explicit {
        return p.to_string_lossy().into_owned();
    }
    if let Ok(from_env) = std::env::var("COWORK_SANDBOX_EXEC_PATH") {
        let trimmed = from_env.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "cowork-server".to_owned())
}

/// Builds a Linux `bwrap` command paired with `<self_exe> __sandbox-exec --linux-seccomp`
/// (zero `/usr/bin/python3` dependency).
pub fn build_bwrap_command(
    bwrap_path: &Path,
    inner: &SandboxCommand,
    policy: &SandboxPolicy,
    cwd: &Path,
    opts: BwrapBuildOptions<'_>,
) -> TransformedCommand {
    let custom_predicates = opts.exists.is_some() || opts.is_directory.is_some();
    let default_exists = |p: &Path| std::fs::metadata(p).is_ok();
    let default_is_dir = |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.is_dir());
    let exists_fn = opts.exists.unwrap_or(&default_exists);
    let is_dir_fn = opts.is_directory.unwrap_or(&default_is_dir);

    let mut args: Vec<String> = vec!["--new-session".to_owned(), "--die-with-parent".to_owned()];

    if matches!(policy, SandboxPolicy::DangerFullAccess { .. }) {
        args.extend(["--bind", "/", "/", "--dev", "/dev"].map(str::to_owned));
    } else {
        args.extend(["--ro-bind", "/", "/", "--dev", "/dev"].map(str::to_owned));

        let linux_scratch = scratch_roots(Some("linux"));
        let empty_kinds: HashMap<PathBuf, WritableRootKind> = HashMap::new();
        let (raw_roots, root_kinds, explicit_scan_set): (
            Vec<PathBuf>,
            &HashMap<PathBuf, WritableRootKind>,
            HashSet<PathBuf>,
        ) = match policy {
            SandboxPolicy::ReadOnly { .. } => (Vec::new(), &empty_kinds, HashSet::new()),
            SandboxPolicy::NoProjectWrite { project_roots, .. } => (
                tmp_scratch_roots(project_roots, &linux_scratch),
                &empty_kinds,
                HashSet::new(),
            ),
            SandboxPolicy::WorkspaceWrite {
                writable_roots,
                writable_root_kinds,
                ..
            } => {
                let explicit: HashSet<PathBuf> = writable_roots
                    .iter()
                    .map(|r| {
                        if custom_predicates {
                            r.clone()
                        } else {
                            canonicalize_sync(r)
                        }
                    })
                    .collect();
                (
                    with_tmp_scratch(writable_roots, &linux_scratch),
                    writable_root_kinds,
                    explicit,
                )
            }
            SandboxPolicy::DangerFullAccess { .. } => unreachable!(),
        };

        // Materialize missing hinted targetPaths before canonicalization/sorting.
        for r in &raw_roots {
            let resolved_candidate = canonicalize_sync(r);
            let explicit_kind = root_kinds
                .get(r)
                .or_else(|| root_kinds.get(&resolved_candidate))
                .copied();
            if !custom_predicates && !exists_fn(r) {
                match explicit_kind {
                    Some(WritableRootKind::File) => {
                        if let Some(parent) = r.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = OpenOptions::new().write(true).create_new(true).open(r);
                    }
                    Some(WritableRootKind::Directory) => {
                        let _ = std::fs::create_dir_all(r);
                    }
                    None => {}
                }
            }
        }

        // Mount ancestors before descendants (sorted by canonical component depth, then lexicographically)
        // so nested bind mounts never get masked even when a shorter symlink resolves deeper.
        let mut sorted_roots: Vec<(PathBuf, PathBuf)> = raw_roots
            .into_iter()
            .filter(|r| exists_fn(r))
            .map(|r| {
                let real = if custom_predicates {
                    r.clone()
                } else {
                    canonicalize_sync(&r)
                };
                (r, real)
            })
            .collect();
        sorted_roots.sort_by(|(_, a), (_, b)| {
            a.components()
                .count()
                .cmp(&b.components().count())
                .then_with(|| a.to_string_lossy().cmp(&b.to_string_lossy()))
        });

        let mut seen_writable: HashSet<PathBuf> = HashSet::new();
        let mut bound_dir_roots: Vec<PathBuf> = Vec::new();
        let mut metadata_scan_roots: Vec<PathBuf> = Vec::new();

        for (raw, real) in sorted_roots {
            if !seen_writable.insert(real.clone()) {
                continue;
            }
            let explicit_kind = root_kinds
                .get(&raw)
                .or_else(|| root_kinds.get(&real))
                .copied();
            let real_str = real.to_string_lossy().into_owned();
            args.push("--bind".to_owned());
            args.push(real_str.clone());
            args.push(real_str);

            if explicit_kind != Some(WritableRootKind::File) && is_dir_fn(&real) {
                // Scan/watch nested protected metadata strictly on explicit policy writable roots,
                // never on `/tmp` scratch roots appended by `with_tmp_scratch`.
                if explicit_scan_set.contains(&real) {
                    metadata_scan_roots.push(real.clone());
                }
                bound_dir_roots.push(real);
            }
        }

        let mut seen_ro: HashSet<PathBuf> = HashSet::new();
        let mut ro_targets: Vec<PathBuf> = Vec::new();
        // `lstat`-based so a symlinked or dangling `.git` / `.cowork` entry is never missed.
        let entry_exists = |p: &Path| {
            if custom_predicates {
                exists_fn(p)
            } else {
                std::fs::symlink_metadata(p).is_ok()
            }
        };
        let mut protect_entry = |entry: PathBuf| {
            for target in protected_entry_ro_targets(&entry, custom_predicates) {
                if seen_ro.insert(target.clone()) {
                    ro_targets.push(target);
                }
            }
        };

        for dir_root in &bound_dir_roots {
            for sub in PROTECTED_SUBDIRS {
                let direct = dir_root.join(sub);
                if entry_exists(&direct) {
                    protect_entry(direct);
                }
            }
        }

        if !metadata_scan_roots.is_empty() {
            let protected_paths = protected_metadata_paths(
                &metadata_scan_roots,
                ProtectedMetadataOptions {
                    platform: Some("linux"),
                    exists: opts.exists,
                    is_directory: opts.is_directory,
                    cache: if custom_predicates { None } else { opts.cache },
                },
            );
            for sub in protected_paths {
                protect_entry(sub);
            }
        }

        for sub_real in ro_targets {
            let sub_str = sub_real.to_string_lossy().into_owned();
            args.push("--ro-bind".to_owned());
            args.push(sub_str.clone());
            args.push(sub_str);
        }
    }

    // Credential read-deny masks go LAST so neither `--bind / /` (danger-full-access) nor a
    // writable workspace bind followed by `--ro-bind <ws>/.cowork` can re-expose them.
    push_read_deny_masks(
        &mut args,
        opts.read_denied_roots,
        custom_predicates,
        exists_fn,
        is_dir_fn,
    );

    let network_allowed = policy_allows_network(policy);
    args.extend(
        [
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--proc",
            "/proc",
        ]
        .map(str::to_owned),
    );
    if !network_allowed {
        args.push("--unshare-net".to_owned());
    }

    let self_exec = resolve_sandbox_exec_binary(opts.sandbox_exec_path);
    args.push("--chdir".to_owned());
    args.push(cwd.to_string_lossy().into_owned());
    args.push("--".to_owned());
    args.push(self_exec);
    args.push("__sandbox-exec".to_owned());
    args.push("--linux-seccomp".to_owned());
    if !network_allowed {
        args.push("--deny-network".to_owned());
    }
    args.push("--".to_owned());
    args.push(inner.file.clone());
    args.extend(inner.args.iter().cloned());

    let mut env = HashMap::new();
    env.insert(
        "COWORK_SANDBOX".to_owned(),
        SandboxType::Bwrap.as_str().to_owned(),
    );
    if !network_allowed {
        env.insert("COWORK_SANDBOX_NETWORK_DISABLED".to_owned(), "1".to_owned());
    }

    TransformedCommand {
        file: bwrap_path.to_string_lossy().into_owned(),
        args,
        env,
        sandbox: SandboxType::Bwrap,
        unsandboxed: false,
    }
}

/// Read-only bind targets protecting one existing `.git` / `.cowork` entry below a writable root.
///
/// A regular file/directory entry is re-bound read-only at its canonical path (a mount point
/// cannot be unlinked or renamed). A symlinked (or dangling) entry cannot be pinned that way:
/// `mount(2)` follows the link, so only its target would be frozen while the link itself stays
/// unlinkable through the writable parent (`rm .git && mkdir -p .git/hooks`). For those, the
/// directory holding the link is re-bound read-only (fail closed) and an existing link target is
/// frozen as well.
fn protected_entry_ro_targets(entry: &Path, custom_predicates: bool) -> Vec<PathBuf> {
    if custom_predicates {
        return vec![entry.to_path_buf()];
    }
    let is_symlink = std::fs::symlink_metadata(entry).is_ok_and(|m| m.file_type().is_symlink());
    if !is_symlink {
        return vec![canonicalize_sync(entry)];
    }
    let mut out = Vec::with_capacity(2);
    if let Some(parent) = entry.parent()
        && parent.is_absolute()
        && parent.parent().is_some()
    {
        out.push(canonicalize_sync(parent));
    }
    let target = canonicalize_sync(entry);
    if target != entry && std::fs::metadata(&target).is_ok() {
        out.push(target);
    }
    out
}

/// Appends `--tmpfs <dir> --remount-ro <dir>` (directories) or `--ro-bind /dev/null <file>`
/// (files) for each existing read-denied root, ancestors first, skipping roots already covered
/// by a masked ancestor.
fn push_read_deny_masks(
    args: &mut Vec<String>,
    read_denied_roots: &[PathBuf],
    custom_predicates: bool,
    exists_fn: &dyn Fn(&Path) -> bool,
    is_dir_fn: &dyn Fn(&Path) -> bool,
) {
    let mut targets: Vec<PathBuf> = read_denied_roots
        .iter()
        .filter(|r| !r.as_os_str().is_empty() && exists_fn(r))
        .map(|r| {
            if custom_predicates {
                r.clone()
            } else {
                canonicalize_sync(r)
            }
        })
        .filter(|r| r.is_absolute() && r.parent().is_some())
        .collect();
    targets.sort_by(|a, b| {
        a.components()
            .count()
            .cmp(&b.components().count())
            .then_with(|| a.cmp(b))
    });
    let mut masked: Vec<PathBuf> = Vec::new();
    for target in targets {
        if masked.iter().any(|m| target.starts_with(m)) {
            continue;
        }
        let target_str = target.to_string_lossy().into_owned();
        if is_dir_fn(&target) {
            args.extend([
                "--tmpfs".to_owned(),
                target_str.clone(),
                "--remount-ro".to_owned(),
                target_str,
            ]);
        } else {
            args.extend(["--ro-bind".to_owned(), "/dev/null".to_owned(), target_str]);
        }
        masked.push(target);
    }
}
