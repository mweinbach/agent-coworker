use std::fs;
use std::path::{Path, PathBuf};

use cowork_inference::{ContentBlock, MediaKind, MediaSource, ProviderOpaqueMeta};
use cowork_protocol::{ExtractedTurnInput, TurnAttachmentInputPart};
use cowork_tools::canonicalize_with_missing_tail;
use data_encoding::{BASE64, BASE64_NOPAD};

const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug)]
pub struct MaterializedTurnInput {
    pub display_text: String,
    pub content_blocks: Vec<ContentBlock>,
    pub staged_files: Vec<PathBuf>,
}

impl MaterializedTurnInput {
    /// Removes newly staged files in `User Uploads/` if pre-turn validation aborts.
    pub fn rollback(&self) {
        for f in &self.staged_files {
            let _ = fs::remove_file(f);
        }
    }
}

fn sanitize_upload_filename(raw: &str) -> String {
    let base = Path::new(raw.trim())
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment.bin".to_owned());
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "attachment.bin".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn next_collision_free_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(filename);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "attachment".to_owned());
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for idx in 1..10_000 {
        let next = dir.join(format!("{stem}-{idx}{ext}"));
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem}-{}", uuid::Uuid::new_v4()))
}

fn decode_strict_base64(raw: &str) -> Result<Vec<u8>, String> {
    let trimmed = raw.trim();
    let payload = trimmed
        .split_once(";base64,")
        .map(|(_, b)| b)
        .unwrap_or(trimmed);
    let no_ws: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    BASE64
        .decode(no_ws.as_bytes())
        .or_else(|_| BASE64_NOPAD.decode(no_ws.as_bytes()))
        .map_err(|e| format!("Invalid base64 file attachment: {e}"))
}

fn classify_media_kind(mime_type: &str, filename: &str) -> Option<(MediaKind, String)> {
    let lower_mime = mime_type.trim().to_ascii_lowercase();
    if matches!(
        lower_mime.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Some((MediaKind::Image, lower_mime));
    }
    if lower_mime == "application/pdf" {
        return Some((MediaKind::Document, lower_mime));
    }

    let ext = Path::new(filename)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => Some((MediaKind::Image, "image/png".to_owned())),
        "jpg" | "jpeg" => Some((MediaKind::Image, "image/jpeg".to_owned())),
        "gif" => Some((MediaKind::Image, "image/gif".to_owned())),
        "webp" => Some((MediaKind::Image, "image/webp".to_owned())),
        "pdf" => Some((MediaKind::Document, "application/pdf".to_owned())),
        _ => None,
    }
}

pub fn materialize_turn_attachments(
    extracted: &ExtractedTurnInput,
    uploads_directory: &Path,
    working_directory: &Path,
) -> Result<MaterializedTurnInput, String> {
    let mut staged_files = Vec::<PathBuf>::new();
    let mut content_blocks = Vec::<ContentBlock>::new();
    let mut file_notes = Vec::<String>::new();

    let user_uploads_dir = uploads_directory.join("User Uploads");

    let run = (|| -> Result<(), String> {
        for att in &extracted.attachments {
            match att {
                TurnAttachmentInputPart::InlineFile {
                    filename,
                    content_base64,
                    mime_type,
                } => {
                    let bytes = decode_strict_base64(content_base64)?;
                    if bytes.len() > MAX_ATTACHMENT_BYTES {
                        return Err(format!(
                            "Attachment '{filename}' exceeds 25 MiB limit ({} bytes).",
                            bytes.len()
                        ));
                    }
                    fs::create_dir_all(&user_uploads_dir)
                        .map_err(|e| format!("Failed to create User Uploads directory: {e}"))?;
                    let safe_name = sanitize_upload_filename(filename);
                    let dest = next_collision_free_path(&user_uploads_dir, &safe_name);
                    fs::write(&dest, &bytes).map_err(|e| {
                        format!("Failed to save attachment '{}': {e}", dest.display())
                    })?;
                    staged_files.push(dest.clone());

                    let mime_str = if mime_type.trim().is_empty() {
                        "application/octet-stream"
                    } else {
                        mime_type.as_str()
                    };
                    if let Some((kind, canonical_mime)) = classify_media_kind(mime_str, &safe_name)
                    {
                        content_blocks.push(ContentBlock::Media {
                            kind,
                            source: MediaSource::Base64 {
                                mime_type: canonical_mime.clone(),
                                data: BASE64.encode(&bytes),
                            },
                            provider_meta: ProviderOpaqueMeta::default(),
                        });
                        file_notes.push(format!(
                            "[Attached {}: {} ({}, {} bytes)]",
                            if kind == MediaKind::Image {
                                "image"
                            } else {
                                "document"
                            },
                            dest.display(),
                            canonical_mime,
                            bytes.len()
                        ));
                    } else {
                        file_notes.push(format!(
                            "[Attached file saved to: {} ({}, {} bytes)]",
                            dest.display(),
                            mime_str,
                            bytes.len()
                        ));
                    }
                }
                TurnAttachmentInputPart::UploadedFile {
                    filename,
                    path,
                    mime_type,
                } => {
                    let candidate = if Path::new(path).is_absolute() {
                        PathBuf::from(path)
                    } else {
                        uploads_directory.join(path)
                    };
                    let resolved = canonicalize_with_missing_tail(&candidate);
                    let canon_uploads = canonicalize_with_missing_tail(uploads_directory);
                    let canon_ws = canonicalize_with_missing_tail(working_directory);
                    if !resolved.starts_with(&canon_uploads) && !resolved.starts_with(&canon_ws) {
                        return Err(format!(
                            "Uploaded file '{}' is outside allowed workspace/uploads directories.",
                            resolved.display()
                        ));
                    }
                    let meta = fs::metadata(&resolved).map_err(|e| {
                        format!("Uploaded file '{}' not found: {e}", resolved.display())
                    })?;
                    if !meta.is_file() {
                        return Err(format!(
                            "Uploaded path '{}' is not a regular file.",
                            resolved.display()
                        ));
                    }
                    let len = meta.len() as usize;
                    if len > MAX_ATTACHMENT_BYTES {
                        return Err(format!(
                            "Uploaded file '{}' exceeds 25 MiB limit ({len} bytes).",
                            resolved.display()
                        ));
                    }
                    let name_hint = if !filename.trim().is_empty() {
                        filename.as_str()
                    } else {
                        resolved
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("uploaded")
                    };
                    let mime_str = if mime_type.trim().is_empty() {
                        "application/octet-stream"
                    } else {
                        mime_type.as_str()
                    };
                    if let Some((kind, canonical_mime)) = classify_media_kind(mime_str, name_hint) {
                        let bytes = fs::read(&resolved).map_err(|e| {
                            format!("Failed to read uploaded file '{}': {e}", resolved.display())
                        })?;
                        content_blocks.push(ContentBlock::Media {
                            kind,
                            source: MediaSource::Base64 {
                                mime_type: canonical_mime.clone(),
                                data: BASE64.encode(&bytes),
                            },
                            provider_meta: ProviderOpaqueMeta::default(),
                        });
                    }
                    file_notes.push(format!(
                        "[Attached uploaded file: {} ({mime_str}, {len} bytes)]",
                        resolved.display()
                    ));
                }
            }
        }
        Ok(())
    })();

    if let Err(err) = run {
        for f in &staged_files {
            let _ = fs::remove_file(f);
        }
        return Err(err);
    }

    let mut full_text = extracted.text.clone();
    if !file_notes.is_empty() {
        if !full_text.is_empty() {
            full_text.push_str("\n\n");
        }
        full_text.push_str(&file_notes.join("\n"));
    }

    if !full_text.is_empty() || content_blocks.is_empty() {
        content_blocks.insert(
            0,
            ContentBlock::Text {
                text: full_text.clone(),
                phase: None,
                citations: Vec::new(),
                provider_meta: ProviderOpaqueMeta::default(),
            },
        );
    }

    Ok(MaterializedTurnInput {
        display_text: full_text,
        content_blocks,
        staged_files,
    })
}
