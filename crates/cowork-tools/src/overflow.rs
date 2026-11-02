use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use cowork_sandbox::SandboxPolicy;
use serde_json::json;

use crate::context::{
    ToolError, ToolExecutionContext, ToolOutput, ToolResult, assert_spill_path_allowed,
};

pub const DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS: usize = 25_000;
pub const TOOL_OUTPUT_PREVIEW_CHARS: usize = 5_000;

pub fn is_overflow_exempt_tool(tool_name: &str, inner_called_tool: Option<&str>) -> bool {
    const EXEMPT: &[&str] = &[
        "read",
        "skill",
        "toolSearch",
        "codeMode",
        "spawnAgent",
        "listAgents",
        "sendAgentInput",
        "waitForAgent",
        "inspectAgent",
        "resumeAgent",
        "closeAgent",
    ];
    if EXEMPT.contains(&tool_name) {
        return true;
    }
    if tool_name == "toolCall"
        && let Some(inner) = inner_called_tool
    {
        return EXEMPT.contains(&inner);
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

/// Ensures `dir` is a real (non-symlink) directory, creating it when missing. Returns whether
/// this call created it, so a later failure can remove it again.
fn ensure_non_symlink_private_dir(dir: &Path) -> Result<bool, String> {
    let mut created = false;
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
            created = true;
        }
        Err(err) => return Err(err.to_string()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(created)
}

/// Why a spill was not written to disk.
enum SpillFailure {
    /// The turn may not write and read the spill file (TS `assertCanSpill` threw).
    PolicyDenied,
    /// Refused because a scratchpad path component is a symlink.
    Symlink(String),
    /// Any other I/O failure.
    Io,
}

/// TS `maybeSpillToolOutputToWorkspace` write sequence: authorize the concrete spill file before
/// creating any directory, re-authorize once the directories exist and before writing, and
/// remove directories this call created if a later step fails.
fn write_spill_file(
    ctx: &ToolExecutionContext,
    target: &Path,
    contents: &str,
) -> Result<PathBuf, SpillFailure> {
    let scratchpad_dir = target.parent().ok_or(SpillFailure::Io)?;
    let cowork_dir = scratchpad_dir.parent().ok_or(SpillFailure::Io)?;
    let authorize = || {
        assert_spill_path_allowed(target, ctx)
            .map(|_| ())
            .map_err(|_| SpillFailure::PolicyDenied)
    };
    let classify = |err: String| {
        if err.contains("symlink") {
            SpillFailure::Symlink(err)
        } else {
            SpillFailure::Io
        }
    };

    authorize()?;
    let mut created: Vec<&Path> = Vec::new();
    let result = (|| -> Result<(), SpillFailure> {
        for dir in [cowork_dir, scratchpad_dir] {
            if ensure_non_symlink_private_dir(dir).map_err(classify)? {
                created.push(dir);
            }
        }
        authorize()?;
        if let Ok(meta) = fs::symlink_metadata(target)
            && meta.file_type().is_symlink()
        {
            return Err(SpillFailure::Symlink(
                "Refusing to overwrite symlink in scratchpad".to_owned(),
            ));
        }
        let mut opts = OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(target).map_err(|_| SpillFailure::Io)?;
        f.write_all(contents.as_bytes())
            .map_err(|_| SpillFailure::Io)
    })();
    if let Err(err) = result {
        for dir in created.iter().rev() {
            let _ = fs::remove_dir(dir);
        }
        return Err(err);
    }
    Ok(target.to_path_buf())
}

/// Spills an oversized tool result to `<workspace>/.cowork/.cowork-scratchpad/` when the turn
/// described by `ctx` may write and read that concrete file (see
/// [`assert_spill_path_allowed`]); otherwise returns an inline truncated preview.
pub fn maybe_spill_tool_output(
    tool_name: &str,
    call_id: &str,
    output: ToolOutput,
    ctx: &ToolExecutionContext,
    threshold_chars: Option<usize>,
) -> ToolResult<ToolOutput> {
    maybe_spill_tool_output_with_inner(tool_name, None, call_id, output, ctx, threshold_chars)
}

pub fn maybe_spill_tool_output_with_inner(
    tool_name: &str,
    inner_tool_name: Option<&str>,
    call_id: &str,
    output: ToolOutput,
    ctx: &ToolExecutionContext,
    threshold_chars: Option<usize>,
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
    let can_write_workspace = !ctx.read_only_role
        && matches!(
            ctx.sandbox_policy,
            SandboxPolicy::WorkspaceWrite { .. } | SandboxPolicy::DangerFullAccess { .. }
        );

    let mut hint = format!(
        "Output exceeded {threshold} chars and workspace scratchpad is read-only; narrow your query or filter output."
    );
    if can_write_workspace {
        let file_name = format!(
            "{}-{}.{ext}",
            sanitize_filename_segment(inner_tool_name.unwrap_or(tool_name)),
            sanitize_filename_segment(call_id)
        );
        let target = ctx
            .working_directory
            .join(".cowork")
            .join(".cowork-scratchpad")
            .join(file_name);

        match write_spill_file(ctx, &target, &serialized) {
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
            Err(SpillFailure::Symlink(err)) => {
                return Err(ToolError::PathDenied(err));
            }
            Err(SpillFailure::PolicyDenied) => {
                // TS `assertCanSpill` denial: truncate inline instead of writing outside the
                // turn's authorized write scope (e.g. a child scoped by `targetPaths`).
                hint = format!(
                    "Tool output truncated ({char_count} chars). Full output was not saved because this turn cannot write and read the spill file; narrow your query or filter output."
                );
            }
            Err(SpillFailure::Io) => {
                // Fall through to the inline truncation fallback.
            }
        }
    }

    Ok(ToolOutput::Json(json!({
        "overflow": true,
        "spilledToDisk": false,
        "tool": inner_tool_name.unwrap_or(tool_name),
        "totalChars": char_count,
        "preview": preview,
        "hint": hint
    })))
}
