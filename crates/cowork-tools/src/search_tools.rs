//! In-process `glob` and `grep`, matching the TS tools on `origin/main`
//! (`src/tools/glob.ts`, `src/tools/grep.ts`).
//!
//! * `glob` follows fast-glob with `dot: false`, `braceExpansion: false`,
//!   `followSymbolicLinks: false` and no ignore files: wildcards never match a dot-prefixed
//!   name unless the pattern segment itself starts with `.`, `.gitignore` is not consulted,
//!   `*.ts` only matches at the search root, and results are paths relative to the search
//!   directory, newest first, capped at `maxResults` (default 2000, max 10000).
//! * `grep` follows ripgrep's defaults as the TS tool invoked it (`rg --line-number [-i]
//!   [-C n] [--glob fileGlob] -- pattern <absolute path>`): hidden files are skipped,
//!   `.gitignore` (inside a git repository), `.ignore` and `.rgignore` are respected,
//!   `fileGlob` is an rg `--glob` (an override: a file or directory it matches is searched even
//!   when hidden or ignored, everything else keeps the normal rules), output paths are
//!   absolute, a single explicit file is printed without a filename, and there is no match cap
//!   beyond the 10MB output buffer. The timeout (default 300s, max 600s) covers the whole
//!   search, including reads inside one large file.
//!
//! Every searched file is checked and opened in one step ([`open_search_file`]): the read
//! check runs on the walked path, the open refuses a final-component symlink (`O_NOFOLLOW`),
//! the handle must be a regular file, and the handle's real path is re-checked. The search
//! then reads from that handle, never from the path, so a file swapped for a symlink to a
//! credential between the walk and the read is not opened.

use std::borrow::Cow;
use std::cell::Cell;
use std::cmp::Reverse;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use ignore::WalkBuilder;
use ignore::overrides::OverrideBuilder;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use crate::context::{
    BuiltinTool, PathFlavor, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput,
    ToolResult, assert_read_path_allowed, create_read_path_checker, lexical_tool_path,
    normalize_and_validate_args,
};

/// TS `glob` `maxResults` default (`.default(2000)`).
const DEFAULT_GLOB_MAX_RESULTS: u64 = 2000;
/// TS `glob` `maxResults` maximum (`.max(10000)`).
const MAX_GLOB_MAX_RESULTS: u64 = 10_000;
/// TS `grep` `DEFAULT_TIMEOUT_SECONDS`.
const DEFAULT_GREP_TIMEOUT_SECS: u64 = 300;
/// TS `grep` `MAX_TIMEOUT_SECONDS`.
const MAX_GREP_TIMEOUT_SECS: u64 = 600;
/// TS `grep` `contextLines` maximum (`.max(50)`).
const MAX_GREP_CONTEXT_LINES: u64 = 50;
/// TS `grep` ran rg with `maxBuffer: 1024 * 1024 * 10`; past it the run failed.
const GREP_MAX_OUTPUT_BYTES: usize = 1024 * 1024 * 10;

// ---------------------------------------------------------------------------------------------
// Checked, no-follow open (swap point for fs_tools' `open_read_checked`)
// ---------------------------------------------------------------------------------------------

/// Opens a file the search walk produced, checking and opening in one step.
///
/// * `checker` must allow `path` (the walked spelling, so lexical credential denies apply);
/// * the final component is opened with `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO swapped in
///   cannot block the open), so a symlink swapped in after the walk fails with `ELOOP`;
/// * the opened handle must be a regular file (`fstat`);
/// * where the platform can report it, the handle's real path must also pass `checker`, which
///   catches a swapped intermediate directory.
///
/// Local stand-in for the `open_read_checked(ctx, path) -> File` helper being added to
/// `fs_tools.rs`; callers only depend on "path + checker in, regular-file handle out".
pub(crate) fn open_search_file(path: &Path, checker: &dyn Fn(&Path) -> bool) -> io::Result<File> {
    if !checker(path) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("read access denied: {}", path.display()),
        ));
    }
    let file = open_no_follow(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a regular file: {}", path.display()),
        ));
    }
    if let Some(real) = handle_real_path(&file)
        && real != path
        && !checker(&real)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("read access denied: {}", real.display()),
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> io::Result<File> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing to follow symlink: {}", path.display()),
        ));
    }
    File::open(path)
}

#[cfg(target_os = "linux")]
fn handle_real_path(file: &File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(target_os = "macos")]
fn handle_real_path(file: &File) -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0u8; libc::PATH_MAX as usize + 1];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes (NUL-terminated) into `buf`, which is
    // PATH_MAX + 1 bytes long, and `file` keeps the descriptor open for the call.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return None;
    }
    let cstr = CStr::from_bytes_until_nul(&buf).ok()?;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(cstr.to_bytes())))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn handle_real_path(_file: &File) -> Option<PathBuf> {
    None
}

fn is_cancelled(cancel_rx: Option<&watch::Receiver<bool>>) -> bool {
    cancel_rx.is_some_and(|rx| *rx.borrow())
}

// ---------------------------------------------------------------------------------------------
// glob (fast-glob semantics)
// ---------------------------------------------------------------------------------------------

/// TS `assertSafeGlobPattern`: patterns stay relative to the search directory.
fn validate_glob_pattern(pattern: &str) -> ToolResult<()> {
    if pattern.trim().is_empty() {
        return Err(ToolError::InvalidArguments(
            "pattern must not be empty".to_owned(),
        ));
    }
    let body = pattern.strip_prefix('!').unwrap_or(pattern);
    let bytes = body.as_bytes();
    let drive_qualified = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\');
    if body.starts_with('/') || drive_qualified {
        return Err(ToolError::InvalidArguments(
            "glob blocked: pattern must be relative to cwd".to_owned(),
        ));
    }
    if Path::new(body)
        .components()
        .any(|comp| matches!(comp, Component::ParentDir))
    {
        return Err(ToolError::PathDenied(
            "glob blocked: pattern cannot escape cwd".to_owned(),
        ));
    }
    Ok(())
}

/// `X:` followed by `seps` (a drive-qualified path, never the drive-relative `X:foo`).
fn starts_with_drive_root(bytes: &[u8], seps: &[u8]) -> bool {
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && seps.contains(&bytes[2])
}

/// TS `isWin32ShapedPattern`: drive-qualified (`C:\`, `C:/`) or UNC (`\\server`), ignoring a
/// leading `!`.
fn is_win32_shaped_pattern(pattern: &str) -> bool {
    let body = pattern.strip_prefix('!').unwrap_or(pattern).as_bytes();
    starts_with_drive_root(body, b"\\/")
        || (body.len() >= 3 && body[0] == b'\\' && body[1] == b'\\' && !b"\\/".contains(&body[2]))
}

/// TS `normalizeGlobPattern`: rewrites `\` to `/` only on Windows (where `\` is always a
/// separator, never an escape) or when the pattern itself is Windows-shaped (drive-qualified
/// or UNC). On POSIX, plain patterns keep fast-glob escapes such as `\*` intact.
///
/// `flavor` is a parameter (production passes [`PathFlavor::host`]) so both behaviors are
/// testable on every host.
pub fn normalize_glob_pattern(pattern: &str, flavor: PathFlavor) -> Cow<'_, str> {
    if flavor == PathFlavor::Windows || is_win32_shaped_pattern(pattern) {
        Cow::Owned(pattern.replace('\\', "/"))
    } else {
        Cow::Borrowed(pattern)
    }
}

/// TS `splitAbsoluteGlob`: an absolute pattern becomes a search root (its static prefix up to
/// the last `/` before the first `*?[{`) plus a relative rest pattern. Drive roots stay
/// drive-QUALIFIED (`C:/`, never drive-relative `C:`) and UNC roots (`//server/share`) are
/// preserved. Relative and negated patterns return `None`. The pattern is first passed
/// through [`normalize_glob_pattern`], so the result always uses `/` separators.
pub fn split_absolute_glob(pattern: &str, flavor: PathFlavor) -> Option<(String, String)> {
    let normalized = normalize_glob_pattern(pattern, flavor);
    let bytes = normalized.as_bytes();
    let drive_qualified = starts_with_drive_root(bytes, b"/");
    let unc = bytes.len() >= 3 && bytes[0] == b'/' && bytes[1] == b'/' && bytes[2] != b'/';
    let posix_rooted = normalized.starts_with('/') && !unc;
    if !drive_qualified && !unc && !posix_rooted {
        return None;
    }
    let first_magic = normalized.find(['*', '?', '[', '{']);
    let static_prefix = first_magic.map_or(&*normalized, |idx| &normalized[..idx]);
    let last_slash = static_prefix.rfind('/')?;
    let mut root = normalized[..last_slash].to_owned();
    let rest = normalized[last_slash + 1..].to_owned();
    if root.is_empty() {
        root.push('/');
    }
    let root_bytes = root.as_bytes();
    if root_bytes.len() == 2 && root_bytes[0].is_ascii_alphabetic() && root_bytes[1] == b':' {
        root.push('/');
    }
    Some((root, rest))
}

#[derive(Debug)]
enum GlobSegment {
    /// `**`: zero or more path segments, none starting with `.`.
    Globstar,
    /// One path segment. `explicit_dot` is true when the pattern segment starts with a
    /// literal `.`, the only way (with `dot: false`) to match a dot-prefixed name.
    Part { regex: Regex, explicit_dot: bool },
}

/// A fast-glob/picomatch pattern compiled per path segment, evaluated as an NFA over the
/// directory walk so directories that cannot match are never entered.
#[derive(Debug)]
pub(crate) struct FastGlob {
    segments: Vec<GlobSegment>,
    /// A trailing `/` only matches directories; fast-glob's `onlyFiles` then yields nothing.
    matches_nothing: bool,
}

impl FastGlob {
    pub(crate) fn new(pattern: &str) -> Result<Self, String> {
        // A lone negative pattern selects nothing in fast-glob.
        if pattern.starts_with('!') && !pattern.starts_with("!(") {
            return Ok(Self {
                segments: Vec::new(),
                matches_nothing: true,
            });
        }
        let mut body = pattern;
        while let Some(rest) = body.strip_prefix("./") {
            body = rest;
        }
        let matches_nothing = body.ends_with('/');
        let mut segments = Vec::new();
        for raw in body.split('/').filter(|s| !s.is_empty() && *s != ".") {
            if raw == "**" {
                if !matches!(segments.last(), Some(GlobSegment::Globstar)) {
                    segments.push(GlobSegment::Globstar);
                }
                continue;
            }
            let source = format!("^(?:{})$", translate_glob_segment(raw));
            let regex = Regex::new(&source).map_err(|e| format!("Invalid glob pattern: {e}"))?;
            segments.push(GlobSegment::Part {
                regex,
                explicit_dot: raw.starts_with('.'),
            });
        }
        if segments.is_empty() {
            return Ok(Self {
                segments,
                matches_nothing: true,
            });
        }
        Ok(Self {
            segments,
            matches_nothing,
        })
    }

    fn closure(&self, mut states: Vec<usize>) -> Vec<usize> {
        let mut idx = 0;
        while idx < states.len() {
            let state = states[idx];
            if matches!(self.segments.get(state), Some(GlobSegment::Globstar))
                && !states.contains(&(state + 1))
            {
                states.push(state + 1);
            }
            idx += 1;
        }
        states.sort_unstable();
        states.dedup();
        states
    }

    pub(crate) fn start(&self) -> Vec<usize> {
        if self.matches_nothing {
            return Vec::new();
        }
        self.closure(vec![0])
    }

    pub(crate) fn step(&self, states: &[usize], name: &str) -> Vec<usize> {
        let dotted = name.starts_with('.');
        let mut next = Vec::new();
        for &state in states {
            let advanced = match self.segments.get(state) {
                Some(GlobSegment::Globstar) if !dotted => Some(state),
                Some(GlobSegment::Part {
                    regex,
                    explicit_dot,
                }) if (!dotted || *explicit_dot) && regex.is_match(name) => Some(state + 1),
                _ => None,
            };
            next.extend(advanced);
        }
        self.closure(next)
    }

    pub(crate) fn accepts(&self, states: &[usize]) -> bool {
        states.contains(&self.segments.len())
    }

    pub(crate) fn can_descend(&self, states: &[usize]) -> bool {
        states.iter().any(|&s| s < self.segments.len())
    }

    /// Whether `rel` (a `/`-separated path relative to the search root) is a file match.
    #[cfg(test)]
    pub(crate) fn is_match(&self, rel: &str) -> bool {
        let mut states = self.start();
        for name in rel.split('/') {
            states = self.step(&states, name);
        }
        self.accepts(&states)
    }
}

/// Translates one glob segment (no `/`) to a regex body, with picomatch syntax: `*`, `?`,
/// `[...]`/`[!...]` classes (POSIX `[:class:]` included), `\` escapes and the `@( )`,
/// `*( )`, `+( )`, `?( )` extglobs. Braces are literal (`braceExpansion: false`). The
/// negated `!( )` extglob has no regex equivalent here and is matched literally.
fn translate_glob_segment(segment: &str) -> String {
    let chars: Vec<char> = segment.chars().collect();
    let mut out = String::new();
    // Closing suffix for each open extglob group.
    let mut groups: Vec<&'static str> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            '\\' => {
                if let Some(escaped) = next {
                    out.push_str(&regex::escape(&escaped.to_string()));
                    i += 2;
                } else {
                    out.push_str(r"\\");
                    i += 1;
                }
                continue;
            }
            '*' | '?' | '+' | '@' if next == Some('(') => {
                groups.push(match c {
                    '*' => ")*",
                    '?' => ")?",
                    '+' => ")+",
                    _ => ")",
                });
                out.push_str("(?:");
                i += 2;
                continue;
            }
            '*' => {
                out.push_str(".*");
                while chars.get(i + 1) == Some(&'*') {
                    i += 1;
                }
            }
            '?' => out.push('.'),
            '|' if !groups.is_empty() => out.push('|'),
            ')' if !groups.is_empty() => {
                out.push_str(groups.pop().unwrap_or(")"));
            }
            '[' => {
                if let Some((class, consumed)) = translate_bracket(&chars[i..]) {
                    out.push_str(&class);
                    i += consumed;
                    continue;
                }
                out.push_str(r"\[");
            }
            other => out.push_str(&regex::escape(&other.to_string())),
        }
        i += 1;
    }
    // Unclosed extglob groups: close them so the regex still compiles.
    while let Some(suffix) = groups.pop() {
        out.push_str(suffix);
    }
    out
}

/// Translates a `[...]` bracket expression starting at `chars[0] == '['`. Returns the regex
/// class and the number of chars consumed, or `None` when there is no closing `]`.
fn translate_bracket(chars: &[char]) -> Option<(String, usize)> {
    let mut i = 1;
    let mut out = String::from("[");
    if matches!(chars.get(i), Some('!' | '^')) {
        out.push('^');
        i += 1;
    }
    let body_start = i;
    loop {
        let c = *chars.get(i)?;
        if c == ']' && i > body_start {
            out.push(']');
            return Some((out, i + 1));
        }
        if c == '[' && chars.get(i + 1) == Some(&':') {
            let rest: String = chars[i..].iter().collect();
            if let Some(end) = rest.find(":]") {
                out.push_str(&rest[..end + 2]);
                i += rest[..end + 2].chars().count();
                continue;
            }
        }
        if c == '\\' {
            let escaped = *chars.get(i + 1)?;
            out.push('\\');
            out.push(escaped);
            i += 2;
            continue;
        }
        let is_range = c == '-' && i > body_start && chars.get(i + 1).is_some_and(|n| *n != ']');
        if is_range {
            out.push('-');
        } else if matches!(c, '[' | ']' | '\\' | '^' | '&' | '~' | '-') {
            out.push('\\');
            out.push(c);
        } else {
            out.push(c);
        }
        i += 1;
    }
}

/// Walks `root` (never following symlinks), returning `(mtime, path relative to root)` for
/// every regular file the pattern matches and `checker` allows.
fn collect_glob_matches(
    root: &Path,
    glob: &FastGlob,
    max_results: usize,
    checker: &dyn Fn(&Path) -> bool,
    cancel_rx: Option<&watch::Receiver<bool>>,
) -> ToolResult<(Vec<(SystemTime, String)>, usize)> {
    let mut files: Vec<(SystemTime, String)> = Vec::new();
    let mut seen = 0usize;
    let start = glob.start();
    if !glob.can_descend(&start) {
        return Ok((files, seen));
    }
    let mut stack: Vec<(PathBuf, String, Vec<usize>)> =
        vec![(root.to_path_buf(), String::new(), start)];
    while let Some((dir, rel_dir, states)) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        for item in read_dir {
            if is_cancelled(cancel_rx) {
                return Err(ToolError::Execution("Cancelled by user".to_owned()));
            }
            let Ok(entry) = item else { continue };
            // `DirEntry::file_type` does not follow symlinks: a symlinked file or directory
            // is neither listed nor traversed (`followSymbolicLinks: false`, `onlyFiles`).
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name_os = entry.file_name();
            let name = name_os.to_string_lossy();
            let next = glob.step(&states, &name);
            if next.is_empty() {
                continue;
            }
            let rel = if rel_dir.is_empty() {
                name.into_owned()
            } else {
                format!("{rel_dir}/{name}")
            };
            if file_type.is_dir() {
                if glob.can_descend(&next) {
                    stack.push((entry.path(), rel, next));
                }
            } else if file_type.is_file() && glob.accepts(&next) {
                let path = entry.path();
                if !checker(&path) {
                    continue;
                }
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                seen += 1;
                files.push((mtime, rel));
                // TS `keepNewestCandidate`: bound memory to 2x the cap.
                if files.len() > max_results.saturating_mul(2) {
                    sort_newest_first(&mut files);
                    files.truncate(max_results);
                }
            }
        }
    }
    Ok((files, seen))
}

fn sort_newest_first(files: &mut [(SystemTime, String)]) {
    files.sort_by(|a, b| Reverse(a.0).cmp(&Reverse(b.0)).then_with(|| a.1.cmp(&b.1)));
}

pub struct GlobTool;

#[async_trait]
impl BuiltinTool for GlobTool {
    fn name(&self) -> &str {
        "glob"
    }

    fn description(&self) -> &str {
        "Find files matching a glob pattern. Returns paths sorted by modification time."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to match (e.g. **/*.ts)"
                },
                "cwd": {
                    "type": "string",
                    "description": "Directory to search from (defaults to working directory)"
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_GLOB_MAX_RESULTS,
                    "default": DEFAULT_GLOB_MAX_RESULTS,
                    "description": "Maximum files to return"
                }
            },
            "required": ["pattern"],
            "additionalProperties": false
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
        let raw_pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("pattern is required".to_owned()))?;
        let max_results = args
            .get("maxResults")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_GLOB_MAX_RESULTS)
            .clamp(1, MAX_GLOB_MAX_RESULTS) as usize;

        let mut cwd = args
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|p| !p.trim().is_empty())
            .map(str::to_owned);
        // TS: backslashes become `/` only on Windows or for Windows-shaped patterns; POSIX
        // fast-glob escapes like `\*` are preserved.
        let flavor = PathFlavor::host();
        let mut pattern = normalize_glob_pattern(raw_pattern, flavor).into_owned();
        if let Some((root, rest)) = split_absolute_glob(raw_pattern, flavor) {
            cwd = Some(root);
            pattern = rest;
        }
        validate_glob_pattern(&normalize_glob_pattern(&pattern, flavor))?;
        let glob = FastGlob::new(&pattern).map_err(|e| {
            ToolError::InvalidArguments(format!("Invalid glob pattern '{pattern}': {e}"))
        })?;

        let search_dir = match cwd {
            Some(p) => lexical_tool_path(&p, &ctx.working_directory)?,
            None => ctx.working_directory.clone(),
        };
        let root = assert_read_path_allowed(&search_dir, ctx)?;
        let checker = create_read_path_checker(ctx);
        let cancel_rx = ctx.cancel_rx.clone();

        tokio::task::spawn_blocking(move || -> ToolResult<ToolOutput> {
            if !root.is_dir() {
                return Err(ToolError::Execution(format!(
                    "glob cwd is not a directory: {}",
                    root.display()
                )));
            }
            let (mut files, seen) =
                collect_glob_matches(&root, &glob, max_results, &checker, cancel_rx.as_ref())?;
            sort_newest_first(&mut files);
            files.truncate(max_results);
            if files.is_empty() {
                return Ok(ToolOutput::Text("No files found.".to_owned()));
            }
            let listed = files
                .into_iter()
                .map(|(_, path)| path)
                .collect::<Vec<_>>()
                .join("\n");
            if seen > max_results {
                return Ok(ToolOutput::Text(format!(
                    "{listed}\n... truncated to {max_results} matches"
                )));
            }
            Ok(ToolOutput::Text(listed))
        })
        .await
        .map_err(|e| ToolError::Execution(format!("Glob task panicked: {e}")))?
    }
}

// ---------------------------------------------------------------------------------------------
// grep (ripgrep semantics)
// ---------------------------------------------------------------------------------------------

/// Why a grep run stopped early.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GrepStop {
    Timeout,
    Aborted,
}

/// Result of [`run_grep`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GrepOutcome {
    /// rg-formatted stdout (empty when nothing matched).
    Output(String),
    /// The output passed [`GREP_MAX_OUTPUT_BYTES`].
    Overflow,
    Stopped(GrepStop),
}

pub(crate) struct GrepParams<'a> {
    pub matcher: &'a RegexMatcher,
    pub context_lines: usize,
    pub file_glob: Option<&'a str>,
}

/// Accumulates rg's standard (non-heading, non-tty) output.
struct GrepPrinter {
    out: String,
    context_enabled: bool,
    overflowed: bool,
}

impl GrepPrinter {
    fn push(&mut self, line: &str) -> bool {
        self.out.push_str(line);
        self.out.push('\n');
        if self.out.len() > GREP_MAX_OUTPUT_BYTES {
            self.overflowed = true;
            return false;
        }
        true
    }
}

struct FileSink<'a> {
    /// `None` when rg was handed a single file (no filename prefix).
    path: Option<&'a str>,
    printer: &'a mut GrepPrinter,
    started: bool,
}

impl FileSink<'_> {
    fn emit(&mut self, sep: char, line_number: Option<u64>, bytes: &[u8]) -> bool {
        // rg separates context groups of different files with `--` too.
        if !self.started {
            self.started = true;
            if self.printer.context_enabled && !self.printer.out.is_empty() && !self.push("--") {
                return false;
            }
        }
        let text = String::from_utf8_lossy(bytes);
        let text = text.strip_suffix('\n').unwrap_or(&text);
        let line_number = line_number.unwrap_or(1);
        let line = match self.path {
            Some(path) => format!("{path}{sep}{line_number}{sep}{text}"),
            None => format!("{line_number}{sep}{text}"),
        };
        self.push(&line)
    }

    fn push(&mut self, line: &str) -> bool {
        self.printer.push(line)
    }
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
        Ok(self.emit(':', mat.line_number(), mat.bytes()))
    }

    fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
        Ok(self.emit('-', ctx.line_number(), ctx.bytes()))
    }

    fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
        if self.printer.context_enabled {
            return Ok(self.push("--"));
        }
        Ok(true)
    }
}

/// Wraps a file handle so the stop check (timeout / cancel) runs on every buffer refill,
/// i.e. inside a single large file and not only between files.
struct StopAwareReader<'a, R> {
    inner: R,
    should_stop: &'a dyn Fn() -> Option<GrepStop>,
    stopped: &'a Cell<Option<GrepStop>>,
}

impl<R: Read> Read for StopAwareReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if let Some(reason) = (self.should_stop)() {
            self.stopped.set(Some(reason));
            return Err(io::Error::other("grep stopped"));
        }
        self.inner.read(buf)
    }
}

fn search_one(
    searcher: &mut Searcher,
    params: &GrepParams<'_>,
    file: File,
    display: Option<&str>,
    printer: &mut GrepPrinter,
    should_stop: &dyn Fn() -> Option<GrepStop>,
) -> Option<GrepOutcome> {
    let stopped = Cell::new(None);
    let reader = StopAwareReader {
        inner: file,
        should_stop,
        stopped: &stopped,
    };
    let sink = FileSink {
        path: display,
        printer,
        started: false,
    };
    // Per-file read errors are skipped, like rg (which reports them on stderr).
    let _ = searcher.search_reader(params.matcher, reader, sink);
    if let Some(reason) = stopped.get() {
        return Some(GrepOutcome::Stopped(reason));
    }
    if printer.overflowed {
        return Some(GrepOutcome::Overflow);
    }
    None
}

/// Runs a grep over `root` (a file or directory) with ripgrep's defaults.
pub(crate) fn run_grep(
    root: &Path,
    params: &GrepParams<'_>,
    checker: &dyn Fn(&Path) -> bool,
    should_stop: &dyn Fn() -> Option<GrepStop>,
) -> ToolResult<GrepOutcome> {
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(0))
        .line_number(true)
        .before_context(params.context_lines)
        .after_context(params.context_lines)
        .build();
    let mut printer = GrepPrinter {
        out: String::new(),
        context_enabled: params.context_lines > 0,
        overflowed: false,
    };

    let meta = fs::metadata(root).map_err(|e| {
        ToolError::Execution(format!("Search path not found '{}': {e}", root.display()))
    })?;

    if meta.is_file() {
        // rg searches an explicit file path regardless of hidden/ignore/--glob rules and prints
        // matches without a filename.
        let file = open_search_file(root, checker).map_err(|e| {
            ToolError::Execution(format!("grep could not open '{}': {e}", root.display()))
        })?;
        if let Some(outcome) =
            search_one(&mut searcher, params, file, None, &mut printer, should_stop)
        {
            return Ok(outcome);
        }
        return Ok(GrepOutcome::Output(printer.out));
    }

    let mut walk = WalkBuilder::new(root);
    walk.hidden(true)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(true)
        .follow_links(false)
        .add_custom_ignore_filename(".rgignore")
        .sort_by_file_path(|a, b| a.cmp(b));
    if let Some(glob_pat) = params.file_glob {
        let mut ov = OverrideBuilder::new(root);
        ov.add(glob_pat).map_err(|e| {
            ToolError::InvalidArguments(format!("Invalid fileGlob '{glob_pat}': {e}"))
        })?;
        let built = ov
            .build()
            .map_err(|e| ToolError::InvalidArguments(format!("Invalid fileGlob: {e}")))?;
        walk.overrides(built);
    }
    walk.filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        if entry.file_type().is_some_and(|ft| ft.is_dir()) {
            return !is_never_searched_dir_name(&entry.file_name().to_string_lossy());
        }
        true
    });

    for item in walk.build() {
        if let Some(reason) = should_stop() {
            return Ok(GrepOutcome::Stopped(reason));
        }
        let Ok(entry) = item else { continue };
        // The walker reports the entry's own type (no symlink following).
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let path = entry.path();
        let Ok(file) = open_search_file(path, checker) else {
            continue;
        };
        let display = path.to_string_lossy();
        if let Some(outcome) = search_one(
            &mut searcher,
            params,
            file,
            Some(&display),
            &mut printer,
            should_stop,
        ) {
            return Ok(outcome);
        }
    }
    Ok(GrepOutcome::Output(printer.out))
}

/// Directories grep never enters, even when `fileGlob` would whitelist them: VCS internals
/// and credential stores. (rg with `--glob '**/*'` would descend into these; the deny is a
/// deliberate safety floor on top of the per-file read checks.)
fn is_never_searched_dir_name(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".ssh" | ".aws" | ".gnupg" | ".kube" | ".azure"
    )
}

/// The stop check used by the tool: the whole-search deadline, then user cancellation.
fn deadline_stop_check(
    deadline: Instant,
    cancel_rx: Option<watch::Receiver<bool>>,
) -> impl Fn() -> Option<GrepStop> {
    move || {
        if is_cancelled(cancel_rx.as_ref()) {
            return Some(GrepStop::Aborted);
        }
        if Instant::now() >= deadline {
            return Some(GrepStop::Timeout);
        }
        None
    }
}

pub struct GrepTool;

#[async_trait]
impl BuiltinTool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }

    fn description(&self) -> &str {
        "Search file contents for a regex pattern using ripgrep (rg). Returns matching lines with filenames and line numbers. Defaults to a 300s timeout."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern"
                },
                "path": {
                    "type": "string",
                    "description": "File or directory to search"
                },
                "fileGlob": {
                    "type": "string",
                    "description": "Glob to filter files (e.g. *.ts)"
                },
                "contextLines": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": MAX_GREP_CONTEXT_LINES,
                    "description": "Context lines around matches"
                },
                "caseSensitive": {
                    "type": "boolean",
                    "default": true
                },
                "timeoutSeconds": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_GREP_TIMEOUT_SECS,
                    "description": format!(
                        "Maximum time for the search in seconds. Defaults to {DEFAULT_GREP_TIMEOUT_SECS}s; max {MAX_GREP_TIMEOUT_SECS}s."
                    )
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
        let timeout_secs = args
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_GREP_TIMEOUT_SECS)
            .clamp(1, MAX_GREP_TIMEOUT_SECS);
        // The TS deadline starts before path validation and covers the whole search.
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);

        let target = match args.get("path").and_then(Value::as_str) {
            Some(p) if !p.trim().is_empty() => lexical_tool_path(p, &ctx.working_directory)?,
            _ => ctx.working_directory.clone(),
        };
        let root = assert_read_path_allowed(&target, ctx)?;
        let file_glob = args
            .get("fileGlob")
            .and_then(Value::as_str)
            .filter(|g| !g.is_empty())
            .map(str::to_owned);
        let case_sensitive = args
            .get("caseSensitive")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let context_lines = args
            .get("contextLines")
            .and_then(Value::as_u64)
            .map_or(0, |n| n.min(MAX_GREP_CONTEXT_LINES)) as usize;

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
            let params = GrepParams {
                matcher: &matcher,
                context_lines,
                file_glob: file_glob.as_deref(),
            };
            let should_stop = deadline_stop_check(deadline, cancel_rx);
            let text = match run_grep(&root, &params, &checker, &should_stop)? {
                GrepOutcome::Output(out) if out.is_empty() => "No matches found.".to_owned(),
                GrepOutcome::Output(out) => out,
                GrepOutcome::Overflow => format!(
                    "grep failed: output exceeded the {GREP_MAX_OUTPUT_BYTES}-byte buffer (ERR_CHILD_PROCESS_STDIO_MAXBUFFER). Narrow pattern, path, or fileGlob."
                ),
                GrepOutcome::Stopped(GrepStop::Timeout) => {
                    format!("grep timed out after {timeout_secs}s.")
                }
                GrepOutcome::Stopped(GrepStop::Aborted) => "grep aborted.".to_owned(),
            };
            Ok(ToolOutput::Text(text))
        })
        .await
        .map_err(|e| ToolError::Execution(format!("Grep task panicked: {e}")))?
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::io::Write;

    use super::*;

    fn allow_all(_: &Path) -> bool {
        true
    }

    #[test]
    fn fast_glob_dot_and_segment_semantics() {
        let cases: &[(&str, &str, bool)] = &[
            ("**/*", "a.ts", true),
            ("**/*", ".env", false),
            ("**/*", ".venv/x.ts", false),
            ("**/*", "src/.hidden.ts", false),
            ("**/*", "node_modules/p/n.ts", true),
            ("*.ts", "a.ts", true),
            ("*.ts", "src/b.ts", false),
            ("**/*.ts", "src/b.ts", true),
            ("**/*.ts", "a.ts", true),
            (".*", ".env", true),
            ("**/.*", "src/.hidden.ts", true),
            ("**/.*", ".venv/.x", false),
            (".venv/**", ".venv/v.ts", true),
            ("**/.hid/*", "src/.hid/c.ts", true),
            ("lit{a,b}.ts", "lit{a,b}.ts", true),
            ("{a,b}.ts", "a.ts", false),
            ("sub/**", "sub/deep/d.ts", true),
            ("src/**/*.ts", "src/b.ts", true),
            ("src/**/*.ts", "src/x/y/b.ts", true),
            ("[ab].ts", "a.ts", true),
            ("[!a].ts", "a.ts", false),
            ("[!a].ts", "b.ts", true),
            ("+(a|b).ts", "a.ts", true),
            ("@(a).ts", "b.ts", false),
            ("?.ts", "a.ts", true),
            ("?.ts", "ab.ts", false),
            ("./src/*", "src/b.ts", true),
            (r"\*.ts", "*.ts", true),
            (r"\*.ts", "a.ts", false),
            ("sub/**/", "sub/deep/d.ts", false),
            ("!a.ts", "a.ts", false),
        ];
        for (pattern, path, expected) in cases {
            let glob = FastGlob::new(pattern).unwrap();
            assert_eq!(glob.is_match(path), *expected, "{pattern} vs {path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn open_search_file_refuses_symlinks_and_non_regular_files() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target.txt");
        fs::write(&target, "secret").unwrap();
        let link = tmp.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(open_search_file(&target, &allow_all).is_ok());
        // O_NOFOLLOW: a symlink swapped in for a walked file is never opened.
        let err = open_search_file(&link, &allow_all).unwrap_err();
        assert_ne!(err.kind(), io::ErrorKind::NotFound, "{err}");
        // fstat: directories (and other non-regular files) are refused.
        assert!(open_search_file(tmp.path(), &allow_all).is_err());
        // The checker runs on the walked path before anything is opened.
        let deny = |_: &Path| false;
        assert_eq!(
            open_search_file(&target, &deny).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn open_search_file_rechecks_the_handle_real_path() {
        let tmp = tempfile::tempdir().unwrap();
        let real_dir = tmp.path().join("secret-dir");
        fs::create_dir_all(&real_dir).unwrap();
        fs::write(real_dir.join("f.txt"), "secret").unwrap();
        // An intermediate directory swapped for a symlink: O_NOFOLLOW only covers the final
        // component, so the real-path re-check must catch it.
        let alias_dir = tmp.path().join("alias");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();
        let deny_secret = |p: &Path| !p.starts_with(&real_dir);
        let err = open_search_file(&alias_dir.join("f.txt"), &deny_secret).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    fn big_file(dir: &Path, lines: usize) -> PathBuf {
        let path = dir.join("big.txt");
        let mut f = fs::File::create(&path).unwrap();
        writeln!(f, "needle first").unwrap();
        for i in 0..lines {
            writeln!(
                f,
                "filler line {i} with some padding text to make it longer"
            )
            .unwrap();
        }
        writeln!(f, "needle last").unwrap();
        path
    }

    #[test]
    fn timeout_is_applied_within_a_single_large_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = big_file(tmp.path(), 200_000); // ~12MB, many buffer refills
        let matcher = RegexMatcherBuilder::new().build("needle").unwrap();
        let params = GrepParams {
            matcher: &matcher,
            context_lines: 0,
            file_glob: None,
        };

        // Unbounded run sees both matches.
        let full = run_grep(&path, &params, &allow_all, &|| None).unwrap();
        assert_eq!(
            full,
            GrepOutcome::Output("1:needle first\n200002:needle last\n".to_owned())
        );

        // The stop check fires on the third read of the same file: the search stops mid-file.
        let reads = Cell::new(0usize);
        let stop_mid_file = || {
            reads.set(reads.get() + 1);
            (reads.get() >= 3).then_some(GrepStop::Timeout)
        };
        let outcome = run_grep(&path, &params, &allow_all, &stop_mid_file).unwrap();
        assert_eq!(outcome, GrepOutcome::Stopped(GrepStop::Timeout));
        assert_eq!(reads.get(), 3, "stopped inside the file, not after it");

        // The production deadline check: an elapsed deadline stops a single-file search, which
        // has no between-files checkpoint at all.
        let expired = deadline_stop_check(Instant::now(), None);
        let outcome = run_grep(&path, &params, &allow_all, &expired).unwrap();
        assert_eq!(outcome, GrepOutcome::Stopped(GrepStop::Timeout));
    }
}
