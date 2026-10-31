//! Native Rust Presentation preview service (`src/server/presentationPreview.ts` parity)
//! backing `cowork/workspace/presentation/preview`.
//!
//! Renders `.pptx` / `.ppt` slide previews via sandboxed `SofficeRunner` + `pdftoppm` when
//! available, with deterministic text-only SVG fallback for `.pptx` when native runtime
//! rendering is unavailable or fails.

use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cowork_config::canonicalize_sync;
use cowork_env::{
    PdftoppmJobRequest, SofficeConvertRequest, SofficeRunner, TrustedKeyRing,
    verify_installed_runtime,
};
use cowork_sandbox::scratch_roots;
use cowork_storage::sha256_hex;
use data_encoding::BASE64;
use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ooxml::{
    FileChangeVersion, OUTSIDE_WORKSPACE_MESSAGE, PptxExtractOptions, PptxSlide,
    WorkspacePathError, extract_pptx_snapshot_with_options, file_change_version_from_metadata,
    resolve_workspace_file_path,
};

pub const MAX_PRESENTATION_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_PRESENTATION_SLIDES: usize = 200;
pub const MAX_SLIDE_IMAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TOTAL_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const PREVIEW_TIMEOUT_MS: u64 = 25_000;
pub const TEXT_PREVIEW_WARNING: &str = "Text-only preview: images, charts, layout, and original styling are not shown. Long slide text may be shortened.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationSlide {
    pub slide_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slide_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub png_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationPreviewErrorPayload {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PresentationPreviewResult {
    Ok {
        ok: bool,
        dependencies: Vec<String>,
        path: String,
        slides: Vec<PresentationSlide>,
        version: FileChangeVersion,
        #[serde(rename = "renderingMode", skip_serializing_if = "Option::is_none")]
        rendering_mode: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        warnings: Option<Vec<String>>,
    },
    Err {
        ok: bool,
        error: PresentationPreviewErrorPayload,
    },
}

impl PresentationPreviewResult {
    pub fn err(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            error: PresentationPreviewErrorPayload {
                kind: kind.into(),
                message: message.into(),
            },
        }
    }
}

pub struct PresentationPreviewRequest<'a> {
    pub cwd: &'a Path,
    pub file_path: &'a str,
    pub soffice_runner: Option<&'a SofficeRunner>,
    pub env: &'a HashMap<String, String>,
    pub trusted_keys: Option<&'a cowork_env::TrustedKeyRing>,
    pub timeout_ms: Option<u64>,
}

pub async fn preview_presentation_file(
    req: PresentationPreviewRequest<'_>,
) -> PresentationPreviewResult {
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(PREVIEW_TIMEOUT_MS).max(1));
    let deadline = Instant::now() + timeout;

    let resolved = match resolve_workspace_file_path(req.cwd, req.file_path) {
        Ok(p) => p,
        Err(WorkspacePathError::OutsideWorkspace) => {
            return PresentationPreviewResult::err("compile_error", OUTSIDE_WORKSPACE_MESSAGE);
        }
        Err(WorkspacePathError::NotFound) => {
            return PresentationPreviewResult::err(
                "compile_error",
                "Spreadsheet file was not found.".replacen("Spreadsheet", "Presentation", 1),
            );
        }
        Err(WorkspacePathError::Io(m)) => {
            return PresentationPreviewResult::err("compile_error", m);
        }
    };

    let ext = resolved
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_ascii_lowercase()))
        .unwrap_or_default();

    if ext != ".pptx" && ext != ".ppt" {
        return PresentationPreviewResult::err(
            "unsupported_format",
            "Presentation preview supports exported PowerPoint decks (.pptx or .ppt). Export JavaScript slide sources first; opening a preview does not execute workspace code.",
        );
    }

    let (bytes, mut version) = match read_stable_presentation_bytes(&resolved) {
        Ok(pair) => pair,
        Err(msg) => return PresentationPreviewResult::err("compile_error", msg),
    };
    version.fingerprint = format!("sha256:{}", sha256_hex(&bytes));

    let packaged_slides: Option<Vec<PptxSlide>> = if ext == ".pptx" {
        let bytes_clone = bytes.clone();
        let parsed = tokio::task::spawn_blocking(move || {
            extract_pptx_snapshot_with_options(
                &bytes_clone,
                &PptxExtractOptions {
                    max_slides: Some(MAX_PRESENTATION_SLIDES),
                    include_media: false,
                },
            )
        })
        .await;
        match parsed {
            Ok(Ok(snap)) => Some(snap.slides),
            Ok(Err(msg)) => {
                let kind = if msg.contains("does not contain any slides") {
                    "no_slides"
                } else {
                    "compile_error"
                };
                return PresentationPreviewResult::err(kind, msg);
            }
            Err(e) => return PresentationPreviewResult::err("compile_error", e.to_string()),
        }
    } else {
        None
    };

    if Instant::now() >= deadline {
        return PresentationPreviewResult::err("compile_error", "Presentation preview timed out.");
    }

    let resolved_str = resolved.to_string_lossy().into_owned();
    let mut warning = "The verified native presentation renderer is unavailable.".to_owned();

    if let Some(runner) = req.soffice_runner {
        match resolve_verified_native_runtime(req.env, req.trusted_keys) {
            Ok(Some(verified_env)) => {
                match render_native_slides(
                    runner,
                    &verified_env,
                    &bytes,
                    &ext,
                    packaged_slides.as_deref(),
                    deadline,
                )
                .await
                {
                    Ok(slides) => {
                        return PresentationPreviewResult::Ok {
                            ok: true,
                            dependencies: vec![resolved_str.clone()],
                            path: resolved_str,
                            slides,
                            version,
                            rendering_mode: Some("rendered".to_owned()),
                            warnings: Some(Vec::new()),
                        };
                    }
                    Err(err) => {
                        if Instant::now() >= deadline {
                            return PresentationPreviewResult::err(
                                "compile_error",
                                "Presentation preview timed out.",
                            );
                        }
                        warning = format!("Native rendering failed: {err}");
                    }
                }
            }
            Ok(None) => {}
            Err(err) => {
                warning = format!("Native rendering failed: {err}");
            }
        }
    }

    let Some(packaged) = packaged_slides else {
        return PresentationPreviewResult::err(
            "unsupported_format",
            format!("{warning} Export this legacy .ppt deck to .pptx for a text-only preview."),
        );
    };

    let slides: Vec<PresentationSlide> = packaged.iter().map(render_text_slide).collect();
    PresentationPreviewResult::Ok {
        ok: true,
        dependencies: vec![resolved_str.clone()],
        path: resolved_str,
        slides,
        version,
        rendering_mode: Some("text".to_owned()),
        warnings: Some(vec![warning, TEXT_PREVIEW_WARNING.to_owned()]),
    }
}

fn find_runtime_root_from_binary_path(raw_path: &str) -> Option<PathBuf> {
    let mut cur = Path::new(raw_path.trim()).parent();
    while let Some(dir) = cur {
        if dir.join("runtime.json").is_file() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

fn resolve_verified_native_runtime(
    env: &HashMap<String, String>,
    trusted_keys: Option<&TrustedKeyRing>,
) -> Result<Option<HashMap<String, String>>, String> {
    let clean = |k: &str| {
        env.get(k)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let raw_runtime_dir = clean("COWORK_RUNTIME_DIR");
    let raw_soffice = clean("COWORK_RUNTIME_SOFFICE");
    let raw_pdftoppm = clean("COWORK_RUNTIME_PDFTOPPM");
    let raw_poppler_bin = clean("COWORK_RUNTIME_POPPLER_BIN");

    if raw_runtime_dir.is_none()
        && raw_soffice.is_none()
        && raw_pdftoppm.is_none()
        && raw_poppler_bin.is_none()
    {
        return Ok(None);
    }

    let candidate_root = if let Some(ref rt_dir) = raw_runtime_dir {
        PathBuf::from(rt_dir)
    } else if let Some(root) = raw_soffice
        .as_deref()
        .and_then(find_runtime_root_from_binary_path)
        .or_else(|| {
            raw_pdftoppm
                .as_deref()
                .and_then(find_runtime_root_from_binary_path)
        })
        .or_else(|| {
            raw_poppler_bin
                .as_deref()
                .and_then(find_runtime_root_from_binary_path)
        })
    {
        root
    } else {
        return Err(
            "Managed Cowork runtime manifest (runtime.json) is missing; refusing to execute unverified presentation binaries."
                .to_owned(),
        );
    };

    let default_ring;
    let ring = match trusted_keys {
        Some(r) => r,
        None => {
            default_ring = TrustedKeyRing::with_official_defaults();
            &default_ring
        }
    };

    let prepared = verify_installed_runtime(&candidate_root, ring, true)
        .map_err(|e| format!("Managed runtime integrity verification failed: {e}"))?;

    let Some(verified_soffice) = prepared.paths.soffice.clone() else {
        return Ok(None);
    };
    let pdftoppm_exe = if cfg!(windows) {
        "pdftoppm.exe"
    } else {
        "pdftoppm"
    };
    let verified_pdftoppm = prepared.paths.pdftoppm.clone().or_else(|| {
        prepared
            .paths
            .poppler_bin
            .as_ref()
            .map(|dir| dir.join(pdftoppm_exe))
    });
    let Some(verified_pdftoppm) = verified_pdftoppm else {
        return Ok(None);
    };
    if !verified_soffice.is_file() || !verified_pdftoppm.is_file() {
        return Err(
            "Verified runtime is missing required soffice or pdftoppm entrypoints.".to_owned(),
        );
    }
    if let Some(ref env_soffice) = raw_soffice
        && canonicalize_sync(Path::new(env_soffice)) != canonicalize_sync(&verified_soffice)
    {
        return Err(
            "COWORK_RUNTIME_SOFFICE does not match the verified runtime soffice entrypoint."
                .to_owned(),
        );
    }
    if let Some(ref env_pdftoppm) = raw_pdftoppm
        && canonicalize_sync(Path::new(env_pdftoppm)) != canonicalize_sync(&verified_pdftoppm)
    {
        return Err(
            "COWORK_RUNTIME_PDFTOPPM does not match the verified runtime pdftoppm entrypoint."
                .to_owned(),
        );
    }

    let mut verified_env = env.clone();
    verified_env.insert(
        "COWORK_RUNTIME_DIR".to_owned(),
        prepared.root_dir.to_string_lossy().into_owned(),
    );
    verified_env.insert(
        "COWORK_RUNTIME_SOFFICE".to_owned(),
        verified_soffice.to_string_lossy().into_owned(),
    );
    verified_env.insert(
        "COWORK_RUNTIME_PDFTOPPM".to_owned(),
        verified_pdftoppm.to_string_lossy().into_owned(),
    );
    if let Some(ref poppler_bin) = prepared.paths.poppler_bin {
        verified_env.insert(
            "COWORK_RUNTIME_POPPLER_BIN".to_owned(),
            poppler_bin.to_string_lossy().into_owned(),
        );
    }
    Ok(Some(verified_env))
}

fn read_stable_presentation_bytes(path: &Path) -> Result<(Vec<u8>, FileChangeVersion), String> {
    let before = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if before.file_type().is_symlink() || !before.is_file() || before.len() > MAX_PRESENTATION_BYTES
    {
        return Err("Presentation exceeds the 100 MiB preview limit or is not a file.".to_owned());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_PRESENTATION_BYTES {
        return Err("Presentation exceeds the 100 MiB preview limit or is not a file.".to_owned());
    }
    let after = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !after.is_file() || after.len() != bytes.len() as u64 {
        return Err("File changed or was replaced while the preview was being read.".to_owned());
    }
    Ok((bytes, file_change_version_from_metadata(&after)))
}

async fn render_native_slides(
    runner: &SofficeRunner,
    env: &HashMap<String, String>,
    bytes: &[u8],
    ext: &str,
    packaged_slides: Option<&[PptxSlide]>,
    deadline: Instant,
) -> Result<Vec<PresentationSlide>, String> {
    let base_scratch = scratch_roots(env.get("TMPDIR").map(String::as_str))
        .into_iter()
        .next()
        .unwrap_or_else(std::env::temp_dir);
    let raw_stage = base_scratch.join(format!("cowork-presentation-{}", Uuid::new_v4()));
    fs::create_dir_all(&raw_stage).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let _ = fs::set_permissions(&raw_stage, fs::Permissions::from_mode(0o700));
    let stage = canonicalize_sync(&raw_stage);

    struct StageCleanup(PathBuf);
    impl Drop for StageCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _guard = StageCleanup(stage.clone());

    let source_path = stage.join(format!("source{ext}"));
    let scratch_dir = stage.join("scratch");
    fs::create_dir_all(&scratch_dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let _ = fs::set_permissions(&scratch_dir, fs::Permissions::from_mode(0o700));
    fs::write(&source_path, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let _ = fs::set_permissions(&source_path, fs::Permissions::from_mode(0o600));

    let rem1 = deadline.saturating_duration_since(Instant::now());
    if rem1.is_zero() {
        return Err("Presentation preview timed out.".to_owned());
    }

    let conv = runner
        .convert_document(SofficeConvertRequest {
            input_path: source_path,
            output_dir: scratch_dir.clone(),
            convert_to: "pdf".to_owned(),
            extra_args: Vec::new(),
            cwd: scratch_dir.clone(),
            env: env.clone(),
            timeout: Some(rem1),
        })
        .await
        .map_err(|e| e.to_string())?;

    let pdf_meta = fs::symlink_metadata(&conv.output_path).map_err(|e| e.to_string())?;
    if pdf_meta.file_type().is_symlink()
        || !pdf_meta.is_file()
        || pdf_meta.len() == 0
        || pdf_meta.len() > MAX_PRESENTATION_BYTES
    {
        return Err("Native renderer did not produce a bounded PDF.".to_owned());
    }

    let rem2 = deadline.saturating_duration_since(Instant::now());
    if rem2.is_zero() {
        return Err("Presentation preview timed out.".to_owned());
    }

    let _ = runner
        .render_pdf_pages(PdftoppmJobRequest {
            pdf_path: conv.output_path,
            output_dir: scratch_dir.clone(),
            dpi: 150,
            first_page: Some(1),
            last_page: Some((MAX_PRESENTATION_SLIDES + 1) as u32),
            cwd: scratch_dir.clone(),
            env: env.clone(),
            timeout: Some(rem2),
        })
        .await
        .map_err(|e| e.to_string())?;

    static PAGE_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let page_re = PAGE_RE.get_or_init(|| Regex::new(r"^(?:page|slide)-0*(\d+)\.png$").unwrap());
    let mut numbered_images: Vec<(usize, PathBuf)> = Vec::new();
    for entry in fs::read_dir(&scratch_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(caps) = page_re.captures(&name)
            && let Ok(num) = caps[1].parse::<usize>()
        {
            numbered_images.push((num, entry.path()));
        }
    }
    numbered_images.sort_by_key(|(n, _)| *n);

    if numbered_images.is_empty()
        || numbered_images.len() > MAX_PRESENTATION_SLIDES
        || numbered_images
            .iter()
            .enumerate()
            .any(|(idx, (num, _))| *num != idx + 1)
        || packaged_slides.is_some_and(|ps| ps.len() != numbered_images.len())
    {
        return Err(
            "Native renderer did not produce every slide. No partial render was used.".to_owned(),
        );
    }

    let mut total_bytes = 0usize;
    let mut slides = Vec::with_capacity(numbered_images.len());
    const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

    for (index, (_, img_path)) in numbered_images.into_iter().enumerate() {
        let img_meta = fs::symlink_metadata(&img_path).map_err(|e| e.to_string())?;
        if img_meta.file_type().is_symlink()
            || !img_meta.is_file()
            || img_meta.len() as usize > MAX_SLIDE_IMAGE_BYTES
        {
            return Err("Rendered slide images exceed preview limits or are invalid.".to_owned());
        }
        let img_bytes = fs::read(&img_path).map_err(|e| e.to_string())?;
        total_bytes = total_bytes.saturating_add(img_bytes.len());
        if img_bytes.len() > MAX_SLIDE_IMAGE_BYTES
            || total_bytes > MAX_TOTAL_IMAGE_BYTES
            || !img_bytes.starts_with(&PNG_SIG)
        {
            return Err("Rendered slide images exceed preview limits or are invalid.".to_owned());
        }
        let packaged = packaged_slides.and_then(|ps| ps.get(index));
        let title = packaged
            .and_then(|s| s.shapes.iter().find(|sh| !sh.text.trim().is_empty()))
            .map(|sh| truncate_chars(&sh.text, 200))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| format!("Slide {}", index + 1));

        slides.push(PresentationSlide {
            slide_index: index,
            slide_id: Some(
                packaged
                    .map(|s| s.id.clone())
                    .unwrap_or_else(|| (index + 1).to_string()),
            ),
            title: Some(title),
            png_base64: format!("data:image/png;base64,{}", BASE64.encode(&img_bytes)),
        });
    }

    Ok(slides)
}

pub fn render_text_slide(slide: &PptxSlide) -> PresentationSlide {
    let capped_text = truncate_chars(&slide.text, 10_000);
    let mut lines: Vec<String> = Vec::new();
    for word in capped_text.split_whitespace() {
        if let Some(last) = lines.last_mut() {
            if last.chars().count() + word.chars().count() < 88 {
                last.push(' ');
                last.push_str(word);
            } else {
                lines.push(word.to_owned());
            }
        } else {
            lines.push(word.to_owned());
        }
        if lines.len() > 18 {
            break;
        }
    }

    let truncated = lines.len() > 18 || slide.text.chars().count() > 10_000;
    let mut visible: Vec<String> = lines.into_iter().take(18).collect();
    if truncated && visible.len() == 18 {
        visible[17] = "… More slide text omitted".to_owned();
    }

    let tspans: String = visible
        .iter()
        .enumerate()
        .map(|(idx, line)| {
            let dy = if idx == 0 { 0 } else { 38 };
            format!(
                r#"<tspan x="80" dy="{dy}">{}</tspan>"#,
                escape_slide_svg(line)
            )
        })
        .collect();

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="white"/><text x="80" y="70" font-family="Arial,sans-serif" font-size="24" fill="#666">Slide {} · Text-only preview</text><text x="80" y="132" font-family="Arial,sans-serif" font-size="30" fill="#202124">{tspans}</text></svg>"##,
        slide.index + 1
    );

    let title = slide
        .shapes
        .iter()
        .find(|sh| !sh.text.trim().is_empty())
        .map(|sh| truncate_chars(&sh.text, 200))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| format!("Slide {}", slide.index + 1));

    PresentationSlide {
        slide_index: slide.index,
        slide_id: Some(slide.id.clone()),
        title: Some(title),
        png_base64: format!(
            "data:image/svg+xml;base64,{}",
            BASE64.encode(svg.as_bytes())
        ),
    }
}

fn escape_slide_svg(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_owned()
    } else {
        value.chars().take(max_chars).collect()
    }
}
