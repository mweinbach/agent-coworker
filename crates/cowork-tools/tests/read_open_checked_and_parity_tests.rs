//! `read` hardening and TS parity (`src/tools/read.ts` / `readTextRange`, `write.ts`, `edit.ts`):
//! - `open_read_checked` refuses a final-component symlink (O_NOFOLLOW) and a handle whose real
//!   path resolves outside the allowed roots, so a symlink swapped in after the path check
//!   cannot redirect the read;
//! - a huge single line is streamed through a bounded window;
//! - invalid UTF-8 decodes lossily, NULs after the leading sniff window are text, and
//!   `columnOffset` applies to the first returned line only;
//! - PDF/audio/video are refused and images are gated on model image support;
//! - write/edit size caps.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use cowork_config::ProviderName;
use cowork_inference::{MediaKind, ToolResultPart};
use cowork_tools::fs_tools::open_read_checked;
use cowork_tools::{ToolError, ToolExecutionContext, ToolOutput, create_builtin_tools};
use serde_json::{Value, json};

fn dirs(base: &Path) -> (PathBuf, PathBuf) {
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    (
        fs::canonicalize(home).unwrap(),
        fs::canonicalize(ws).unwrap(),
    )
}

fn ctx_with(base: &Path, provider: ProviderName, model: &str) -> (PathBuf, ToolExecutionContext) {
    let (home, ws) = dirs(base);
    let ctx = ToolExecutionContext::new_for_tests(home, ws.clone(), provider, model);
    (ws, ctx)
}

fn ctx_for(base: &Path) -> (PathBuf, ToolExecutionContext) {
    ctx_with(base, ProviderName::Openai, "gpt-5.4")
}

async fn run(ctx: &ToolExecutionContext, tool: &str, args: Value) -> Result<ToolOutput, ToolError> {
    let tools = create_builtin_tools(ctx);
    tools[tool]
        .execute(serde_json::from_value(args).unwrap(), ctx)
        .await
}

async fn read_text(ctx: &ToolExecutionContext, args: Value) -> String {
    run(ctx, "read", args)
        .await
        .expect("read succeeds")
        .as_text()
        .expect("text output")
}

#[cfg(unix)]
#[test]
fn open_read_checked_refuses_final_component_symlink() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    // The path was checked as a regular file, then swapped for a symlink to a secret.
    let secret = ws.join("secret.txt");
    fs::write(&secret, "top secret").unwrap();
    let swapped = ws.join("notes.txt");
    symlink(&secret, &swapped).unwrap();

    let err = open_read_checked(&ctx, &swapped).expect_err("symlink must be refused");
    assert!(matches!(err, ToolError::PathDenied(_)), "{err:?}");
    assert!(err.to_string().contains("symbolic link"), "{err}");

    // The real regular file opens and reads normally.
    let mut text = String::new();
    open_read_checked(&ctx, &secret)
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "top secret");
}

#[cfg(unix)]
#[test]
fn open_read_checked_revalidates_real_path_of_opened_handle() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let (ws, mut ctx) = ctx_for(tmp.path());

    // A parent directory swapped for a symlink into ~/.ssh: O_NOFOLLOW only covers the final
    // component, so the handle's real path must be re-validated.
    let ssh = ctx.homedir.join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    fs::write(ssh.join("id_ed25519"), "PRIVATE KEY").unwrap();
    symlink(&ssh, ws.join("keys")).unwrap();
    let err = open_read_checked(&ctx, &ws.join("keys").join("id_ed25519"))
        .expect_err("credential real path must be refused");
    assert!(err.to_string().contains("protected credential"), "{err}");

    // Same with configured readRoots: the real path falls outside every root.
    let outside = tmp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("data.txt"), "outside data").unwrap();
    symlink(&outside, ws.join("linked")).unwrap();
    ctx.read_roots = vec![ws.clone()];
    let err = open_read_checked(&ctx, &ws.join("linked").join("data.txt"))
        .expect_err("real path outside readRoots must be refused");
    assert!(
        err.to_string().contains("outside configured readRoots"),
        "{err}"
    );
}

#[cfg(unix)]
#[test]
fn open_read_checked_refuses_fifo_without_blocking() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let fifo = ws.join("pipe.txt");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap();
    assert!(status.success());
    let err = open_read_checked(&ctx, &fifo).expect_err("FIFO must be refused");
    assert!(err.to_string().contains("not a regular file"), "{err}");
}

#[tokio::test]
async fn huge_single_line_is_read_through_a_bounded_window() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let line_len = 50 * 1024 * 1024;
    let mut body = vec![b'x'; line_len];
    body[..5].copy_from_slice(b"start");
    body.extend_from_slice(b"\nsecond\n");
    fs::write(ws.join("huge.txt"), &body).unwrap();
    drop(body);

    let out = read_text(&ctx, json!({ "filePath": "huge.txt", "limit": 1 })).await;
    let expected = format!(
        "1\tstart{}... [line 1 continues; read offset=1 columnOffset=2001 limit=1]",
        "x".repeat(1995)
    );
    assert_eq!(out, expected);

    // Lines before the window are skipped without being buffered.
    let out = read_text(&ctx, json!({ "filePath": "huge.txt", "offset": 2 })).await;
    assert_eq!(out, "2\tsecond");

    // Continue deep into the line.
    let out = read_text(
        &ctx,
        json!({ "filePath": "huge.txt", "columnOffset": line_len - 2, "limit": 1 }),
    )
    .await;
    assert_eq!(
        out,
        "1\txxx\n\n[Showing lines 1-1; pass offset=2 to continue]"
    );
}

#[tokio::test]
async fn invalid_utf8_is_decoded_lossily() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    // Invalid byte, a truncated 3-byte sequence, and a valid multi-byte char.
    fs::write(
        ws.join("bad.txt"),
        b"ok \xFF here\nbad \xE2\x82 end\nfine \xE2\x82\xAC\n",
    )
    .unwrap();
    let out = read_text(&ctx, json!({ "filePath": "bad.txt" })).await;
    assert_eq!(
        out,
        "1\tok \u{FFFD} here\n2\tbad \u{FFFD} end\n3\tfine \u{20AC}"
    );
}

#[tokio::test]
async fn multibyte_chars_split_across_chunks_decode_intact() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    // 8 KiB sniff + 64 KiB chunks: 4-byte chars straddle the 8,192 and 73,728 byte
    // boundaries, and the requested window covers the second one.
    let globe = "\u{1F30D}";
    let mut body = "a".repeat(8_190);
    body.push_str(&globe.repeat(20_000));
    body.push('\n');
    fs::write(ws.join("emoji.txt"), &body).unwrap();
    let col = 8_190 + 15_000 + 1;
    let out = read_text(
        &ctx,
        json!({ "filePath": "emoji.txt", "columnOffset": col, "limit": 1 }),
    )
    .await;
    assert_eq!(
        out,
        format!(
            "1\t{}... [line 1 continues; read offset=1 columnOffset={} limit=1]",
            globe.repeat(2_000),
            col + 2_000
        )
    );
    assert!(!out.contains('\u{FFFD}'));
}

#[tokio::test]
async fn nul_bytes_after_the_leading_sniff_window_are_text() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());

    // A NUL in the leading 8 KiB marks the file binary.
    fs::write(ws.join("head.dat"), b"ELF\x00\x01\x02binary").unwrap();
    let out = read_text(&ctx, json!({ "filePath": "head.dat" })).await;
    assert!(
        out.starts_with("Cannot read head.dat as text (application/octet-stream,"),
        "{out}"
    );

    // A NUL later in the file (e.g. a log) no longer fails the read.
    let mut body = "line\n".repeat(4_000).into_bytes();
    body.extend_from_slice(b"with\x00nul\n");
    fs::write(ws.join("log.txt"), &body).unwrap();
    let out = read_text(&ctx, json!({ "filePath": "log.txt", "offset": 4_001 })).await;
    assert_eq!(out, "4001\twith\u{0}nul");
}

#[tokio::test]
async fn column_offset_applies_to_first_line_only() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    fs::write(ws.join("cols.txt"), "abcdef\nghijkl\nmnopqr\n").unwrap();
    let out = read_text(
        &ctx,
        json!({ "filePath": "cols.txt", "offset": 1, "columnOffset": 4, "limit": 3 }),
    )
    .await;
    assert_eq!(out, "1\tdef\n2\tghijkl\n3\tmnopqr");
}

#[tokio::test]
async fn more_lines_footer_and_empty_file() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    fs::write(ws.join("three.txt"), "a\r\nb\r\nc\r\n").unwrap();
    let out = read_text(&ctx, json!({ "filePath": "three.txt", "limit": 2 })).await;
    assert_eq!(
        out,
        "1\ta\n2\tb\n\n[Showing lines 1-2; pass offset=3 to continue]"
    );
    let out = read_text(
        &ctx,
        json!({ "filePath": "three.txt", "offset": 2, "limit": 2 }),
    )
    .await;
    assert_eq!(out, "2\tb\n3\tc");

    fs::write(ws.join("empty.txt"), "").unwrap();
    let out = read_text(&ctx, json!({ "filePath": "empty.txt" })).await;
    assert_eq!(out, "1\t");
}

#[tokio::test]
async fn pdf_audio_and_video_are_refused_with_the_ts_message() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    for (name, mime) in [
        ("doc.pdf", "application/pdf"),
        ("clip.mp3", "audio/mpeg"),
        ("song.flac", "audio/flac"),
        ("movie.mkv", "video/x-matroska"),
    ] {
        fs::write(ws.join(name), b"not really media").unwrap();
        let out = read_text(&ctx, json!({ "filePath": name })).await;
        assert_eq!(
            out,
            format!(
                "Cannot read {name} as text ({mime}). This file is binary media (image, audio, video, or PDF). The read tool does not return audio, video, or PDF bytes because large tool results can exceed provider response limits. If the file was attached to the turn, use the already-attached media content; otherwise use a dedicated transcription or extraction workflow and write large output to a workspace file."
            )
        );
    }
}

const PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

#[tokio::test]
async fn images_are_gated_on_model_image_support() {
    let png = data_encoding::BASE64.decode(PNG_B64.as_bytes()).unwrap();

    // OpenAI default model supports images: returned as an image part.
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    fs::write(ws.join("pixel.png"), &png).unwrap();
    match run(&ctx, "read", json!({ "filePath": "pixel.png" }))
        .await
        .unwrap()
    {
        ToolOutput::Content(parts) => {
            assert!(
                matches!(&parts[0], ToolResultPart::Text { text } if text == "Image file: pixel.png")
            );
            assert!(matches!(
                &parts[1],
                ToolResultPart::Media {
                    kind: MediaKind::Image,
                    ..
                }
            ));
        }
        other => panic!("expected image content, got {other:?}"),
    }

    // A Bedrock model without image input: the TS binary-media guard text.
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_with(
        tmp.path(),
        ProviderName::Bedrock,
        "some.text-only-model-v1:0",
    );
    fs::write(ws.join("pixel.png"), &png).unwrap();
    let out = read_text(&ctx, json!({ "filePath": "pixel.png" })).await;
    assert!(
        out.starts_with("Cannot read pixel.png as text (image/png). This file is binary media"),
        "{out}"
    );
}

#[tokio::test]
async fn oversized_image_is_rejected_before_reading() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let f = fs::File::create(ws.join("big.png")).unwrap();
    f.set_len(25 * 1024 * 1024 + 1).unwrap();
    let err = run(&ctx, "read", json!({ "filePath": "big.png" }))
        .await
        .expect_err("oversized image must fail");
    assert_eq!(err.to_string(), "File too large to send inline (max 25MB)");
}

#[tokio::test]
async fn write_content_is_capped_at_two_million_chars() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    let err = run(
        &ctx,
        "write",
        json!({ "filePath": "big.txt", "content": "a".repeat(2_000_001) }),
    )
    .await
    .expect_err("oversized write must fail");
    assert_eq!(
        err.to_string(),
        "Invalid tool arguments: content: Too big: expected string to have <=2000000 characters"
    );
    assert!(!ws.join("big.txt").exists());

    // UTF-16 code units, like zod: 1,000,001 astral chars are 2,000,002 units.
    let err = run(
        &ctx,
        "write",
        json!({ "filePath": "big.txt", "content": "\u{1F30D}".repeat(1_000_001) }),
    )
    .await
    .expect_err("oversized write must fail");
    assert!(err.to_string().contains("Too big"), "{err}");

    run(
        &ctx,
        "write",
        json!({ "filePath": "ok.txt", "content": "a".repeat(2_000_000) }),
    )
    .await
    .expect("write at the cap succeeds");
}

#[tokio::test]
async fn edit_caps_strings_file_size_and_projected_result() {
    let tmp = tempfile::tempdir().unwrap();
    let (ws, ctx) = ctx_for(tmp.path());
    fs::write(ws.join("small.txt"), "x\n".repeat(10)).unwrap();

    for key in ["oldString", "newString"] {
        let mut args = json!({ "filePath": "small.txt", "oldString": "x", "newString": "y" });
        args[key] = json!("z".repeat(2_000_001));
        let err = run(&ctx, "edit", args).await.expect_err("oversized string");
        assert_eq!(
            err.to_string(),
            format!(
                "Invalid tool arguments: {key}: Too big: expected string to have <=2000000 characters"
            )
        );
    }

    // File over 10,000,000 bytes is refused by size before being read.
    let big = ws.join("big.txt");
    fs::write(&big, vec![b'a'; 10_000_001]).unwrap();
    let err = run(
        &ctx,
        "edit",
        json!({ "filePath": "big.txt", "oldString": "a", "newString": "b", "replaceAll": true }),
    )
    .await
    .expect_err("oversized file");
    assert_eq!(
        err.to_string(),
        format!(
            "edit blocked: {} is 10000001 bytes (max 10000000).",
            big.display()
        )
    );

    // replaceAll over many short matches would blow the result past the cap.
    fs::write(ws.join("many.txt"), "a".repeat(10)).unwrap();
    let err = run(
        &ctx,
        "edit",
        json!({
            "filePath": "many.txt",
            "oldString": "a",
            "newString": "b".repeat(1_000_001),
            "replaceAll": true
        }),
    )
    .await
    .expect_err("projected result too large");
    assert_eq!(
        err.to_string(),
        "edit blocked: result would be ~10000010 bytes (max 10000000)."
    );
    assert_eq!(
        fs::read_to_string(ws.join("many.txt")).unwrap(),
        "a".repeat(10)
    );

    // Not-unique keeps precedence over the projection, as in TS.
    let err = run(
        &ctx,
        "edit",
        json!({ "filePath": "many.txt", "oldString": "a", "newString": "b".repeat(1_000_001) }),
    )
    .await
    .expect_err("not unique");
    assert!(err.to_string().contains("matched 10 locations"), "{err}");

    // UTF-16 doubles the encoded size: the LF projection fits, the encoding does not.
    let mut utf16 = vec![0xFF, 0xFE];
    for u in "aaa".encode_utf16() {
        utf16.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(ws.join("wide.txt"), &utf16).unwrap();
    let err = run(
        &ctx,
        "edit",
        json!({
            "filePath": "wide.txt",
            "oldString": "a",
            "newString": "b".repeat(2_000_000),
            "replaceAll": true
        }),
    )
    .await
    .expect_err("encoded result too large");
    assert_eq!(
        err.to_string(),
        "edit blocked: encoded result would be 12000002 bytes (max 10000000)."
    );
    assert_eq!(fs::read(ws.join("wide.txt")).unwrap(), utf16);
}
