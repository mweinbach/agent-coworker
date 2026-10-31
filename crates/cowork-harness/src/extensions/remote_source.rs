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
                let mut rest = segments[4..].to_vec();
                if mode == "blob" && rest.last().copied() == Some("SKILL.md") {
                    rest.pop();
                }
                let subdir = if rest.is_empty() {
                    None
                } else {
                    Some(rest.join("/"))
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
            let mut rest = segments[3..].to_vec();
            if rest.last().copied() == Some("SKILL.md") {
                rest.pop();
            }
            return Ok(ParsedExtensionSource::GitHub {
                raw: trimmed.to_owned(),
                descriptor_kind: "github_raw".to_owned(),
                origin_kind: "github".to_owned(),
                owner,
                repo,
                git_ref: Some(git_ref),
                subdir: if rest.is_empty() {
                    None
                } else {
                    Some(rest.join("/"))
                },
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

        return Err(format!(
            "Unsupported remote URL host '{host}' in '{trimmed}'"
        ));
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
            let root_dir = if canonical.is_file() {
                canonical
                    .parent()
                    .ok_or_else(|| "Invalid local file path".to_owned())?
                    .to_path_buf()
            } else {
                canonical.clone()
            };
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
            let ref_to_resolve = git_ref.clone().unwrap_or_else(|| "HEAD".to_owned());

            let commit_url = format!("{api_base}/repos/{owner}/{repo}/commits/{ref_to_resolve}");
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
                if rel_inside.is_empty()
                    || rel_inside
                        .split('/')
                        .any(|seg| seg == ".." || seg == ".git")
                {
                    continue;
                }
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
                let dst = temp_dir.path().join(&rel_inside);
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
                    git_ref: Some(commit_resp.sha.clone()),
                    subdir: prefix.clone(),
                    ref_path: None,
                    local_path: None,
                    requested_skill_name: None,
                },
                origin: SkillOriginMetadata {
                    kind: origin_kind,
                    url: url_val,
                    repo: Some(repo_slug),
                    git_ref: Some(commit_resp.sha),
                    subdir: prefix,
                    source_path: None,
                    source_hash: None,
                },
                _temp_guard: Some(temp_dir),
            })
        }
    }
}
