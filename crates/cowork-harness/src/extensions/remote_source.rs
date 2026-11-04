use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tempfile::TempDir;
use url::Url;

use crate::extensions::types::{ExtensionSourceDescriptor, SkillOriginMetadata};

#[derive(Debug, Clone)]
pub enum ParsedExtensionSource {
    LocalPath {
        raw: String,
        path: PathBuf,
    },
    GitHub {
        raw: String,
        descriptor_kind: String,
        origin_kind: String,
        owner: String,
        repo: String,
        git_ref: Option<String>,
        subdir: Option<String>,
        raw_url: Option<String>,
    },
}

pub struct MaterializedSource {
    pub root_dir: PathBuf,
    pub descriptor: ExtensionSourceDescriptor,
    pub origin: SkillOriginMetadata,
    pub _temp_guard: Option<TempDir>,
}

pub fn parse_extension_source(
    raw: &str,
    cwd: &Path,
    homedir: &Path,
) -> Result<ParsedExtensionSource, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Source must not be empty.".to_owned());
    }

    if trimmed.starts_with('/')
        || trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.starts_with("~/")
    {
        let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
            homedir.join(rest)
        } else {
            let p = PathBuf::from(trimmed);
            if p.is_absolute() { p } else { cwd.join(p) }
        };
        return Ok(ParsedExtensionSource::LocalPath {
            raw: trimmed.to_owned(),
            path: expanded,
        });
    }
    let candidate_local = cwd.join(trimmed);
    if candidate_local.exists() {
        return Ok(ParsedExtensionSource::LocalPath {
            raw: trimmed.to_owned(),
            path: candidate_local,
        });
    }

    if let Ok(parsed_url) = Url::parse(trimmed) {
        return parse_remote_source_url(trimmed, &parsed_url);
    }

    let (path_part, explicit_ref) = match trimmed.split_once('#') {
        Some((p, r)) => (p, Some(r.to_owned())),
        None => (trimmed, None),
    };
    let parts: Vec<&str> = path_part.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 {
        let owner = parts[0].to_owned();
        let repo = parts[1].trim_end_matches(".git").to_owned();
        let subdir = if parts.len() > 2 {
            Some(parts[2..].join("/"))
        } else {
            None
        };
        return Ok(ParsedExtensionSource::GitHub {
            raw: trimmed.to_owned(),
            descriptor_kind: "github_shorthand".to_owned(),
            origin_kind: "github".to_owned(),
            owner,
            repo,
            git_ref: explicit_ref,
            subdir,
            raw_url: None,
        });
    }

    Err(format!("Unrecognized skill/plugin source: '{trimmed}'"))
}

fn parse_remote_source_url(
    trimmed: &str,
    parsed_url: &Url,
) -> Result<ParsedExtensionSource, String> {
    let host = parsed_url
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let segments: Vec<&str> = parsed_url
        .path_segments()
        .map(|c| c.filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    if host == "github.com" || host == "www.github.com" {
        if segments.len() < 2 {
            return Err(format!("Invalid GitHub URL: {trimmed}"));
        }
        let owner = segments[0].to_owned();
        let repo = segments[1].trim_end_matches(".git").to_owned();
        if segments.len() == 2 {
            return Ok(ParsedExtensionSource::GitHub {
                raw: trimmed.to_owned(),
                descriptor_kind: "github_repo".to_owned(),
                origin_kind: "github".to_owned(),
                owner,
                repo,
                git_ref: None,
                subdir: None,
                raw_url: Some(trimmed.to_owned()),
            });
        }
        let mode = segments[2];
        if (mode == "tree" || mode == "blob") && segments.len() >= 4 {
            let git_ref = segments[3].to_owned();
            let rest = &segments[4..];
            let subdir = if mode == "blob" {
                github_file_directory_path(rest)
            } else {
                github_tree_directory_path(rest)
            };
            return Ok(ParsedExtensionSource::GitHub {
                raw: trimmed.to_owned(),
                descriptor_kind: if mode == "blob" {
                    "github_blob".to_owned()
                } else {
                    "github_tree".to_owned()
                },
                origin_kind: "github".to_owned(),
                owner,
                repo,
                git_ref: Some(git_ref),
                subdir,
                raw_url: Some(trimmed.to_owned()),
            });
        }
        return Err(format!("Unsupported GitHub URL format: {trimmed}"));
    }

    if host == "raw.githubusercontent.com" && segments.len() >= 4 {
        let owner = segments[0].to_owned();
        let repo = segments[1].to_owned();
        let git_ref = segments[2].to_owned();
        return Ok(ParsedExtensionSource::GitHub {
            raw: trimmed.to_owned(),
            descriptor_kind: "github_raw".to_owned(),
            origin_kind: "github".to_owned(),
            owner,
            repo,
            git_ref: Some(git_ref),
            subdir: github_file_directory_path(&segments[3..]),
            raw_url: Some(trimmed.to_owned()),
        });
    }

    if (host == "skills.sh" || host == "www.skills.sh") && segments.len() >= 2 {
        let owner = segments[0].to_owned();
        let repo = segments[1].to_owned();
        let subdir = if segments.len() >= 3 {
            Some(format!("skills/{}", segments[2..].join("/")))
        } else {
            None
        };
        return Ok(ParsedExtensionSource::GitHub {
            raw: trimmed.to_owned(),
            descriptor_kind: "skills.sh".to_owned(),
            origin_kind: "skills.sh".to_owned(),
            owner,
            repo,
            git_ref: None,
            subdir,
            raw_url: Some(trimmed.to_owned()),
        });
    }

    Err(format!(
        "Unsupported remote URL host '{host}' in '{trimmed}'"
    ))
}

/// Ref encoded in a recorded remote source URL (`/tree/<ref>`, `/blob/<ref>`, raw), or `None`
/// when the URL names no ref (repo root, skills.sh) or is not a recognized remote source.
pub(crate) fn git_ref_from_source_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let parsed_url = Url::parse(trimmed).ok()?;
    match parse_remote_source_url(trimmed, &parsed_url).ok()? {
        ParsedExtensionSource::GitHub { git_ref, .. } => git_ref,
        ParsedExtensionSource::LocalPath { .. } => None,
    }
}

/// Plugin manifest directories whose `plugin.json` links resolve to the enclosing bundle root
/// (TS `PLUGIN_MANIFEST_DIR_NAMES`).
const PLUGIN_MANIFEST_DIR_NAMES: [&str; 2] = [".cowork-plugin", ".codex-plugin"];

fn is_plugin_manifest_dir_name(name: &str) -> bool {
    PLUGIN_MANIFEST_DIR_NAMES.contains(&name)
}

fn join_subdir(segments: &[&str]) -> Option<String> {
    (!segments.is_empty()).then(|| segments.join("/"))
}

/// TS `normalizePluginGitHubDirectoryPath`: blob and raw URLs always name a file, so the source
/// is its directory — except a `.cowork-plugin/plugin.json` or `.codex-plugin/plugin.json`
/// manifest link, which resolves to the enclosing bundle root.
fn github_file_directory_path(file_segments: &[&str]) -> Option<String> {
    let (file_name, mut dir) = file_segments.split_last()?;
    if *file_name == "plugin.json"
        && let Some((manifest_dir, bundle_root)) = dir.split_last()
        && is_plugin_manifest_dir_name(manifest_dir)
    {
        dir = bundle_root;
    }
    join_subdir(dir)
}

/// TS `normalizePluginGitHubTreePath`: a tree URL that points at a plugin manifest directory
/// resolves to the enclosing bundle root.
fn github_tree_directory_path(dir_segments: &[&str]) -> Option<String> {
    match dir_segments.split_last() {
        Some((last, bundle_root)) if is_plugin_manifest_dir_name(last) => join_subdir(bundle_root),
        _ => join_subdir(dir_segments),
    }
}

/// TS `normalizeLocalPluginSourceRoot`: a local plugin manifest directory, or its `plugin.json`,
/// resolves to the enclosing bundle root.
fn normalize_local_source_root(path: &Path, is_file: bool) -> Option<PathBuf> {
    let candidate_root = if is_file { path.parent()? } else { path };
    let in_manifest_dir = candidate_root
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_plugin_manifest_dir_name);
    let names_manifest =
        !is_file || path.file_name().and_then(|n| n.to_str()) == Some("plugin.json");
    if in_manifest_dir
        && names_manifest
        && let Some(bundle_root) = candidate_root.parent()
    {
        return Some(bundle_root.to_path_buf());
    }
    Some(candidate_root.to_path_buf())
}

/// GitHub `default_branch` from repo metadata (TS `fetchGitHubDefaultBranch`). `None` when the
/// metadata is unavailable; the caller then resolves the repository's `HEAD`.
async fn fetch_github_default_branch(
    client: &reqwest::Client,
    api_base: &str,
    owner: &str,
    repo: &str,
) -> Option<String> {
    let resp = client
        .get(format!("{api_base}/repos/{owner}/{repo}"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let meta: GitHubRepoMetaResp = resp.json().await.ok()?;
    meta.default_branch
        .map(|b| b.trim().to_owned())
        .filter(|b| !b.is_empty())
}

pub fn github_api_base(env: &HashMap<String, String>) -> String {
    env.get("COWORK_GITHUB_API_BASE_URL")
        .map(|s| s.trim_end_matches('/').to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.github.com".to_owned())
}

pub fn github_raw_base(env: &HashMap<String, String>) -> String {
    env.get("COWORK_GITHUB_RAW_BASE_URL")
        .map(|s| s.trim_end_matches('/').to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://raw.githubusercontent.com".to_owned())
}

pub fn is_network_allowed_for_github(env: &HashMap<String, String>) -> bool {
    let api = github_api_base(env);
    let raw = github_raw_base(env);
    let is_loopback = |u: &str| {
        Url::parse(u)
            .ok()
            .and_then(|p| {
                p.host_str()
                    .map(|h| h == "127.0.0.1" || h == "localhost" || h == "::1")
            })
            .unwrap_or(false)
    };
    if is_loopback(&api) && is_loopback(&raw) {
        return true;
    }
    env.get("COWORK_RUNTIME_ALLOW_NETWORK")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

#[derive(Debug, Deserialize)]
struct GitHubCommitResp {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRepoMetaResp {
    #[serde(default)]
    default_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubTreeEntry {
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
}

#[derive(Debug, Deserialize)]
struct GitHubTreeResp {
    tree: Vec<GitHubTreeEntry>,
}

pub async fn fetch_github_raw_text(
    env: &HashMap<String, String>,
    owner: &str,
    repo: &str,
    git_ref: &str,
    rel_path: &str,
) -> Result<String, String> {
    if !is_network_allowed_for_github(env) {
        return Err("Network access is disabled by COWORK_RUNTIME_ALLOW_NETWORK=0.".to_owned());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("cowork-harness/0.2")
        .build()
        .map_err(|e| e.to_string())?;
    let raw_base = github_raw_base(env);
    let clean_rel = rel_path.trim_start_matches('/');
    let url = format!("{raw_base}/{owner}/{repo}/{git_ref}/{clean_rel}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GitHub raw fetch failed ({url}): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub raw fetch returned HTTP {} for {url}",
            resp.status()
        ));
    }
    resp.text()
        .await
        .map_err(|e| format!("Failed reading GitHub raw body: {e}"))
}

pub async fn materialize_source(
    raw_source: &str,
    cwd: &Path,
    homedir: &Path,
    env: &HashMap<String, String>,
) -> Result<MaterializedSource, String> {
    match parse_extension_source(raw_source, cwd, homedir)? {
        ParsedExtensionSource::LocalPath { raw, path } => {
            let canonical = fs::canonicalize(&path)
                .map_err(|e| format!("Local path '{}' does not exist: {e}", path.display()))?;
            let root_dir = normalize_local_source_root(&canonical, canonical.is_file())
                .ok_or_else(|| "Invalid local file path".to_owned())?;
            let local_str = root_dir.to_string_lossy().into_owned();
            Ok(MaterializedSource {
                descriptor: ExtensionSourceDescriptor {
                    kind: "local_path".to_owned(),
                    raw,
                    display_source: local_str.clone(),
                    url: None,
                    repo: None,
                    git_ref: None,
                    subdir: None,
                    ref_path: None,
                    local_path: Some(local_str.clone()),
                    requested_skill_name: None,
                },
                origin: SkillOriginMetadata {
                    kind: "local".to_owned(),
                    url: None,
                    repo: None,
                    git_ref: None,
                    subdir: None,
                    source_path: Some(local_str),
                    source_hash: None,
                    commit_sha: None,
                },
                root_dir,
                _temp_guard: None,
            })
        }
        ParsedExtensionSource::GitHub {
            raw,
            descriptor_kind,
            origin_kind,
            owner,
            repo,
            git_ref,
            subdir,
            raw_url,
        } => {
            if !is_network_allowed_for_github(env) {
                return Err(
                    "Remote GitHub fetch blocked because COWORK_RUNTIME_ALLOW_NETWORK=0."
                        .to_owned(),
                );
            }
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .user_agent("cowork-harness/0.2")
                .build()
                .map_err(|e| e.to_string())?;
            let api_base = github_api_base(env);
            let raw_base = github_raw_base(env);
            // The requested ref (an explicit branch/tag/SHA, else the default branch) is what an
            // update re-resolves; the commit SHA it points at now only pins this download so every
            // file comes from one consistent snapshot.
            let requested_ref = match git_ref {
                Some(r) => r,
                None => fetch_github_default_branch(&client, &api_base, &owner, &repo)
                    .await
                    .unwrap_or_else(|| "HEAD".to_owned()),
            };

            let commit_url = format!("{api_base}/repos/{owner}/{repo}/commits/{requested_ref}");
            let commit_resp: GitHubCommitResp = client
                .get(&commit_url)
                .send()
                .await
                .map_err(|e| format!("GitHub commit lookup failed: {e}"))?
                .error_for_status()
                .map_err(|e| format!("GitHub commit lookup error: {e}"))?
                .json()
                .await
                .map_err(|e| format!("Invalid GitHub commit response: {e}"))?;

            let tree_url = format!(
                "{api_base}/repos/{owner}/{repo}/git/trees/{}?recursive=1",
                commit_resp.sha
            );
            let tree_resp: GitHubTreeResp = client
                .get(&tree_url)
                .send()
                .await
                .map_err(|e| format!("GitHub tree lookup failed: {e}"))?
                .error_for_status()
                .map_err(|e| format!("GitHub tree lookup error: {e}"))?
                .json()
                .await
                .map_err(|e| format!("Invalid GitHub tree response: {e}"))?;

            let prefix = subdir
                .as_deref()
                .map(|s| s.trim_matches('/').to_owned())
                .filter(|s| !s.is_empty());

            let temp_dir = tempfile::Builder::new()
                .prefix("cowork-gh-src-")
                .tempdir_in("/private/tmp")
                .or_else(|_| tempfile::tempdir())
                .map_err(|e| format!("Failed creating temp staging dir: {e}"))?;

            let mut downloaded = 0usize;
            for entry in &tree_resp.tree {
                if entry.entry_type != "blob" {
                    continue;
                }
                let rel_inside = if let Some(ref pfx) = prefix {
                    let want = format!("{pfx}/");
                    if let Some(stripped) = entry.path.strip_prefix(&want) {
                        stripped.to_owned()
                    } else {
                        continue;
                    }
                } else {
                    entry.path.clone()
                };
                let Some(rel_path) = portable_relative_blob_path(&rel_inside) else {
                    continue;
                };
                let file_url = format!(
                    "{raw_base}/{owner}/{repo}/{}/{}",
                    commit_resp.sha, entry.path
                );
                let bytes = client
                    .get(&file_url)
                    .send()
                    .await
                    .map_err(|e| format!("Failed fetching {file_url}: {e}"))?
                    .error_for_status()
                    .map_err(|e| format!("HTTP error fetching {file_url}: {e}"))?
                    .bytes()
                    .await
                    .map_err(|e| e.to_string())?;
                let dst = temp_dir.path().join(&rel_path);
                if !dst.starts_with(temp_dir.path()) {
                    continue;
                }
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&dst, &bytes).map_err(|e| e.to_string())?;
                downloaded += 1;
            }

            if downloaded == 0 {
                return Err(format!(
                    "No files found in GitHub repository {owner}/{repo} under '{}'",
                    prefix.as_deref().unwrap_or("/")
                ));
            }

            let repo_slug = format!("{owner}/{repo}");
            let display_source = match prefix {
                Some(ref sub) => format!("{repo_slug}/{sub}"),
                None => repo_slug.clone(),
            };
            let url_val = raw_url.or_else(|| Some(format!("https://github.com/{repo_slug}")));
            let root_dir = temp_dir.path().to_path_buf();

            Ok(MaterializedSource {
                root_dir,
                descriptor: ExtensionSourceDescriptor {
                    kind: descriptor_kind,
                    raw,
                    display_source,
                    url: url_val.clone(),
                    repo: Some(repo_slug.clone()),
                    git_ref: Some(requested_ref.clone()),
                    subdir: prefix.clone(),
                    ref_path: None,
                    local_path: None,
                    requested_skill_name: None,
                },
                origin: SkillOriginMetadata {
                    kind: origin_kind,
                    url: url_val,
                    repo: Some(repo_slug),
                    git_ref: Some(requested_ref),
                    subdir: prefix,
                    source_path: None,
                    source_hash: None,
                    commit_sha: Some(commit_resp.sha),
                },
                _temp_guard: Some(temp_dir),
            })
        }
    }
}

/// Converts a GitHub tree entry path into a relative path that can only name a
/// location beneath the extraction root on every platform. Rejects empty, `.`,
/// `..` and `.git` segments, backslashes, and any `:` (Windows drive prefixes
/// such as `C:` and alternate data streams), so `Path::join` can never replace
/// the root with an absolute or drive-qualified path.
fn portable_relative_blob_path(rel: &str) -> Option<std::path::PathBuf> {
    let mut out = std::path::PathBuf::new();
    for seg in rel.split('/') {
        if seg.is_empty()
            || seg == "."
            || seg == ".."
            || seg == ".git"
            || seg.contains(['\\', ':', '\0'])
        {
            return None;
        }
        out.push(seg);
    }
    if out.as_os_str().is_empty()
        || !out
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod source_url_normalization_tests {
    use std::path::Path;

    use super::{ParsedExtensionSource, git_ref_from_source_url, parse_extension_source};

    fn parsed_ref_and_subdir(raw: &str) -> (Option<String>, Option<String>) {
        let missing = Path::new("/nonexistent-cowork-source-test");
        match parse_extension_source(raw, missing, missing).unwrap() {
            ParsedExtensionSource::GitHub {
                git_ref, subdir, ..
            } => (git_ref, subdir),
            other => panic!("{raw:?} parsed as {other:?}"),
        }
    }

    #[test]
    fn plugin_manifest_links_resolve_to_the_bundle_root() {
        for (raw, subdir) in [
            (
                "https://github.com/acme/ext/blob/main/plugins/suite/.cowork-plugin/plugin.json",
                Some("plugins/suite"),
            ),
            (
                "https://github.com/acme/ext/blob/main/plugins/suite/.codex-plugin/plugin.json",
                Some("plugins/suite"),
            ),
            (
                "https://raw.githubusercontent.com/acme/ext/main/plugins/suite/.cowork-plugin/plugin.json",
                Some("plugins/suite"),
            ),
            (
                "https://raw.githubusercontent.com/acme/ext/main/.codex-plugin/plugin.json",
                None,
            ),
            (
                "https://github.com/acme/ext/blob/main/.cowork-plugin/plugin.json",
                None,
            ),
            (
                "https://github.com/acme/ext/tree/main/plugins/suite/.codex-plugin",
                Some("plugins/suite"),
            ),
            ("https://github.com/acme/ext/tree/main/.cowork-plugin", None),
            // Other files resolve to their directory (TS `path.posix.dirname`).
            (
                "https://github.com/acme/ext/blob/main/skills/review/SKILL.md",
                Some("skills/review"),
            ),
            (
                "https://github.com/acme/ext/blob/main/plugins/suite/.cowork-plugin/install.json",
                Some("plugins/suite/.cowork-plugin"),
            ),
            (
                "https://github.com/acme/ext/tree/main/plugins/suite",
                Some("plugins/suite"),
            ),
        ] {
            let (git_ref, got) = parsed_ref_and_subdir(raw);
            assert_eq!(git_ref.as_deref(), Some("main"), "{raw}");
            assert_eq!(got.as_deref(), subdir, "{raw}");
        }
    }

    #[test]
    fn recorded_source_urls_yield_their_requested_ref() {
        assert_eq!(
            git_ref_from_source_url("https://github.com/acme/ext/tree/main/skills/a").as_deref(),
            Some("main")
        );
        assert_eq!(
            git_ref_from_source_url("https://raw.githubusercontent.com/acme/ext/v2/SKILL.md")
                .as_deref(),
            Some("v2")
        );
        assert_eq!(git_ref_from_source_url("https://github.com/acme/ext"), None);
        assert_eq!(
            git_ref_from_source_url("https://skills.sh/acme/ext/a"),
            None
        );
        assert_eq!(git_ref_from_source_url("acme/ext"), None);
    }
}

#[cfg(test)]
mod portable_blob_path_tests {
    use super::portable_relative_blob_path;

    #[test]
    fn rejects_drive_qualified_absolute_and_traversal_paths() {
        for bad in [
            "",
            "/etc/passwd",
            "C:/Users/victim/AppData/Roaming/Startup/pwn.cmd",
            "c:pwn.cmd",
            "skills/../../escape",
            "a/./b",
            "a//b",
            ".git/config",
            "a\\b",
            "file.txt:stream",
        ] {
            assert!(
                portable_relative_blob_path(bad).is_none(),
                "{bad:?} must be rejected"
            );
        }
        let ok = portable_relative_blob_path("skills/review/SKILL.md").unwrap();
        assert_eq!(
            ok,
            std::path::Path::new("skills")
                .join("review")
                .join("SKILL.md")
        );
    }
}
