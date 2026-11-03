//! Regressions for `write` (TS `mutationGuard.ts` / `writeFileAtomic`):
//! - A dangling symlink target is not a regular file (`fs.lstat`), so the write is refused
//!   instead of the link being replaced by the atomic rename.
//! - Overwrites and appends on an existing file larger than the encoding-sniff prefix keep the
//!   file's encoding / line endings and (for appends) its bytes verbatim.
#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::ProviderName;
use cowork_tools::{ToolError, ToolExecutionContext, ToolOutput, create_builtin_tools};
use serde_json::{Value, json};

fn ctx_for(base: &Path) -> (PathBuf, ToolExecutionContext) {
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    let ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    (ws, ctx)
}

async fn write(ctx: &ToolExecutionContext, args: Value) -> Result<ToolOutput, ToolError> {
    create_builtin_tools(ctx)["write"]
        .execute(serde_json::from_value(args).unwrap(), ctx)
        .await
}

#[tokio::test]
async fn write_refuses_a_dangling_symlink_target() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let link = ws.join("link.txt");
    std::os::unix::fs::symlink(ws.join("missing.txt"), &link).unwrap();

    for mode in ["overwrite", "append"] {
        let err = write(
            &ctx,
            json!({ "filePath": "link.txt", "content": "x", "mode": mode }),
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("not a regular file"),
            "{mode}: {err}"
        );
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "{mode}: the symlink was replaced"
        );
        assert!(!ws.join("missing.txt").exists());
    }
}

#[tokio::test]
async fn large_files_keep_encoding_and_bytes_on_overwrite_and_append() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());

    // > 1 MiB UTF-8 BOM + CRLF file whose sniff prefix ends inside a multi-byte character.
    let target = ws.join("big.txt");
    let mut existing = vec![0xEF, 0xBB, 0xBF];
    while existing.len() < 1024 * 1024 + 10 {
        existing.extend_from_slice("line \u{00e9}\u{4e2d}\r\n".as_bytes());
    }
    fs::write(&target, &existing).unwrap();

    write(
        &ctx,
        json!({ "filePath": "big.txt", "content": "tail\n", "mode": "append" }),
    )
    .await
    .unwrap();
    let appended = fs::read(&target).unwrap();
    assert_eq!(&appended[..existing.len()], &existing[..]);
    assert_eq!(&appended[existing.len()..], b"tail\r\n");

    write(&ctx, json!({ "filePath": "big.txt", "content": "a\nb\n" }))
        .await
        .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"\xEF\xBB\xBFa\r\nb\r\n");
}
