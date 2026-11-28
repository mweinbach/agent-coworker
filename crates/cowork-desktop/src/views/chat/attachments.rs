//! Shared attachment cards for composer drafts and sent user message bubbles.

use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use base64::Engine as _;
use cowork_protocol::TurnAttachmentInputPart;
use rune::{El, Image, ImageCache, SurfaceFit, col, el, icon, row, text};
use rune_kit::Kit;

use crate::theme::ThemeTokens;

use super::icons;
use super::model::{AttachmentCategory, AttachmentDisplayInfo, attachment_display_info_meta};

const MAX_BASE64_CACHE_ENTRIES: usize = 64;

static IMAGE_DECODE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Monotonic generation bumped whenever an async `ImageCache` decode completes and wakes the UI.
pub(super) fn image_decode_generation() -> u64 {
    IMAGE_DECODE_GENERATION.load(Ordering::Acquire)
}

fn shared_image_cache() -> &'static ImageCache {
    static CACHE: OnceLock<ImageCache> = OnceLock::new();
    CACHE.get_or_init(|| ImageCache::new(Arc::new(|| {})))
}

thread_local! {
    static WAKER_IMAGE_CACHE: RefCell<Option<(usize, Arc<ImageCache>)>> = const { RefCell::new(None) };
    static BASE64_DECODE_CACHE: RefCell<Base64DecodeCache> = RefCell::new(Base64DecodeCache::default());
}

type Base64CacheKey = (u64, usize, u64);
type Base64CacheEntry = (u64, Arc<[u8]>);

#[derive(Default)]
struct Base64DecodeCache {
    tick: u64,
    entries: HashMap<Base64CacheKey, Base64CacheEntry>,
}

impl Base64DecodeCache {
    fn get_or_decode(&mut self, raw_b64: &str) -> Option<Arc<[u8]>> {
        let trimmed = raw_b64.trim();
        if trimmed.is_empty() {
            return None;
        }
        let key = base64_cache_key(trimmed);
        self.tick = self.tick.wrapping_add(1);
        let now_tick = self.tick;
        if let Some((entry_tick, bytes)) = self.entries.get_mut(&key) {
            *entry_tick = now_tick;
            return Some(Arc::clone(bytes));
        }
        let decoded: Arc<[u8]> = if trimmed.bytes().any(|b| b.is_ascii_whitespace()) {
            let compact: Vec<u8> = trimmed
                .bytes()
                .filter(|b| !b.is_ascii_whitespace())
                .collect();
            base64::engine::general_purpose::STANDARD
                .decode(&compact)
                .ok()?
                .into()
        } else {
            base64::engine::general_purpose::STANDARD
                .decode(trimmed)
                .ok()?
                .into()
        };
        if self.entries.len() >= MAX_BASE64_CACHE_ENTRIES
            && let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, (t, _))| *t)
                .map(|(k, _)| *k)
        {
            self.entries.remove(&oldest_key);
        }
        self.entries.insert(key, (now_tick, Arc::clone(&decoded)));
        Some(decoded)
    }
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_bytes(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn decode_data_url_payload(meta: &str, payload: &str) -> Option<Arc<[u8]>> {
    let is_base64 = meta
        .split(';')
        .skip(1)
        .any(|param| param.trim().eq_ignore_ascii_case("base64"));
    if is_base64 {
        decode_base64_cached(payload)
    } else if payload.contains('%') {
        Some(Arc::<[u8]>::from(percent_decode_bytes(payload)))
    } else {
        Some(Arc::<[u8]>::from(payload.as_bytes()))
    }
}

fn strip_data_scheme_prefix(uri: &str) -> Option<&str> {
    let prefix = uri.get(..5)?;
    prefix.eq_ignore_ascii_case("data:").then_some(&uri[5..])
}

fn base64_cache_key(s: &str) -> (u64, usize, u64) {
    let bytes = s.as_bytes();
    let mut h1 = DefaultHasher::new();
    bytes.hash(&mut h1);
    let mut h2 = DefaultHasher::new();
    bytes.len().hash(&mut h2);
    let head_len = bytes.len().min(64);
    bytes[..head_len].hash(&mut h2);
    bytes[bytes.len().saturating_sub(64)..].hash(&mut h2);
    (h1.finish(), bytes.len(), h2.finish())
}

/// Returns a thread-local waker-backed `Arc<ImageCache>` for live windows so image decoding
/// runs off the UI thread without blocking on `img.wait()`. Returns `None` in headless/test mode
/// where `waker` is absent so synchronous frame-0 readiness is preserved.
pub(super) fn shared_waker_image_cache(
    waker: Option<&Arc<dyn Fn() + Send + Sync>>,
) -> Option<Arc<ImageCache>> {
    let wake = waker?;
    let wake_ptr = Arc::as_ptr(wake) as *const () as usize;
    WAKER_IMAGE_CACHE.with(|slot| {
        let mut guard = slot.borrow_mut();
        if let Some((cached_ptr, cache)) = guard.as_ref()
            && *cached_ptr == wake_ptr
        {
            return Some(Arc::clone(cache));
        }
        let inner = Arc::clone(wake);
        let wrapped: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            IMAGE_DECODE_GENERATION.fetch_add(1, Ordering::Release);
            (inner)();
        });
        let cache = Arc::new(ImageCache::new(wrapped));
        *guard = Some((wake_ptr, Arc::clone(&cache)));
        Some(cache)
    })
}

/// Decodes base64 bytes through a bounded thread-local LRU cache, avoiding repeated decoding
/// across renders and keystrokes.
pub(super) fn decode_base64_cached(payload: &str) -> Option<Arc<[u8]>> {
    BASE64_DECODE_CACHE.with(|cache| cache.borrow_mut().get_or_decode(payload))
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

fn is_strictly_inside_normalized(parent: &Path, child: &Path) -> bool {
    if cfg!(windows) {
        let p_low = PathBuf::from(parent.to_string_lossy().to_lowercase());
        let c_low = PathBuf::from(child.to_string_lossy().to_lowercase());
        c_low
            .strip_prefix(&p_low)
            .is_ok_and(|rel| !rel.as_os_str().is_empty())
    } else {
        child
            .strip_prefix(parent)
            .is_ok_and(|rel| !rel.as_os_str().is_empty())
    }
}

fn parse_lexical_candidate<'a>(
    raw_path: &str,
    base_path: Option<&'a str>,
) -> Option<(&'a Path, PathBuf, PathBuf)> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let base_raw = base_path?.trim();
    if base_raw.is_empty() {
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

    let base = Path::new(base_raw);
    let normalized_base = normalize_lexical(base);
    let lexical_target = if candidate.is_absolute() {
        normalize_lexical(&candidate)
    } else {
        let mut joined = normalized_base.clone();
        for component in candidate.components() {
            match component {
                Component::CurDir => {}
                Component::Normal(seg) => joined.push(seg),
                Component::ParentDir => {
                    if joined == normalized_base || !joined.pop() {
                        return None;
                    }
                }
                Component::RootDir | Component::Prefix(_) => return None,
            }
        }
        joined
    };

    Some((base, normalized_base, lexical_target))
}

/// Lexically resolves `raw_path` strictly inside `base_path` with zero filesystem syscalls.
///
/// Intended for view-time link synthesis (`cowork-file:` hrefs) where no file is opened or read;
/// click handlers and image loaders MUST still call [`resolve_safe_local_path`] for fresh
/// canonical symlink confinement checks.
pub(super) fn resolve_lexical_local_path(
    raw_path: &str,
    base_path: Option<&str>,
) -> Option<PathBuf> {
    let (_, normalized_base, lexical_target) = parse_lexical_candidate(raw_path, base_path)?;
    is_strictly_inside_normalized(&normalized_base, &lexical_target).then_some(lexical_target)
}

/// Resolves `raw_path` strictly inside `base_path`, blocking missing workspace roots, `..` traversal,
/// non-file schemes, and symlinks pointing outside `base_path`.
pub fn resolve_safe_local_path(raw_path: &str, base_path: Option<&str>) -> Option<PathBuf> {
    let (base, _, lexical_target) = parse_lexical_candidate(raw_path, base_path)?;
    let canon_base = cowork_config::canonicalize_sync(base);
    let canon_target = cowork_config::canonicalize_sync(&lexical_target);
    is_strictly_inside_normalized(&canon_base, &canon_target).then_some(canon_target)
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

    if let Some(rest) = strip_data_scheme_prefix(trimmed) {
        let (meta, payload) = rest.split_once(',')?;
        let mime = meta.split(';').next().unwrap_or("").trim();
        if !mime.to_ascii_lowercase().starts_with("image/") {
            return None;
        }
        let bytes = decode_data_url_payload(meta, payload)?;
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
    render_attachment_card(k, t, info, preview, key, trailing)
}

/// Renders a compact attachment card directly from a protocol part, using cached base64 decoding
/// so repeated renders never re-decode inline image payloads.
pub(super) fn file_attachment_card_for_part(
    k: &Kit,
    t: &ThemeTokens,
    part: &TurnAttachmentInputPart,
    preview_data_url: Option<&str>,
    key: impl Into<String>,
    trailing: Option<El>,
    external_cache: Option<&ImageCache>,
) -> El {
    let info = attachment_display_info_meta(part);
    let preview = if info.category == AttachmentCategory::Image {
        let cache: &ImageCache = match external_cache {
            Some(c) => c,
            None => shared_image_cache(),
        };
        let inline_bytes = match part {
            TurnAttachmentInputPart::InlineFile { content_base64, .. } => {
                decode_base64_cached(content_base64)
            }
            TurnAttachmentInputPart::UploadedFile { .. } => preview_data_url
                .map(str::trim)
                .and_then(strip_data_scheme_prefix)
                .and_then(|rest| rest.split_once(','))
                .and_then(|(meta, payload)| decode_data_url_payload(meta, payload)),
        };
        let img = if let Some(bytes) = inline_bytes {
            Some(cache.load_mime(bytes, &info.mime_type, 32.0, 2.0))
        } else {
            info.path.as_deref().map(|path| cache.file(path, 32.0, 2.0))
        };
        img.and_then(|img| {
            if external_cache.is_none() && !img.is_ready() {
                let _ = img.wait();
            }
            (img.is_ready() && img.error().is_none()).then_some(img)
        })
    } else {
        None
    };
    render_attachment_card(k, t, &info, preview, key, trailing)
}

fn render_attachment_card(
    k: &Kit,
    t: &ThemeTokens,
    info: &AttachmentDisplayInfo,
    preview: Option<Image>,
    key: impl Into<String>,
    trailing: Option<El>,
) -> El {
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
        let card = file_attachment_card_for_part(
            k,
            t,
            part,
            None,
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

    #[test]
    fn decode_image_from_uri_handles_whitespace_base64_and_percent_encoded_svg() {
        let wrapped_png = "data:image/png;BASE64,\niVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ\nAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\n";
        let decoded_png = decode_image_from_uri(wrapped_png, None, None)
            .expect("wrapped base64 png should decode");
        assert_eq!(decoded_png.size(), Some([1, 1]));

        let encoded_svg = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%224%22%20height%3D%224%22%3E%3Crect%20width%3D%224%22%20height%3D%224%22%20fill%3D%22red%22%2F%3E%3C%2Fsvg%3E";
        assert!(
            decode_image_from_uri(encoded_svg, None, None).is_some(),
            "percent-encoded SVG data URI should decode"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_safe_local_path_observes_immediate_symlink_changes() {
        let root = tempfile::tempdir().expect("tempdir");
        let ws1 = root.path().join("ws1");
        let ws2 = root.path().join("ws2");
        std::fs::create_dir_all(&ws1).expect("create ws1");
        std::fs::create_dir_all(&ws2).expect("create ws2");
        let pic1 = ws1.join("pic.png");
        let pic2 = ws2.join("pic.png");
        let secret2 = ws2.join("secret.txt");
        std::fs::write(&pic1, b"png1").expect("write pic1");
        std::fs::write(&pic2, b"png2").expect("write pic2");
        std::fs::write(&secret2, b"secret").expect("write secret");

        let ws_link = root.path().join("ws_link");
        std::os::unix::fs::symlink(&ws1, &ws_link).expect("symlink ws1");
        assert_eq!(
            resolve_safe_local_path("pic.png", ws_link.to_str()),
            Some(cowork_config::canonicalize_sync(&pic1))
        );

        std::fs::remove_file(&ws_link).expect("remove ws_link");
        std::os::unix::fs::symlink(&ws2, &ws_link).expect("repoint ws_link -> ws2");
        assert_eq!(
            resolve_safe_local_path("pic.png", ws_link.to_str()),
            Some(cowork_config::canonicalize_sync(&pic2))
        );

        std::fs::remove_file(&pic2).expect("remove pic2");
        std::os::unix::fs::symlink(&secret2, &pic2).expect("replace pic2 with txt symlink");
        assert_eq!(
            resolve_safe_local_path("pic.png", ws_link.to_str()),
            Some(cowork_config::canonicalize_sync(&secret2))
        );
        assert!(decode_image_from_uri("pic.png", ws_link.to_str(), None).is_none());
    }
}
