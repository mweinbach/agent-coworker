use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;

use async_trait::async_trait;
use cowork_inference::{MediaKind, MediaSource, ToolResultPart};
use serde_json::{Map, Value, json};

use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    assert_read_path_allowed, normalize_and_validate_args, resolve_tool_path,
};
use crate::mutation::with_file_mutation;
use crate::text_codec::{
    LineEnding, TextEncoding, decode_text_buffer, detect_bom, detect_dominant_eol,
    encode_text_buffer, normalize_to_lf, replace_respecting_eol,
};

const DEFAULT_READ_LIMIT: usize = 2_000;
const MAX_READ_LIMIT: usize = 20_000;
const MAX_CHARS_PER_LINE_WINDOW: usize = 2_000;
const MAX_MEDIA_BYTES: u64 = 25 * 1024 * 1024;

pub struct ReadTool;

impl ReadTool {
    fn image_mime_for_ext(ext: &str) -> Option<&'static str> {
        match ext {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            _ => None,
        }
    }

    fn known_binary_mime_for_ext(ext: &str) -> Option<&'static str> {
        match ext {
            "mp3" => Some("audio/mpeg"),
            "wav" => Some("audio/wav"),
            "ogg" => Some("audio/ogg"),
            "m4a" => Some("audio/mp4"),
            "mp4" => Some("video/mp4"),
            "mov" => Some("video/quicktime"),
            "webm" => Some("video/webm"),
            "zip" => Some("application/zip"),
            "gz" | "tgz" => Some("application/gzip"),
            "tar" => Some("application/x-tar"),
            "wasm" => Some("application/wasm"),
            "sqlite" | "db" => Some("application/vnd.sqlite3"),
            "exe" | "dll" | "so" | "dylib" => Some("application/octet-stream"),
            "docx" => {
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            }
            "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            "pptx" => {
                Some("application/vnd.openxmlformats-officedocument.presentationml.presentation")
            }
            _ => None,
        }
    }
}

fn format_line_window(
    line_num: usize,
    line_str: &str,
    column_offset_1based: usize,
) -> Option<String> {
    let chars: Vec<char> = line_str.chars().collect();
    let start_idx = column_offset_1based.saturating_sub(1);
    if start_idx > chars.len() && !chars.is_empty() {
        return Some(format!("{line_num}\t"));
    }
    let slice_end = (start_idx + MAX_CHARS_PER_LINE_WINDOW).min(chars.len());
    let window: String = if start_idx < chars.len() {
        chars[start_idx..slice_end].iter().collect()
    } else {
        String::new()
    };
    if slice_end < chars.len() {
        let next_col = slice_end + 1;
        Some(format!(
            "{line_num}\t{window}\n[Line {line_num} continues at column {next_col}; call read offset={line_num} columnOffset={next_col} limit=1 to inspect further]"
        ))
    } else {
        Some(format!("{line_num}\t{window}"))
    }
}

/// Streams UTF-8 files chunk-by-chunk without loading entire giant logs into RAM,
/// and decodes UTF-16LE/BE BOM files cleanly.
fn read_text_window_streaming(
    path: &Path,
    display_name: &str,
    file_size: u64,
    offset_1based: usize,
    column_offset_1based: usize,
    limit: usize,
) -> ToolResult<ToolOutput> {
    let mut file = File::open(path)
        .map_err(|e| ToolError::Execution(format!("Failed to open '{}': {e}", path.display())))?;

    let mut head = [0u8; 8192];
    let head_n = file
        .read(&mut head)
        .map_err(|e| ToolError::Execution(format!("Failed to read '{}': {e}", path.display())))?;
    if head_n == 0 {
        return Ok(ToolOutput::Text(String::new()));
    }

    let (encoding, bom_len) = detect_bom(&head[..head_n]);
    if matches!(encoding, TextEncoding::Utf8 | TextEncoding::Utf8Bom)
        && head[bom_len..head_n].contains(&0)
    {
        return Ok(ToolOutput::Text(format!(
            "Cannot read {display_name} as text (application/octet-stream, {file_size} bytes). Use dedicated tools or python/bash scripts to inspect binary files."
        )));
    }

    if matches!(
        encoding,
        TextEncoding::Utf16LeBom | TextEncoding::Utf16BeBom
    ) {
        let bytes = fs::read(path).map_err(|e| {
            ToolError::Execution(format!("Failed to read '{}': {e}", path.display()))
        })?;
        let decoded = match decode_text_buffer(&bytes) {
            Ok(buf) => buf,
            Err(_) => {
                return Ok(ToolOutput::Text(format!(
                    "Cannot read {display_name} as text (invalid UTF-16 encoding, {file_size} bytes)."
                )));
            }
        };
        return Ok(ToolOutput::Text(render_lines_from_lf_str(
            &decoded.text,
            offset_1based,
            column_offset_1based,
            limit,
        )));
    }

    // Stream UTF-8 / UTF-8-BOM line-by-line in 64 KiB chunks.
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(bom_len as u64))
        .map_err(|e| ToolError::Execution(format!("Seek failed: {e}")))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut raw_buf = [0u8; 64 * 1024];
    let mut carry = Vec::<u8>::new();
    let mut pending_cr = false;

    let mut current_line_no = 0usize;
    let end_line_exclusive = offset_1based.saturating_add(limit);
    let mut formatted_lines = Vec::<String>::new();
    let mut has_more_after_limit = false;

    let mut emit_line = |line_bytes: &[u8]| -> ToolResult<bool> {
        current_line_no += 1;
        if current_line_no < offset_1based {
            return Ok(true);
        }
        if current_line_no >= end_line_exclusive {
            has_more_after_limit = true;
            return Ok(false);
        }
        let line_str = std::str::from_utf8(line_bytes).map_err(|_| {
            ToolError::Execution(format!(
                "Cannot read {display_name} as text (invalid UTF-8 sequence at line {current_line_no})."
            ))
        })?;
        if let Some(rendered) = format_line_window(current_line_no, line_str, column_offset_1based)
        {
            formatted_lines.push(rendered);
        }
        Ok(true)
    };

    'outer: loop {
        let n = reader
            .read(&mut raw_buf)
            .map_err(|e| ToolError::Execution(format!("Read error: {e}")))?;
        if n == 0 {
            if pending_cr || !carry.is_empty() {
                let _ = emit_line(&carry)?;
                carry.clear();
            }
            break;
        }
        let chunk = &raw_buf[..n];
        for &b in chunk {
            if pending_cr {
                pending_cr = false;
                let cont = emit_line(&carry)?;
                carry.clear();
                if !cont {
                    break 'outer;
                }
                if b == b'\n' {
                    continue;
                }
            }
            if b == b'\r' {
                pending_cr = true;
            } else if b == b'\n' {
                let cont = emit_line(&carry)?;
                carry.clear();
                if !cont {
                    break 'outer;
                }
            } else {
                if b == 0 {
                    return Ok(ToolOutput::Text(format!(
                        "Cannot read {display_name} as text (binary file, {file_size} bytes)."
                    )));
                }
                carry.push(b);
            }
        }
    }

    let mut out = formatted_lines.join("\n");
    if has_more_after_limit {
        let shown_end = offset_1based + formatted_lines.len().saturating_sub(1);
        out.push_str(&format!(
            "\n\n[Showing lines {offset_1based}-{shown_end}; pass offset={} to continue]",
            shown_end + 1
        ));
    }
    Ok(ToolOutput::Text(out))
}

fn render_lines_from_lf_str(
    lf_text: &str,
    offset_1based: usize,
    column_offset_1based: usize,
    limit: usize,
) -> String {
    if lf_text.is_empty() {
        return String::new();
    }
    let trimmed = lf_text.strip_suffix('\n').unwrap_or(lf_text);
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let total = lines.len();
    let start_idx = offset_1based.saturating_sub(1);
    if start_idx >= total {
        return String::new();
    }
    let end_idx = (start_idx + limit).min(total);
    let mut rendered = Vec::with_capacity(end_idx - start_idx);
    for (idx, line) in lines[start_idx..end_idx].iter().enumerate() {
        let line_no = start_idx + idx + 1;
        if let Some(s) = format_line_window(line_no, line, column_offset_1based) {
            rendered.push(s);
        }
    }
    let mut out = rendered.join("\n");
    if end_idx < total {
        out.push_str(&format!(
            "\n\n[Showing lines {offset_1based}-{end_idx} of {total}; pass offset={} to continue]",
            end_idx + 1
        ));
    }
    out
}

#[async_trait]
impl BuiltinTool for ReadTool {
    fn name(&self) -> &str {
        "read"
    }

    fn description(&self) -> &str {
        "Read the contents of a file from disk. Supports text files (UTF-8 and UTF-16 BOM with line/column offsets), images (PNG/JPEG/GIF/WebP), and PDF documents."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filePath": {
                    "type": "string",
                    "description": "Path to the file to read (absolute or relative to the working directory)."
                },
                "offset": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "1-based starting line number (default: 1)."
                },
                "columnOffset": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "1-based starting character column within each line (default: 1)."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_READ_LIMIT,
                    "description": "Maximum number of lines to return (default: 2000, max: 20000)."
                }
            },
            "required": ["filePath"]
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if !raw_args.contains_key("filePath")
            && let Some(alias) = raw_args
                .remove("file_path")
                .or_else(|| raw_args.remove("path"))
        {
            raw_args.insert("filePath".to_owned(), alias);
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let raw_path = args
            .get("filePath")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("filePath is required".to_owned()))?;
        let offset = args
            .get("offset")
            .and_then(Value::as_u64)
            .map_or(1usize, |v| v as usize);
        let column_offset = args
            .get("columnOffset")
            .and_then(Value::as_u64)
            .map_or(1usize, |v| v as usize);
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_READ_LIMIT, |v| (v as usize).min(MAX_READ_LIMIT));

        let candidate = resolve_tool_path(raw_path, &ctx.working_directory)?;
        let path = assert_read_path_allowed(&candidate, ctx)?;

        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(ToolError::Execution(format!(
                    "File not found: {}",
                    path.display()
                )));
            }
            Err(err) => {
                return Err(ToolError::Execution(format!(
                    "Cannot access '{}': {err}",
                    path.display()
                )));
            }
        };

        if meta.is_dir() {
            return Ok(ToolOutput::Text(format!(
                "\"{}\" is a directory, not a file. Use the glob tool (for example pattern \"*\" with path \"{}\") to list its contents, or pass a concrete file path to read.",
                raw_path, raw_path
            )));
        }

        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw_path.to_owned());
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let file_size = meta.len();

        if let Some(mime) = Self::image_mime_for_ext(&ext) {
            if file_size > MAX_MEDIA_BYTES {
                return Err(ToolError::Execution(format!(
                    "Image file '{file_name}' exceeds maximum supported size of 25 MiB ({file_size} bytes)."
                )));
            }
            let bytes = fs::read(&path).map_err(|e| {
                ToolError::Execution(format!("Failed to read image '{}': {e}", path.display()))
            })?;
            let b64 = data_encoding::BASE64.encode(&bytes);
            return Ok(ToolOutput::Content(vec![
                ToolResultPart::Text {
                    text: format!("Image file: {file_name} ({mime}, {file_size} bytes)"),
                },
                ToolResultPart::Media {
                    kind: MediaKind::Image,
                    source: MediaSource::Base64 {
                        mime_type: mime.to_owned(),
                        data: b64,
                    },
                },
            ]));
        }

        if ext == "pdf" {
            if file_size > MAX_MEDIA_BYTES {
                return Ok(ToolOutput::Text(format!(
                    "Cannot read {file_name} inline (application/pdf, {file_size} bytes exceeds 25 MiB limit). Use python/pypdf or pdftotext via bash to inspect pages."
                )));
            }
            let bytes = fs::read(&path).map_err(|e| {
                ToolError::Execution(format!("Failed to read PDF '{}': {e}", path.display()))
            })?;
            let b64 = data_encoding::BASE64.encode(&bytes);
            return Ok(ToolOutput::Content(vec![
                ToolResultPart::Text {
                    text: format!(
                        "Document file: {file_name} (application/pdf, {file_size} bytes)"
                    ),
                },
                ToolResultPart::Media {
                    kind: MediaKind::Document,
                    source: MediaSource::Base64 {
                        mime_type: "application/pdf".to_owned(),
                        data: b64,
                    },
                },
            ]));
        }

        if let Some(mime) = Self::known_binary_mime_for_ext(&ext) {
            return Ok(ToolOutput::Text(format!(
                "Cannot read {file_name} as text ({mime}, {file_size} bytes). Use dedicated tools or python/bash scripts to inspect this file."
            )));
        }

        tokio::task::spawn_blocking(move || {
            read_text_window_streaming(&path, &file_name, file_size, offset, column_offset, limit)
        })
        .await
        .map_err(|e| ToolError::Execution(format!("Read task failed: {e}")))?
    }
}

pub struct WriteTool;

#[async_trait]
impl BuiltinTool for WriteTool {
    fn name(&self) -> &str {
        "write"
    }

    fn description(&self) -> &str {
        "Create a new file or atomically overwrite an existing file, preserving existing BOM and CRLF/LF line endings when overwriting text files."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filePath": {
                    "type": "string",
                    "description": "Path to the file to write (absolute or relative to the working directory)."
                },
                "content": {
                    "type": "string",
                    "description": "Full text content to write to the file."
                }
            },
            "required": ["filePath", "content"]
        })
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if !raw_args.contains_key("filePath")
            && let Some(alias) = raw_args
                .remove("file_path")
                .or_else(|| raw_args.remove("path"))
        {
            raw_args.insert("filePath".to_owned(), alias);
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let raw_path = args
            .get("filePath")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("filePath is required".to_owned()))?;
        let content = args
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("content is required".to_owned()))?
            .to_owned();

        let target = resolve_tool_path(raw_path, &ctx.working_directory)?;
        let display = target.display().to_string();

        let (existed, byte_len) = with_file_mutation(&target, ctx, move |snapshot| {
            let (encoding, eol) = if let Some(prev_bytes) = &snapshot.bytes
                && let Ok(decoded) = decode_text_buffer(prev_bytes)
            {
                (decoded.encoding, decoded.dominant_eol)
            } else {
                let explicit_eol = detect_dominant_eol(&content);
                (
                    if content.starts_with('\u{feff}') {
                        TextEncoding::Utf8Bom
                    } else {
                        TextEncoding::Utf8
                    },
                    if explicit_eol == LineEnding::Crlf {
                        LineEnding::Crlf
                    } else {
                        LineEnding::Lf
                    },
                )
            };
            let normalized = normalize_to_lf(&content);
            let encoded = encode_text_buffer(&normalized, encoding, eol);
            let len = encoded.len();
            Ok((encoded, (snapshot.exists, len)))
        })
        .await?;

        let verb = if existed { "Updated" } else { "Created" };
        Ok(ToolOutput::Text(format!(
            "{verb} {display} ({byte_len} bytes)"
        )))
    }
}

pub struct EditTool;

#[async_trait]
impl BuiltinTool for EditTool {
    fn name(&self) -> &str {
        "edit"
    }

    fn description(&self) -> &str {
        "Perform exact literal string replacements in an existing text file while preserving UTF-8/UTF-16 BOM and dominant CRLF/LF line endings."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "filePath": {
                    "type": "string",
                    "description": "Path to the existing file to edit."
                },
                "oldString": {
                    "type": "string",
                    "description": "Exact text to locate in the file."
                },
                "newString": {
                    "type": "string",
                    "description": "Replacement text."
                },
                "replaceAll": {
                    "type": "boolean",
                    "description": "Replace every occurrence instead of requiring oldString to be unique (default: false)."
                }
            },
            "required": ["filePath", "oldString", "newString"]
        })
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if !raw_args.contains_key("filePath")
            && let Some(alias) = raw_args
                .remove("file_path")
                .or_else(|| raw_args.remove("path"))
        {
            raw_args.insert("filePath".to_owned(), alias);
        }
        if !raw_args.contains_key("oldString")
            && let Some(alias) = raw_args.remove("old_string")
        {
            raw_args.insert("oldString".to_owned(), alias);
        }
        if !raw_args.contains_key("newString")
            && let Some(alias) = raw_args.remove("new_string")
        {
            raw_args.insert("newString".to_owned(), alias);
        }
        if !raw_args.contains_key("replaceAll")
            && let Some(alias) = raw_args.remove("replace_all")
        {
            raw_args.insert("replaceAll".to_owned(), alias);
        }

        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let raw_path = args
            .get("filePath")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("filePath is required".to_owned()))?;
        let old_string = args
            .get("oldString")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("oldString is required".to_owned()))?
            .to_owned();
        let new_string = args
            .get("newString")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("newString is required".to_owned()))?
            .to_owned();
        let replace_all = args
            .get("replaceAll")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let target = resolve_tool_path(raw_path, &ctx.working_directory)?;
        let display = target.display().to_string();

        let replacements = with_file_mutation(&target, ctx, move |snapshot| {
            let prev_bytes = snapshot.bytes.ok_or_else(|| {
                ToolError::Execution(format!(
                    "File '{}' does not exist. Use the write tool to create new files.",
                    display
                ))
            })?;
            let decoded = decode_text_buffer(&prev_bytes)?;
            let (updated_lf, count) =
                replace_respecting_eol(&decoded.text, &old_string, &new_string, replace_all)?;
            let encoded = encode_text_buffer(&updated_lf, decoded.encoding, decoded.dominant_eol);
            Ok((encoded, count))
        })
        .await?;

        Ok(ToolOutput::Text(format!(
            "Edited {} ({} replacement{})",
            target.display(),
            replacements,
            if replacements == 1 { "" } else { "s" }
        )))
    }
}
