use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const MODEL_SCRATCHPAD_DIRNAME: &str = ".ModelScratchpad";
pub const WORKFLOW_INLINE_PROMPT_CHARS: usize = 20_000;
pub const WORKFLOW_MAX_PROMPT_CHARS: usize = 2_000_000;
const DEFAULT_INPUT_FORMAT: &str = "md";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowInputSpill {
    pub prompt: String,
    pub absolute_path: PathBuf,
    pub target_path: String,
    pub chars: usize,
    pub format: String,
}

pub fn normalize_workflow_input_format(raw: Option<&str>) -> Result<String, String> {
    let trimmed = raw
        .map(str::trim)
        .map(|s| s.trim_start_matches('.'))
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| DEFAULT_INPUT_FORMAT.to_owned());

    let bytes = trimmed.as_bytes();
    if bytes.is_empty() || bytes.len() > 16 {
        return Err(format!(
            "invalid workflow input format {:?}: use 1-16 letters, digits, underscores, or hyphens",
            raw.unwrap_or_default()
        ));
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return Err(format!(
            "invalid workflow input format {:?}: use 1-16 letters, digits, underscores, or hyphens",
            raw.unwrap_or_default()
        ));
    }
    if !bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
    {
        return Err(format!(
            "invalid workflow input format {:?}: use 1-16 letters, digits, underscores, or hyphens",
            raw.unwrap_or_default()
        ));
    }
    Ok(trimmed)
}

fn format_with_commas(mut n: usize) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    let mut groups = Vec::new();
    while n > 0 {
        if n >= 1000 {
            groups.push(format!("{:03}", n % 1000));
        } else {
            groups.push(n.to_string());
        }
        n /= 1000;
    }
    groups.reverse();
    groups.join(",")
}

fn assert_safe_input_directories(working_directory: &Path) -> Result<(), String> {
    let dirs = [
        working_directory.join(MODEL_SCRATCHPAD_DIRNAME),
        working_directory
            .join(MODEL_SCRATCHPAD_DIRNAME)
            .join("workflows"),
        working_directory
            .join(MODEL_SCRATCHPAD_DIRNAME)
            .join("workflows")
            .join("inputs"),
    ];
    for dir in dirs {
        match fs::symlink_metadata(&dir) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(format!("{} must not be a symbolic link", dir.display()));
                }
                if !meta.is_dir() {
                    return Err(format!("{} exists but is not a directory", dir.display()));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("failed inspecting {}: {e}", dir.display())),
        }
    }
    Ok(())
}

fn open_safe_workflow_input(absolute_path: &Path) -> Result<File, std::io::Error> {
    let expected = fs::symlink_metadata(absolute_path)?;
    if expected.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{} must not be a symbolic link", absolute_path.display()),
        ));
    }
    if !expected.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{} must be a regular file", absolute_path.display()),
        ));
    }

    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(absolute_path)?;
    let actual = file.metadata()?;
    if !actual.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "{} changed while it was being opened",
                absolute_path.display()
            ),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if actual.dev() != expected.dev() || actual.ino() != expected.ino() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "{} changed while it was being opened",
                    absolute_path.display()
                ),
            ));
        }
        if actual.nlink() != 1 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{} must not have hard links", absolute_path.display()),
            ));
        }
    }
    Ok(file)
}

fn read_existing_workflow_input(absolute_path: &Path) -> Result<Option<String>, String> {
    match open_safe_workflow_input(absolute_path) {
        Ok(mut f) => {
            let mut s = String::new();
            f.read_to_string(&mut s)
                .map_err(|e| format!("failed reading {}: {e}", absolute_path.display()))?;
            Ok(Some(s))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn spill_workflow_prompt_to_file(
    prompt: &str,
    working_directory: &Path,
    format: Option<&str>,
) -> Result<WorkflowInputSpill, String> {
    let char_count = prompt.chars().count();
    if char_count > WORKFLOW_MAX_PROMPT_CHARS {
        return Err(format!(
            "workflow prompt exceeds {WORKFLOW_MAX_PROMPT_CHARS} character limit"
        ));
    }

    let fmt = normalize_workflow_input_format(format)?;
    let mut hasher = Sha256::new();
    hasher.update(fmt.as_bytes());
    hasher.update(b"\0");
    hasher.update(prompt.as_bytes());
    let digest = hex::encode(hasher.finalize());

    let rel_target = format!("{MODEL_SCRATCHPAD_DIRNAME}/workflows/inputs/{digest}.{fmt}");
    let input_dir = working_directory
        .join(MODEL_SCRATCHPAD_DIRNAME)
        .join("workflows")
        .join("inputs");
    let absolute_path = input_dir.join(format!("{digest}.{fmt}"));

    assert_safe_input_directories(working_directory)?;
    fs::create_dir_all(&input_dir)
        .map_err(|e| format!("failed creating {}: {e}", input_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for dir in [
            working_directory.join(MODEL_SCRATCHPAD_DIRNAME),
            working_directory
                .join(MODEL_SCRATCHPAD_DIRNAME)
                .join("workflows"),
            input_dir.clone(),
        ] {
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }
    }
    assert_safe_input_directories(working_directory)?;

    let existing = read_existing_workflow_input(&absolute_path)?;
    if let Some(ref prev) = existing
        && prev != prompt
    {
        return Err(format!(
            "workflow input hash collision at {}",
            absolute_path.display()
        ));
    }

    if existing.is_none() {
        let temp_path = input_dir.join(format!("{digest}.{fmt}.{}.tmp", Uuid::new_v4()));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o400);
        }
        let mut temp_file = opts
            .open(&temp_path)
            .map_err(|e| format!("failed creating temp workflow input file: {e}"))?;
        if let Err(e) = temp_file
            .write_all(prompt.as_bytes())
            .and_then(|_| temp_file.sync_all())
        {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("failed writing workflow input file: {e}"));
        }
        drop(temp_file);

        if let Err(rename_err) = fs::rename(&temp_path, &absolute_path) {
            let _ = fs::remove_file(&temp_path);
            let concurrent = read_existing_workflow_input(&absolute_path).ok().flatten();
            if concurrent.as_deref() != Some(prompt) {
                return Err(format!(
                    "failed finalizing workflow input file {}: {rename_err}",
                    absolute_path.display()
                ));
            }
        } else {
            let _ = fs::remove_file(&temp_path);
        }
    }

    let verified = open_safe_workflow_input(&absolute_path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = verified.set_permissions(fs::Permissions::from_mode(0o400));
    }
    drop(verified);

    let formatted_chars = format_with_commas(char_count);
    let pointer_prompt = [
        format!(
            "This workflow input contains {formatted_chars} characters and is file-backed so no detail is truncated."
        ),
        format!("Input file: {rel_target}"),
        "Use the read tool to read the file completely before doing any work.".to_owned(),
        "If read reports that a line continues, keep reading that same line with the exact offset, columnOffset, and limit values it provides until no continuation remains.".to_owned(),
        "Treat the file contents as the complete task, including every instruction, source, report, and data section.".to_owned(),
    ]
    .join("\n");

    Ok(WorkflowInputSpill {
        prompt: pointer_prompt,
        absolute_path,
        target_path: rel_target,
        chars: char_count,
        format: fmt,
    })
}
