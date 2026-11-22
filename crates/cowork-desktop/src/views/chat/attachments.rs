//! Shared attachment cards for composer drafts and sent user message bubbles.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use base64::Engine as _;
use cowork_protocol::TurnAttachmentInputPart;
use rune::{El, Image, ImageCache, SurfaceFit, col, el, icon, row, text};
use rune_kit::Kit;

use crate::theme::ThemeTokens;

use super::icons;
use super::model::{AttachmentCategory, AttachmentDisplayInfo, attachment_display_info};

fn shared_image_cache() -> &'static ImageCache {
    static CACHE: OnceLock<ImageCache> = OnceLock::new();
    CACHE.get_or_init(|| ImageCache::new(Arc::new(|| {})))
}

/// Splits a filename into `(stem, Some(".ext"))` when a non-leading extension exists.
pub fn split_filename_extension(filename: &str) -> (&str, Option<&str>) {
    match filename.rfind('.') {
        Some(idx) if idx > 0 && idx < filename.len() - 1 => {
            (&filename[..idx], Some(&filename[idx..]))
        }
        _ => (filename, None),
    }
}

/// Pre-normalized and canonicalized workspace root for repeated local-path checks.
pub(super) struct CanonicalBase {
    normalized: PathBuf,
    canonical: PathBuf,
}

impl CanonicalBase {
    pub(super) fn from_path(base_path: &str) -> Option<Self> {
        let base_raw = base_path.trim();
        if base_raw.is_empty() {
            return None;
        }
        let base = Path::new(base_raw);
        Some(Self {
            normalized: normalize_lexical(base),
            canonical: cowork_config::canonicalize_sync(base),
        })
    }
}

/// Resolves `raw_path` strictly inside `base_path`, blocking missing workspace roots, `..` traversal,
/// non-file schemes, and symlinks pointing outside `base_path`.
pub fn resolve_safe_local_path(raw_path: &str, base_path: Option<&str>) -> Option<PathBuf> {
    let base = CanonicalBase::from_path(base_path?)?;
    resolve_safe_local_path_with_base(raw_path, &base)
}

/// Like [`resolve_safe_local_path`], reusing a pre-canonicalized workspace root to avoid
/// repeating `canonicalize_sync(base)` for every inline code span in a message.
pub(super) fn resolve_safe_local_path_with_base(
    raw_path: &str,
    base: &CanonicalBase,
) -> Option<PathBuf> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = if trimmed.starts_with("file://") {
        url::Url::parse(trimmed)
            .ok()
            .and_then(|u| u.to_file_path().ok())?
    } else if trimmed.contains("://") {
        return None;
    } else if let Ok(parsed) = url::Url::parse(trimmed)
        && parsed.scheme() != "file"
        && parsed.scheme().len() > 1
    {
        return None;
    } else {
        PathBuf::from(trimmed)
    };

    let lexical_target = if candidate.is_absolute() {
        normalize_lexical(&candidate)
    } else {
        let mut joined = base.normalized.clone();
        for component in candidate.components() {
            match component {
                Component::CurDir => {}
                Component::Normal(seg) => joined.push(seg),
                Component::ParentDir => {
                    if joined == base.normalized || !joined.pop() {
                        return None;
                    }
                }
                Component::RootDir | Component::Prefix(_) => return None,
            }
        }
        joined
    };

    if !cowork_config::is_inside(&base.normalized, &lexical_target) {
        return None;
    }

    let canon_target = cowork_config::canonicalize_sync(&lexical_target);
    if canon_target == base.canonical || !cowork_config::is_inside(&base.canonical, &canon_target) {
        return None;
    }

    Some(canon_target)
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Decodes a `data:image/...` URL or safe local image path into a ready [`rune::Image`].
pub fn decode_image_from_uri(
    uri: &str,
    base_path: Option<&str>,
    external_cache: Option<&ImageCache>,
) -> Option<Image> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cache: &ImageCache = match external_cache {
        Some(c) => c,
        None => shared_image_cache(),
    };

    if let Some(rest) = trimmed.strip_prefix("data:") {
        let (meta, payload) = rest.split_once(',')?;
        let mime = meta.split(';').next().unwrap_or("").trim();
        if !mime.to_ascii_lowercase().starts_with("image/") {
            return None;
        }
        let is_base64 = meta
            .split(';')
            .skip(1)
            .any(|param| param.trim().eq_ignore_ascii_case("base64"));
        let bytes: Vec<u8> = if is_base64 {
            base64::engine::general_purpose::STANDARD
                .decode(payload.trim())
                .ok()?
        } else {
            payload.as_bytes().to_vec()
        };
        let img = cache.load_mime(bytes, mime, 420.0, 2.0);
        if external_cache.is_none() && !img.is_ready() {
            let _ = img.wait();
        }
        return (img.is_ready() && img.error().is_none()).then_some(img);
    }

    if let Some(local_path) = resolve_safe_local_path(trimmed, base_path)
        && looks_like_image_path(&local_path)
    {
        let img = cache.file(local_path, 420.0, 2.0);
        if external_cache.is_none() && !img.is_ready() {
            let _ = img.wait();
        }
        return (img.is_ready() && img.error().is_none()).then_some(img);
    }

    None
}

fn looks_like_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif"
            )
        })
}

/// Decodes a thumbnail [`rune::Image`] from an inline or uploaded attachment if it is an image.
pub fn decode_attachment_thumbnail(
    info: &AttachmentDisplayInfo,
    external_cache: Option<&ImageCache>,
) -> Option<Image> {
    if info.category != AttachmentCategory::Image {
        return None;
    }
    let cache: &ImageCache = match external_cache {
        Some(c) => c,
        None => shared_image_cache(),
    };
    let img = if let Some(bytes) = &info.decoded_image_bytes {
        cache.load_mime(bytes.clone(), &info.mime_type, 32.0, 2.0)
    } else if let Some(path) = &info.path {
        cache.file(path, 32.0, 2.0)
    } else {
        return None;
    };
    if external_cache.is_none() && !img.is_ready() {
        let _ = img.wait();
    }
    (img.is_ready() && img.error().is_none()).then_some(img)
}

fn category_icon(category: AttachmentCategory) -> &'static rune::Icon {
    match category {
        AttachmentCategory::Spreadsheet => &icons::SPREADSHEET,
        AttachmentCategory::Image => &icons::IMAGE,
        AttachmentCategory::Audio => &icons::AUDIO,
        AttachmentCategory::Video => &icons::VIDEO,
        AttachmentCategory::Pdf
        | AttachmentCategory::Word
        | AttachmentCategory::Presentation
        | AttachmentCategory::Generic => &icons::FILE_TEXT,
    }
}

/// Renders a single horizontal compact file/image attachment card (`w: 240`, `size: sm`).
pub fn file_attachment_card(
    k: &Kit,
    t: &ThemeTokens,
    info: &AttachmentDisplayInfo,
    key: impl Into<String>,
    trailing: Option<El>,
    external_cache: Option<&ImageCache>,
) -> El {
    let preview = decode_attachment_thumbnail(info, external_cache);
    let spreadsheet = info.category == AttachmentCategory::Spreadsheet;

    let media = if let Some(image) = preview {
        el().size(32.0, 32.0)
            .shrink()
            .radius(8.0)
            .clip_rounded(8.0)
            .pixels_fit(image.pixels(), SurfaceFit::Fill)
    } else {
        let (badge_bg, badge_fg) = if spreadsheet {
            (k.alpha(t.success, 0.15), t.success)
        } else {
            (k.c.layer_02, t.text_muted)
        };
        el().size(32.0, 32.0)
            .shrink()
            .radius(8.0)
            .fill(badge_bg)
            .center()
            .child(icon(category_icon(info.category), 16.0).color(badge_fg))
    };

    let (stem, ext_opt) = split_filename_extension(&info.filename);
    let title_style = k.ty.text_xsmall_medium;
    let mut title_row = row().w_full().min_w(0.0).items_center().child(
        text(stem.to_owned())
            .font(title_style)
            .color(t.text_base)
            .truncate()
            .shrink(),
    );
    if let Some(ext) = ext_opt {
        title_row = title_row.child(text(ext.to_owned()).font(title_style).color(t.text_base));
    }

    let content = col().grow(1.0).min_w(0.0).gap(2.0).child(title_row).child(
        text(info.subtitle.clone())
            .font(k.ty.small)
            .color(t.text_muted)
            .truncate(),
    );

    let card_fill = k.alpha(t.elevated_bg, 0.55);
    let card_hover = k.alpha(t.elevated_bg, 0.85);
    let mut card = row()
        .key(key)
        .w(240.0)
        .max_w(240.0)
        .min_w(160.0)
        .items_center()
        .gap(10.0)
        .px(8.0)
        .py(6.0)
        .radius(12.0)
        .fill(card_fill)
        .hover(card_hover)
        .border(1.0, k.alpha(t.border, 0.7))
        .help(info.filename.clone())
        .child(media)
        .child(content);

    if let Some(trailing_el) = trailing {
        card = card.child(trailing_el);
    }

    card
}

/// Renders a wrapping group of sent attachments for a user message bubble.
pub fn user_attachment_group(
    k: &Kit,
    t: &ThemeTokens,
    attachments: &[TurnAttachmentInputPart],
    key_prefix: &str,
    external_cache: Option<&ImageCache>,
) -> Option<El> {
    if attachments.is_empty() {
        return None;
    }

    let mut group = row().w_full().min_w(0.0).flex_wrap().gap(8.0);
    for (idx, part) in attachments.iter().enumerate() {
        let info = attachment_display_info(part);
        let card = file_attachment_card(
            k,
            t,
            &info,
            format!("{key_prefix}:att:{idx}"),
            None,
            external_cache,
        );
        group = group.child(card);
    }
    Some(group)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_filename_preserves_extension_only_when_non_leading() {
        assert_eq!(
            split_filename_extension("quarterly-report.xlsx"),
            ("quarterly-report", Some(".xlsx"))
        );
        assert_eq!(split_filename_extension(".env"), (".env", None));
        assert_eq!(split_filename_extension("README"), ("README", None));
    }

    #[test]
    fn resolve_safe_local_path_blocks_workspace_escape() {
        assert_eq!(
            resolve_safe_local_path("assets/chart.png", Some("/repo/project")),
            Some(PathBuf::from("/repo/project/assets/chart.png"))
        );
        assert_eq!(
            resolve_safe_local_path("./sub/../assets/chart.png", Some("/repo/project")),
            Some(PathBuf::from("/repo/project/assets/chart.png"))
        );
        assert_eq!(
            resolve_safe_local_path("/repo/project/assets/chart.png", Some("/repo/project")),
            Some(PathBuf::from("/repo/project/assets/chart.png"))
        );
        assert_eq!(
            resolve_safe_local_path(
                "file:///repo/project/assets/chart.png",
                Some("/repo/project")
            ),
            Some(PathBuf::from("/repo/project/assets/chart.png"))
        );
        assert_eq!(
            resolve_safe_local_path("../../etc/passwd", Some("/repo/project")),
            None
        );
        assert_eq!(
            resolve_safe_local_path("/etc/passwd", Some("/repo/project")),
            None
        );
        assert_eq!(
            resolve_safe_local_path("file:///etc/passwd", Some("/repo/project")),
            None
        );
        assert_eq!(resolve_safe_local_path("/etc/passwd", None), None);
        assert_eq!(resolve_safe_local_path("assets/chart.png", None), None);
        assert_eq!(
            resolve_safe_local_path("https://example.com/a.png", Some("/repo/project")),
            None
        );
        assert_eq!(
            resolve_safe_local_path("data:image/png;base64,AAAA", Some("/repo/project")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_safe_local_path_blocks_symlink_escape_and_non_image_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside tempdir");
        let outside_img = outside.path().join("secret.png");
        std::fs::write(&outside_img, b"not-a-workspace-file").expect("write outside");

        let escape_link = dir.path().join("escape.png");
        std::os::unix::fs::symlink(&outside_img, &escape_link).expect("symlink outside");
        assert_eq!(
            resolve_safe_local_path("escape.png", dir.path().to_str()),
            None
        );
        assert!(decode_image_from_uri("escape.png", dir.path().to_str(), None).is_none());

        let inside_txt = dir.path().join("secret.txt");
        std::fs::write(&inside_txt, b"secret").expect("write txt");
        let masquerade_link = dir.path().join("photo.png");
        std::os::unix::fs::symlink(&inside_txt, &masquerade_link).expect("symlink inside txt");
        assert_eq!(
            resolve_safe_local_path("photo.png", dir.path().to_str()),
            Some(cowork_config::canonicalize_sync(&inside_txt))
        );
        assert!(decode_image_from_uri("photo.png", dir.path().to_str(), None).is_none());
    }

    #[test]
    fn decode_image_from_uri_decodes_valid_png_data_url() {
        // 1x1 transparent PNG base64
        let tiny_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let decoded = decode_image_from_uri(tiny_png, None, None).expect("1x1 png should decode");
        assert_eq!(decoded.size(), Some([1, 1]));
    }
}
