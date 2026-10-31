use std::cmp::Reverse;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, SearcherBuilder, Sink, SinkContext, SinkMatch};
use ignore::WalkBuilder;
use ignore::overrides::OverrideBuilder;
use serde_json::{Map, Value, json};

use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    assert_read_path_allowed, create_read_path_checker, normalize_and_validate_args,
    resolve_tool_path,
};

const MAX_GLOB_RESULTS: usize = 100;
const MAX_GREP_MATCHES: usize = 500;
const DEFAULT_GREP_TIMEOUT_SECS: u64 = 15;
const MAX_GREP_TIMEOUT_SECS: u64 = 120;

fn validate_glob_pattern(pattern: &str) -> ToolResult<()> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err(ToolError::InvalidArguments(
            "pattern must not be empty".to_owned(),
        ));
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err(ToolError::InvalidArguments(
            "pattern must be relative to the search directory, not an absolute path".to_owned(),
        ));
    }
    for comp in Path::new(trimmed).components() {
        if matches!(comp, Component::ParentDir) {
            return Err(ToolError::PathDenied(
                "Glob pattern may not contain '..' path traversal segments.".to_owned(),
            ));
        }
    }
    Ok(())
}

fn is_excluded_dir_name(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | ".ssh" | ".aws" | ".gnupg" | ".kube" | ".azure"
    )
}

pub struct GlobTool;

#[async_trait]
impl BuiltinTool for GlobTool {
    fn name(&self) -> &str {
        "glob"
    }

    fn description(&self) -> &str {
        "Fast in-process file path globbing sorted by modification time (newest first). Respects .gitignore rules."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to match files (e.g. '**/*.rs', 'src/**/*.ts')."
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in (defaults to working directory)."
                }
            },
            "required": ["pattern"]
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("pattern is required".to_owned()))?
            .to_owned();
        validate_glob_pattern(&pattern)?;

        let search_dir = match args.get("path").and_then(Value::as_str) {
            Some(p) if !p.trim().is_empty() => resolve_tool_path(p, &ctx.working_directory)?,
            _ => ctx.working_directory.clone(),
        };
        let root = assert_read_path_allowed(&search_dir, ctx)?;
        let ws_root = ctx.working_directory.clone();
        let checker = create_read_path_checker(ctx);
        let cancel_rx = ctx.cancel_rx.clone();

        tokio::task::spawn_blocking(move || -> ToolResult<ToolOutput> {
            let mut ov = OverrideBuilder::new(&root);
            ov.add(&pattern).map_err(|e| {
                ToolError::InvalidArguments(format!("Invalid glob pattern '{pattern}': {e}"))
            })?;
            let overrides = ov.build().map_err(|e| {
                ToolError::InvalidArguments(format!("Invalid glob overrides: {e}"))
            })?;

            let allow_hidden = pattern.starts_with('.') || pattern.contains("/.");
            let walker = WalkBuilder::new(&root)
                .hidden(!allow_hidden)
                .git_ignore(true)
                .git_global(false)
                .git_exclude(true)
                .require_git(false)
                .overrides(overrides)
                .filter_entry(|entry| {
                    if entry.depth() == 0 {
                        return true;
                    }
                    if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                        let name = entry.file_name().to_string_lossy();
                        return !is_excluded_dir_name(&name);
                    }
                    true
                })
                .build();

            let mut entries: Vec<(SystemTime, String)> = Vec::new();
            for item in walker {
                if cancel_rx.as_ref().is_some_and(|rx| *rx.borrow()) {
                    return Err(ToolError::Execution("Glob search aborted.".to_owned()));
                }
                let Ok(entry) = item else { continue };
                if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                    continue;
                }
                let entry_path = entry.path();
                if !checker(entry_path) {
                    continue;
                }
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                let rel = entry_path
                    .strip_prefix(&ws_root)
                    .unwrap_or(entry_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                entries.push((mtime, rel));
            }

            entries.sort_by(|a, b| Reverse(a.0).cmp(&Reverse(b.0)).then_with(|| a.1.cmp(&b.1)));
            let total = entries.len();
            let truncated = total > MAX_GLOB_RESULTS;
            let mut lines: Vec<String> = entries
                .into_iter()
                .take(MAX_GLOB_RESULTS)
                .map(|(_, p)| p)
                .collect();
            if lines.is_empty() {
                return Ok(ToolOutput::Text("No files found".to_owned()));
            }
            if truncated {
                lines.push(format!(
                    "\n(Results are truncated: showing {MAX_GLOB_RESULTS} of {total} matches. Narrow your pattern or path.)"
                ));
            }
            Ok(ToolOutput::Text(lines.join("\n")))
        })
        .await
        .map_err(|e| ToolError::Execution(format!("Glob task panicked: {e}")))?
    }
}

pub struct GrepTool;

struct FileMatchCollector<'a> {
    rel_path: &'a str,
    lines: &'a mut Vec<String>,
    match_count: &'a mut usize,
}

impl Sink for FileMatchCollector<'_> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &grep_searcher::Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        if *self.match_count >= MAX_GREP_MATCHES {
            return Ok(false);
        }
        *self.match_count += 1;
        let line_no = mat.line_number().unwrap_or(1);
        let text = String::from_utf8_lossy(mat.bytes());
        let trimmed = text.trim_end_matches(['\r', '\n']);
        self.lines
            .push(format!("{}:{line_no}:{trimmed}", self.rel_path));
        Ok(*self.match_count < MAX_GREP_MATCHES)
    }

    fn context(
        &mut self,
        _searcher: &grep_searcher::Searcher,
        ctx: &SinkContext<'_>,
    ) -> Result<bool, Self::Error> {
        if *self.match_count >= MAX_GREP_MATCHES {
            return Ok(false);
        }
        let line_no = ctx.line_number().unwrap_or(1);
        let text = String::from_utf8_lossy(ctx.bytes());
        let trimmed = text.trim_end_matches(['\r', '\n']);
        self.lines
            .push(format!("{}-{line_no}-{trimmed}", self.rel_path));
        Ok(true)
    }
}

#[async_trait]
impl BuiltinTool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }

    fn description(&self) -> &str {
        "Fast in-process regex content search across files (respects .gitignore and skips binary files)."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regular expression pattern to search for."
                },
                "path": {
                    "type": "string",
                    "description": "File or directory to search in (defaults to working directory)."
                },
                "fileGlob": {
                    "type": "string",
                    "description": "Optional glob filter for file names (e.g. '*.rs', '**/*.ts')."
                },
                "caseSensitive": {
                    "type": "boolean",
                    "description": "Case-sensitive matching (default: true)."
                },
                "contextLines": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10,
                    "description": "Lines of surrounding context before and after each match (default: 0)."
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_GREP_TIMEOUT_SECS,
                    "description": "Search timeout in seconds (default: 15, max: 120)."
                }
            },
            "required": ["pattern"]
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("pattern is required".to_owned()))?
            .to_owned();
        if pattern.is_empty() {
            return Err(ToolError::InvalidArguments(
                "pattern must not be empty".to_owned(),
            ));
        }

        let target = match args.get("path").and_then(Value::as_str) {
            Some(p) if !p.trim().is_empty() => resolve_tool_path(p, &ctx.working_directory)?,
            _ => ctx.working_directory.clone(),
        };
        let root = assert_read_path_allowed(&target, ctx)?;
        let file_glob = args
            .get("fileGlob")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let case_sensitive = args
            .get("caseSensitive")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let context_lines = args
            .get("contextLines")
            .and_then(Value::as_u64)
            .map_or(0usize, |n| (n as usize).min(10));
        let timeout_secs = args
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_GREP_TIMEOUT_SECS)
            .min(MAX_GREP_TIMEOUT_SECS);

        let ws_root = ctx.working_directory.clone();
        let checker = create_read_path_checker(ctx);
        let cancel_rx = ctx.cancel_rx.clone();

        tokio::task::spawn_blocking(move || -> ToolResult<ToolOutput> {
            let matcher = RegexMatcherBuilder::new()
                .case_insensitive(!case_sensitive)
                .line_terminator(Some(b'\n'))
                .build(&pattern)
                .map_err(|e| {
                    ToolError::InvalidArguments(format!("Invalid regex pattern '{pattern}': {e}"))
                })?;

            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(0))
                .line_number(true)
                .before_context(context_lines)
                .after_context(context_lines)
                .build();

            let deadline = Instant::now() + Duration::from_secs(timeout_secs);
            let mut output_lines = Vec::<String>::new();
            let mut match_count = 0usize;

            let meta = fs::metadata(&root).map_err(|e| {
                ToolError::Execution(format!("Search path not found '{}': {e}", root.display()))
            })?;

            if meta.is_file() {
                let rel = root
                    .strip_prefix(&ws_root)
                    .unwrap_or(&root)
                    .to_string_lossy()
                    .replace('\\', "/");
                let mut sink = FileMatchCollector {
                    rel_path: &rel,
                    lines: &mut output_lines,
                    match_count: &mut match_count,
                };
                let _ = searcher.search_path(&matcher, &root, &mut sink);
            } else {
                let mut walk = WalkBuilder::new(&root);
                walk.hidden(false)
                    .git_ignore(true)
                    .git_global(false)
                    .git_exclude(true)
                    .require_git(false);
                if let Some(glob_pat) = &file_glob {
                    let mut ov = OverrideBuilder::new(&root);
                    ov.add(glob_pat).map_err(|e| {
                        ToolError::InvalidArguments(format!("Invalid fileGlob '{glob_pat}': {e}"))
                    })?;
                    let built = ov.build().map_err(|e| {
                        ToolError::InvalidArguments(format!("Invalid fileGlob: {e}"))
                    })?;
                    walk.overrides(built);
                }
                walk.filter_entry(|entry| {
                    if entry.depth() == 0 {
                        return true;
                    }
                    if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                        let name = entry.file_name().to_string_lossy();
                        return !is_excluded_dir_name(&name);
                    }
                    true
                });

                let mut files: Vec<PathBuf> = Vec::new();
                for item in walk.build() {
                    if Instant::now() > deadline {
                        return Err(ToolError::Execution(format!(
                            "Grep timed out after {timeout_secs}s. Narrow your path or fileGlob."
                        )));
                    }
                    if cancel_rx.as_ref().is_some_and(|rx| *rx.borrow()) {
                        return Err(ToolError::Execution("Grep aborted.".to_owned()));
                    }
                    let Ok(entry) = item else { continue };
                    if entry.file_type().is_some_and(|ft| ft.is_file())
                        && checker(entry.path())
                    {
                        files.push(entry.into_path());
                    }
                }
                files.sort();

                for file_path in files {
                    if Instant::now() > deadline {
                        return Err(ToolError::Execution(format!(
                            "Grep timed out after {timeout_secs}s."
                        )));
                    }
                    if cancel_rx.as_ref().is_some_and(|rx| *rx.borrow()) {
                        return Err(ToolError::Execution("Grep aborted.".to_owned()));
                    }
                    let rel = file_path
                        .strip_prefix(&ws_root)
                        .unwrap_or(&file_path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    let mut sink = FileMatchCollector {
                        rel_path: &rel,
                        lines: &mut output_lines,
                        match_count: &mut match_count,
                    };
                    let _ = searcher.search_path(&matcher, &file_path, &mut sink);
                    if match_count >= MAX_GREP_MATCHES {
                        break;
                    }
                }
            }

            if output_lines.is_empty() {
                return Ok(ToolOutput::Text("No matches found".to_owned()));
            }
            if match_count >= MAX_GREP_MATCHES {
                output_lines.push(format!(
                    "\n[Results truncated at {MAX_GREP_MATCHES} matches; narrow pattern, path, or fileGlob]"
                ));
            }
            Ok(ToolOutput::Text(output_lines.join("\n")))
        })
        .await
        .map_err(|e| ToolError::Execution(format!("Grep task panicked: {e}")))?
    }
}
