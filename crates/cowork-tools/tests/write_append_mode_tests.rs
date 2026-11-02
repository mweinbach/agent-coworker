//! Regression: the `write` tool honours TS `write.ts`'s `mode: "overwrite" | "append"` argument.
//! Bundled system prompts tell models to generate long documents with an overwrite chunk followed
//! by append chunks, so an append must keep the existing file contents instead of replacing them.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_tools::{
    ApprovalDecisionRequest, ApprovalHandler, ToolError, ToolExecutionContext, ToolOutput,
    create_builtin_tools,
};
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
    let tools = create_builtin_tools(ctx);
    tools["write"]
        .execute(serde_json::from_value(args).unwrap(), ctx)
        .await
}

fn text(out: ToolOutput) -> String {
    out.as_text().expect("text output")
}

#[tokio::test]
async fn schema_advertises_ts_mode_enum_with_overwrite_default() {
    let tmp = tempfile::tempdir().unwrap();
    let (_ws, ctx) = ctx_for(tmp.path());
    let tools = create_builtin_tools(&ctx);
    let schema = tools["write"].input_schema();
    assert_eq!(
        schema["properties"]["mode"],
        json!({
            "type": "string",
            "enum": ["overwrite", "append"],
            "default": "overwrite",
            "description": "Use overwrite for a full replacement, or append to add a chunk"
        })
    );
    assert_eq!(schema["required"], json!(["filePath", "content"]));
}

#[tokio::test]
async fn append_to_existing_file_preserves_prior_content() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let target = ws.join("doc.md");
    fs::write(&target, "# Title\n\nchunk one\n").unwrap();

    let out = write(
        &ctx,
        json!({ "filePath": "doc.md", "content": "chunk two\n", "mode": "append" }),
    )
    .await
    .expect("append succeeds");
    assert_eq!(
        text(out),
        format!("Appended 10 chars to {}", target.display())
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "# Title\n\nchunk one\nchunk two\n"
    );

    // No separator is inserted: chunks are concatenated exactly, as in TS.
    write(
        &ctx,
        json!({ "filePath": "doc.md", "content": "tail", "mode": "append" }),
    )
    .await
    .unwrap();
    write(
        &ctx,
        json!({ "filePath": "doc.md", "content": "\u{1F30D}", "mode": "append" }),
    )
    .await
    .map(|out| {
        assert_eq!(
            text(out),
            format!("Appended 2 chars to {}", target.display())
        )
    })
    .unwrap();
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "# Title\n\nchunk one\nchunk two\ntail\u{1F30D}"
    );
}

#[tokio::test]
async fn overwrite_then_append_builds_a_chunked_document() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    fs::write(ws.join("out.txt"), "stale contents from an earlier run\n").unwrap();

    write(
        &ctx,
        json!({ "filePath": "out.txt", "content": "part 1\n", "mode": "overwrite" }),
    )
    .await
    .unwrap();
    write(
        &ctx,
        json!({ "filePath": "out.txt", "content": "part 2\n", "mode": "append" }),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(ws.join("out.txt")).unwrap(),
        "part 1\npart 2\n"
    );
}

#[tokio::test]
async fn append_keeps_existing_bytes_and_matches_encoding_and_eol() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());

    // CRLF-dominant UTF-8 BOM file with one stray LF: prior bytes are kept verbatim (never
    // re-normalized), the chunk takes the dominant CRLF, and no second BOM is written.
    let bom_crlf = ws.join("bom_crlf.txt");
    fs::write(&bom_crlf, b"\xEF\xBB\xBFa\r\nb\nc\r\n").unwrap();
    write(
        &ctx,
        json!({ "filePath": "bom_crlf.txt", "content": "\u{feff}d\ne\n", "mode": "append" }),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read(&bom_crlf).unwrap(),
        b"\xEF\xBB\xBFa\r\nb\nc\r\nd\r\ne\r\n".to_vec()
    );

    // UTF-16LE BOM file: the chunk is encoded as UTF-16LE without another BOM.
    let utf16 = ws.join("wide.txt");
    let mut wide = vec![0xFF, 0xFE];
    for u in "x\n".encode_utf16() {
        wide.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(&utf16, &wide).unwrap();
    write(
        &ctx,
        json!({ "filePath": "wide.txt", "content": "y\n", "mode": "append" }),
    )
    .await
    .unwrap();
    let mut expected = wide.clone();
    for u in "y\n".encode_utf16() {
        expected.extend_from_slice(&u.to_le_bytes());
    }
    assert_eq!(fs::read(&utf16).unwrap(), expected);

    // A file that is not decodable text gets the raw UTF-8 chunk appended, as TS did.
    let binary = ws.join("blob.bin");
    fs::write(&binary, b"\x00\x01\xFFbin").unwrap();
    write(
        &ctx,
        json!({ "filePath": "blob.bin", "content": "tail\r\n", "mode": "append" }),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read(&binary).unwrap(),
        b"\x00\x01\xFFbintail\r\n".to_vec()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn append_preserves_file_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let target = ws.join("script.sh");
    fs::write(&target, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o750)).unwrap();

    write(
        &ctx,
        json!({ "filePath": "script.sh", "content": "echo hi\n", "mode": "append" }),
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "#!/bin/sh\necho hi\n");
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o750
    );
}

#[tokio::test]
async fn append_to_missing_file_creates_it_with_parent_directories() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let target = ws.join("new").join("nested").join("log.txt");

    let out = write(
        &ctx,
        json!({ "filePath": "new/nested/log.txt", "content": "first\r\n", "mode": "append" }),
    )
    .await
    .expect("append creates the file");
    assert_eq!(
        text(out),
        format!("Appended 7 chars to {}", target.display())
    );
    assert_eq!(fs::read(&target).unwrap(), b"first\r\n".to_vec());
}

#[tokio::test]
async fn overwrite_still_replaces_explicitly_and_by_default() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let target = ws.join("file.txt");
    fs::write(&target, "old contents\n").unwrap();

    let out = write(
        &ctx,
        json!({ "filePath": "file.txt", "content": "new\n", "mode": "overwrite" }),
    )
    .await
    .unwrap();
    assert_eq!(text(out), format!("Updated {} (4 bytes)", target.display()));
    assert_eq!(fs::read_to_string(&target).unwrap(), "new\n");

    write(
        &ctx,
        json!({ "filePath": "file.txt", "content": "newer\n" }),
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "newer\n");

    // An omitted (null) optional mode falls back to the overwrite default.
    write(
        &ctx,
        json!({ "filePath": "file.txt", "content": "newest\n", "mode": null }),
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "newest\n");
}

#[tokio::test]
async fn invalid_mode_is_rejected_without_touching_the_file() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let target = ws.join("file.txt");
    fs::write(&target, "keep me\n").unwrap();

    for mode in [json!("prepend"), json!("Append"), json!(true)] {
        let err = write(
            &ctx,
            json!({ "filePath": "file.txt", "content": "x", "mode": mode }),
        )
        .await
        .expect_err("invalid mode must be rejected");
        assert!(
            matches!(err, ToolError::InvalidArguments(_)),
            "unexpected error for {mode}: {err}"
        );
        assert!(err.to_string().contains("Invalid tool arguments"), "{err}");
    }
    assert_eq!(fs::read_to_string(&target).unwrap(), "keep me\n");
}

struct DenyingApprover {
    calls: AtomicUsize,
}

#[async_trait]
impl ApprovalHandler for DenyingApprover {
    async fn approve_command(&self, _req: ApprovalDecisionRequest) -> Result<bool, String> {
        Ok(false)
    }

    async fn approve_file_change(
        &self,
        _path: &Path,
        _reason: Option<&str>,
    ) -> Result<bool, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(false)
    }

    async fn ask_user(
        &self,
        _question: &str,
        _options: Option<Vec<String>>,
    ) -> Result<String, String> {
        Err("not supported in this test".to_owned())
    }
}

#[tokio::test]
async fn append_goes_through_the_same_approval_and_path_gates_as_overwrite() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, mut ctx) = ctx_for(tmp.path());
    let target = ws.join("file.txt");
    fs::write(&target, "original\n").unwrap();

    let approver = Arc::new(DenyingApprover {
        calls: AtomicUsize::new(0),
    });
    ctx.approval_handler = Some(approver.clone());
    for mode in ["append", "overwrite"] {
        let err = write(
            &ctx,
            json!({ "filePath": "file.txt", "content": "x", "mode": mode }),
        )
        .await
        .expect_err("denied file change must fail");
        assert!(
            err.to_string().contains("was not approved"),
            "{mode}: {err}"
        );
    }
    assert_eq!(approver.calls.load(Ordering::SeqCst), 2);
    assert_eq!(fs::read_to_string(&target).unwrap(), "original\n");

    // Outside the allowed roots, append is refused before any approval prompt, like overwrite.
    ctx.approval_handler = None;
    let outside = tmp.path().join("outside.txt");
    fs::write(&outside, "outside\n").unwrap();
    for mode in ["append", "overwrite"] {
        write(
            &ctx,
            json!({ "filePath": outside.to_string_lossy(), "content": "x", "mode": mode }),
        )
        .await
        .expect_err("write outside the workspace must fail");
    }
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside\n");
}
