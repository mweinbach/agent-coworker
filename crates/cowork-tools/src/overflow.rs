use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use cowork_sandbox::SandboxPolicy;
use serde_json::json;

use crate::context::{ToolError, ToolOutput, ToolResult};

pub const DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS: usize = 25_000;
pub const TOOL_OUTPUT_PREVIEW_CHARS: usize = 5_000;

pub fn is_overflow_exempt_tool(tool_name: &str, inner_called_tool: Option<&str>) -> bool {
    if matches!(tool_name, "read" | "skill" | "toolSearch" | "codeMode") {
        return true;
    }
    if tool_name == "toolCall"
        && let Some(inner) = inner_called_tool
    {
        return matches!(inner, "read" | "skill" | "toolSearch" | "codeMode");
    }
    false
}

fn sanitize_filename_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "item".to_owned()
    } else {
        cleaned
    }
}

fn slice_char_boundary(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}

fn ensure_non_symlink_private_dir(dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to use symlinked scratchpad directory: {}",
                    dir.display()
                ));
            }
            if !meta.is_dir() {
                return Err(format!(
                    "Scratchpad path exists and is not a directory: {}",
                    dir.display()
                ));
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(dir).map_err(|e| e.to_string())?;
        }
        Err(err) => return Err(err.to_string()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub fn maybe_spill_tool_output(
    tool_name: &str,
    call_id: &str,
    output: ToolOutput,
    working_directory: &Path,
    threshold_chars: Option<usize>,
    sandbox_policy: &SandboxPolicy,
) -> ToolResult<ToolOutput> {
    maybe_spill_tool_output_with_inner(
        tool_name,
        None,
        call_id,
        output,
        working_directory,
        threshold_chars,
        sandbox_policy,
    )
}

pub fn maybe_spill_tool_output_with_inner(
    tool_name: &str,
    inner_tool_name: Option<&str>,
    call_id: &str,
    output: ToolOutput,
    working_directory: &Path,
    threshold_chars: Option<usize>,
    sandbox_policy: &SandboxPolicy,
) -> ToolResult<ToolOutput> {
    let Some(threshold) = threshold_chars else {
        return Ok(output);
    };
    if threshold == 0
        || is_overflow_exempt_tool(tool_name, inner_tool_name)
        || output.contains_media()
    {
        return Ok(output);
    }

    let (serialized, ext) = match &output {
        ToolOutput::Text(s) => (s.clone(), "txt"),
        ToolOutput::Json(v) => (
            serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()),
            "json",
        ),
        ToolOutput::Content(parts) => {
            let Some(txt) = output.as_text() else {
                return Ok(ToolOutput::Content(parts.clone()));
            };
            (txt, "txt")
        }
    };

    let char_count = serialized.chars().count();
    if char_count <= threshold {
        return Ok(output);
    }

    let preview = slice_char_boundary(&serialized, TOOL_OUTPUT_PREVIEW_CHARS);
    let can_write_workspace = matches!(
        sandbox_policy,
        SandboxPolicy::WorkspaceWrite { .. } | SandboxPolicy::DangerFullAccess { .. }
    );

    if can_write_workspace {
        let cowork_dir = working_directory.join(".cowork");
        let scratchpad_dir = cowork_dir.join(".cowork-scratchpad");
        let write_attempt = (|| -> Result<std::path::PathBuf, String> {
            ensure_non_symlink_private_dir(&cowork_dir)?;
            ensure_non_symlink_private_dir(&scratchpad_dir)?;
            let file_name = format!(
                "{}-{}.{ext}",
                sanitize_filename_segment(inner_tool_name.unwrap_or(tool_name)),
                sanitize_filename_segment(call_id)
            );
            let target = scratchpad_dir.join(file_name);
            if let Ok(meta) = fs::symlink_metadata(&target)
                && meta.file_type().is_symlink()
            {
                return Err("Refusing to overwrite symlink in scratchpad".to_owned());
            }
            let mut opts = OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&target).map_err(|e| e.to_string())?;
            f.write_all(serialized.as_bytes())
                .map_err(|e| e.to_string())?;
            Ok(target)
        })();

        match write_attempt {
            Ok(spilled_path) => {
                let total_lines = serialized.lines().count();
                return Ok(ToolOutput::Json(json!({
                    "overflow": true,
                    "tool": inner_tool_name.unwrap_or(tool_name),
                    "totalChars": char_count,
                    "totalLines": total_lines,
                    "filePath": spilled_path.to_string_lossy(),
                    "preview": preview,
                    "hint": format!(
                        "Output exceeded {threshold} chars and was saved to {}. Use `read` (with offset/limit) or `grep` on that filePath to inspect specific sections.",
                        spilled_path.display()
                    )
                })));
            }
            Err(err) if err.contains("symlink") => {
                return Err(ToolError::PathDenied(err));
            }
            Err(_) => {
                // Fall through to read-only inline truncation fallback.
            }
        }
    }

    Ok(ToolOutput::Json(json!({
        "overflow": true,
        "spilledToDisk": false,
        "tool": inner_tool_name.unwrap_or(tool_name),
        "totalChars": char_count,
        "preview": preview,
        "hint": format!(
            "Output exceeded {threshold} chars and workspace scratchpad is read-only; narrow your query or filter output."
        )
    })))
}
