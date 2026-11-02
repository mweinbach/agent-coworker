//! `codeMode` rich-result parity (TS `piMessageBridge.richToolResultContentFromOutput`): when the
//! script returns exactly a rich-result wrapper, such as a nested `read` of an image, the final
//! tool output carries native content parts (image media) instead of base64 JSON text, so it
//! reaches the provider as media and is never spilled as text. Image gating for models without
//! image input matches a direct `read` call.

use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::ProviderName;
use cowork_inference::{MediaKind, MediaSource, ToolResultPart};
use cowork_tools::overflow::maybe_spill_tool_output_with_inner;
use cowork_tools::{
    BuiltinTool, CodeModeTool, DeferredToolCatalog, ToolExecutionContext, ToolOutput,
    create_builtin_tools,
};
use serde_json::{Value, json};

const PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";

fn ctx_with(base: &Path, provider: ProviderName, model: &str) -> (PathBuf, ToolExecutionContext) {
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let ws = fs::canonicalize(ws).unwrap();
    let ctx = ToolExecutionContext::new_for_tests(home, ws.clone(), provider, model);
    fs::write(
        ws.join("pixel.png"),
        data_encoding::BASE64.decode(PNG_B64.as_bytes()).unwrap(),
    )
    .unwrap();
    (ws, ctx)
}

fn vision_ctx(base: &Path) -> ToolExecutionContext {
    ctx_with(base, ProviderName::Openai, "gpt-5.4").1
}

fn text_only_ctx(base: &Path) -> ToolExecutionContext {
    ctx_with(base, ProviderName::Bedrock, "some.text-only-model-v1:0").1
}

async fn run_code_mode(ctx: &ToolExecutionContext, code: &str) -> ToolOutput {
    let tool = CodeModeTool::new(DeferredToolCatalog::new(create_builtin_tools(ctx)), None);
    let args = serde_json::from_value(json!({ "code": code })).unwrap();
    tool.execute(args, ctx).await.expect("codeMode succeeds")
}

fn assert_pixel_image(part: &ToolResultPart) {
    match part {
        ToolResultPart::Media {
            kind: MediaKind::Image,
            source: MediaSource::Base64 { mime_type, data },
        } => {
            assert_eq!(mime_type, "image/png");
            assert_eq!(data, PNG_B64);
        }
        other => panic!("expected base64 image part, got {other:?}"),
    }
}

#[tokio::test]
async fn returned_nested_image_read_is_native_media_and_never_spilled() {
    let tmp = tempfile::tempdir().unwrap();
    let ctx = vision_ctx(tmp.path());
    let out = run_code_mode(
        &ctx,
        r#"return await tools.call("read", { filePath: "pixel.png" });"#,
    )
    .await;

    let ToolOutput::Content(parts) = &out else {
        panic!("expected rich content, got {out:?}");
    };
    assert_eq!(parts.len(), 2);
    assert_eq!(
        parts[0],
        ToolResultPart::Text {
            text: "Image file: pixel.png".to_owned()
        }
    );
    assert_pixel_image(&parts[1]);
    assert!(out.contains_media());

    // Provider-facing parts are the media itself, not JSON text containing base64.
    let provider_parts = out.to_tool_result_parts();
    assert_pixel_image(&provider_parts[1]);

    // Overflow handling leaves media content alone even with a tiny threshold.
    let spilled =
        maybe_spill_tool_output_with_inner("codeMode", None, "call-1", out.clone(), &ctx, Some(1))
            .unwrap();
    assert!(matches!(spilled, ToolOutput::Content(ref p) if p == parts));
}

#[tokio::test]
async fn text_only_model_keeps_read_gating_and_json_output() {
    let tmp = tempfile::tempdir().unwrap();
    let ctx = text_only_ctx(tmp.path());

    // The nested read is gated exactly as a direct read: the binary-media guard text.
    let out = run_code_mode(
        &ctx,
        r#"return await tools.call("read", { filePath: "pixel.png" });"#,
    )
    .await;
    match &out {
        ToolOutput::Json(Value::String(text)) => assert!(
            text.starts_with(
                "Cannot read pixel.png as text (image/png). This file is binary media"
            ),
            "{text}"
        ),
        other => panic!("expected guarded JSON text, got {other:?}"),
    }
    assert!(!out.contains_media());

    // A hand-built image wrapper is not promoted to media for a model without image input.
    let code = format!(
        r#"return {{ parts: [{{ type: "media", kind: "image", source: {{ type: "base64", mime_type: "image/png", data: "{PNG_B64}" }} }}] }};"#
    );
    let out = run_code_mode(&ctx, &code).await;
    assert!(matches!(out, ToolOutput::Json(_)), "{out:?}");
    assert!(!out.contains_media());
}

#[tokio::test]
async fn ts_content_wrapper_and_bare_part_arrays_are_recognized() {
    let tmp = tempfile::tempdir().unwrap();
    let ctx = vision_ctx(tmp.path());

    let code = format!(
        r#"return {{ type: "content", content: [{{ type: "text", text: "see" }}, {{ type: "image", data: "{PNG_B64}", mimeType: "image/png" }}] }};"#
    );
    let ToolOutput::Content(parts) = run_code_mode(&ctx, &code).await else {
        panic!("TS content wrapper must be rich content");
    };
    assert_eq!(
        parts[0],
        ToolResultPart::Text {
            text: "see".to_owned()
        }
    );
    assert_pixel_image(&parts[1]);

    let code =
        format!(r#"return [{{ type: "image", data: "{PNG_B64}", mimeType: "image/png" }}];"#);
    let ToolOutput::Content(parts) = run_code_mode(&ctx, &code).await else {
        panic!("bare part array must be rich content");
    };
    assert_eq!(parts.len(), 1);
    assert_pixel_image(&parts[0]);

    let out = run_code_mode(
        &ctx,
        r#"return { parts: [{ type: "text", text: "plain" }] };"#,
    )
    .await;
    assert!(
        matches!(&out, ToolOutput::Content(p) if p == &vec![ToolResultPart::Text { text: "plain".to_owned() }]),
        "{out:?}"
    );
}

#[tokio::test]
async fn non_wrapper_and_unsupported_values_stay_json() {
    let tmp = tempfile::tempdir().unwrap();
    let ctx = vision_ctx(tmp.path());

    let cases = [
        // Wrapper nested inside another value is not the returned wrapper itself.
        r#"return { image: await tools.call("read", { filePath: "pixel.png" }) };"#.to_owned(),
        r#"const r = await tools.call("read", { filePath: "pixel.png" }); return [r];"#.to_owned(),
        // Extra keys beside `parts`.
        r#"return { parts: [{ type: "text", text: "x" }], note: 1 };"#.to_owned(),
        // Empty part lists.
        r#"return { parts: [] };"#.to_owned(),
        r#"return [];"#.to_owned(),
        // Local file references and URLs must never become provider media.
        r#"return { parts: [{ type: "media", kind: "image", source: { type: "fileRef", path: "/etc/passwd", mime_type: "image/png" } }] };"#.to_owned(),
        r#"return { parts: [{ type: "media", kind: "image", source: { type: "url", url: "https://example.com/a.png" } }] };"#.to_owned(),
        // Non-image media kinds, invalid image mime types, and empty data.
        format!(
            r#"return {{ parts: [{{ type: "media", kind: "audio", source: {{ type: "base64", mime_type: "audio/mpeg", data: "{PNG_B64}" }} }}] }};"#
        ),
        format!(r#"return [{{ type: "image", data: "{PNG_B64}", mimeType: "application/pdf" }}];"#),
        r#"return [{ type: "image", data: "", mimeType: "image/png" }];"#.to_owned(),
        // One unsupported part rejects the whole wrapper.
        r#"return [{ type: "text", text: "ok" }, { kind: "image" }];"#.to_owned(),
        r#"return [1, 2, 3];"#.to_owned(),
    ];
    for code in cases {
        let out = run_code_mode(&ctx, &code).await;
        assert!(
            matches!(out, ToolOutput::Json(_)),
            "expected JSON for {code}, got {out:?}"
        );
        assert!(!out.contains_media(), "{code}");
    }
}
