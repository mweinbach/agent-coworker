//! Turn-attachment gating parity with TS `userMessageAttachments.ts`,
//! `attachmentGuidancePolicy.ts`, `multimodalMime.ts` and `shared/attachments.ts`:
//! images attach only for image-capable models, PDFs only for Google, at most 8 attachments,
//! inline payloads and model-bound media are capped at 25MB combined, and Google
//! transcription/extraction requests get the large-output guidance.

use std::fs;
use std::path::{Path, PathBuf};

use cowork_config::ProviderName;
use cowork_harness::attachments::{
    AttachmentModelCapabilities, LARGE_MULTIMODAL_OUTPUT_GUIDANCE,
    materialize_turn_attachments_for_model,
};
use cowork_inference::{ContentBlock, MediaKind};
use cowork_protocol::{ExtractedTurnInput, TurnInput};
use serde_json::{Value, json};

const PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";
const PDF_B64: &str = "JVBERi0xLjQKJcOkw7zDtsOfCg=="; // "%PDF-1.4\n%äüöß\n"
const MB: u64 = 1024 * 1024;

struct Fixture {
    _tmp: tempfile::TempDir,
    ws: PathBuf,
    uploads: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let ws = fs::canonicalize(tmp.path()).unwrap().join("ws");
    let uploads = ws.join("uploads");
    fs::create_dir_all(&uploads).unwrap();
    Fixture {
        _tmp: tmp,
        ws,
        uploads,
    }
}

fn caps(provider: ProviderName, supports_image_input: bool) -> AttachmentModelCapabilities {
    AttachmentModelCapabilities {
        provider,
        supports_image_input,
    }
}

fn input(text: &str, parts: Vec<Value>) -> ExtractedTurnInput {
    let mut all = vec![json!({ "type": "text", "text": text })];
    all.extend(parts);
    TurnInput::Parts(all).extract_payload().unwrap()
}

fn inline(filename: &str, mime: &str, b64: &str) -> Value {
    json!({ "type": "file", "filename": filename, "mimeType": mime, "contentBase64": b64 })
}

fn uploaded(path: &Path, filename: &str, mime: &str) -> Value {
    json!({
        "type": "uploadedFile",
        "filename": filename,
        "path": path.to_string_lossy(),
        "mimeType": mime,
    })
}

fn sparse_upload(f: &Fixture, name: &str, len: u64) -> PathBuf {
    let p = f.uploads.join(name);
    fs::File::create(&p).unwrap().set_len(len).unwrap();
    p
}

fn media_kinds(blocks: &[ContentBlock]) -> Vec<MediaKind> {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Media { kind, .. } => Some(*kind),
            _ => None,
        })
        .collect()
}

fn user_uploads_entries(f: &Fixture) -> usize {
    fs::read_dir(f.uploads.join("User Uploads"))
        .map(|d| d.count())
        .unwrap_or(0)
}

#[test]
fn image_is_path_only_for_text_only_model_and_attached_for_vision_model() {
    let f = fixture();
    let turn = input("look", vec![inline("chart.png", "image/png", PNG_B64)]);

    let m = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, false),
    )
    .unwrap();
    assert!(media_kinds(&m.content_blocks).is_empty());
    assert_eq!(m.staged_files.len(), 1, "the file is still saved for tools");
    assert!(
        m.display_text.contains("[Attached file saved to: "),
        "{}",
        m.display_text
    );

    // Uploaded images and extension-only classification are gated the same way.
    let png = f.uploads.join("shot.png");
    fs::write(&png, b"\x89PNG").unwrap();
    let turn = input(
        "look",
        vec![uploaded(&png, "shot.png", "application/octet-stream")],
    );
    let m = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Anthropic, false),
    )
    .unwrap();
    assert!(media_kinds(&m.content_blocks).is_empty());

    let turn = input("look", vec![inline("chart.png", "image/png", PNG_B64)]);
    let m = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, true),
    )
    .unwrap();
    assert_eq!(media_kinds(&m.content_blocks), vec![MediaKind::Image]);
}

#[test]
fn pdf_is_attached_only_for_google() {
    let f = fixture();
    let turn = input(
        "summarize",
        vec![inline("doc.pdf", "application/pdf", PDF_B64)],
    );
    for provider in [ProviderName::Openai, ProviderName::Anthropic] {
        let m =
            materialize_turn_attachments_for_model(&turn, &f.uploads, &f.ws, caps(provider, true))
                .unwrap();
        assert!(
            media_kinds(&m.content_blocks).is_empty(),
            "{provider:?} must not receive PDF content"
        );
        assert!(m.display_text.contains("[Attached file saved to: "));
    }
    let m = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Google, true),
    )
    .unwrap();
    assert_eq!(media_kinds(&m.content_blocks), vec![MediaKind::Document]);
}

#[test]
fn more_than_eight_attachments_are_rejected_before_staging() {
    let f = fixture();
    let parts = (0..9)
        .map(|i| inline(&format!("f{i}.txt"), "text/plain", "aGk="))
        .collect();
    let err = materialize_turn_attachments_for_model(
        &input("x", parts),
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, true),
    )
    .unwrap_err();
    assert_eq!(err, "Too many file attachments (max 8)");
    assert_eq!(user_uploads_entries(&f), 0);
}

#[test]
fn inline_attachments_over_25mb_combined_are_rejected_before_staging() {
    let f = fixture();
    // 20M base64 chars each (~15MB decoded): under the per-file cap, over the combined cap.
    let big = "A".repeat(20 * MB as usize);
    let turn = input(
        "x",
        vec![
            inline("a.txt", "text/plain", &big),
            inline("b.txt", "text/plain", &big),
        ],
    );
    let err = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, true),
    )
    .unwrap_err();
    assert_eq!(
        err,
        "Inline attachments too large in total (max 25MB combined)"
    );
    assert_eq!(user_uploads_entries(&f), 0);

    let huge = "A".repeat(35 * MB as usize);
    let err = materialize_turn_attachments_for_model(
        &input("x", vec![inline("c.txt", "text/plain", &huge)]),
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, true),
    )
    .unwrap_err();
    assert_eq!(err, "File too large to send inline (max 25MB)");
}

#[test]
fn uploaded_media_over_25mb_combined_is_rejected_but_path_only_uploads_are_not_counted() {
    let f = fixture();
    let a = sparse_upload(&f, "a.mp4", 15 * MB);
    let b = sparse_upload(&f, "b.mp4", 15 * MB);
    let turn = input(
        "watch",
        vec![
            uploaded(&a, "a.mp4", "video/mp4"),
            uploaded(&b, "b.mp4", "video/mp4"),
        ],
    );

    // Google receives both videos as media: 30MB combined is refused.
    let err = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Google, true),
    )
    .unwrap_err();
    assert_eq!(
        err,
        "Uploaded multimodal attachments too large to send to the model (max 25MB combined)"
    );

    // Other providers only get path notes, so nothing counts toward the media cap.
    let m = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, true),
    )
    .unwrap();
    assert!(media_kinds(&m.content_blocks).is_empty());

    // Inline media counts toward the uploaded-media total too.
    let small = sparse_upload(&f, "c.png", 20 * MB);
    let inline_png = "A".repeat(8 * MB as usize); // ~6MB decoded
    let turn = input(
        "look",
        vec![
            inline("i.png", "image/png", &inline_png),
            uploaded(&small, "c.png", "image/png"),
        ],
    );
    let err = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, true),
    )
    .unwrap_err();
    assert_eq!(
        err,
        "Uploaded multimodal attachments too large to send to the model (max 25MB combined)"
    );
    assert_eq!(user_uploads_entries(&f), 0, "nothing staged on rejection");

    // Same turn for a text-only model: images are path-only and the turn is accepted.
    let m = materialize_turn_attachments_for_model(
        &turn,
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, false),
    )
    .unwrap();
    assert!(media_kinds(&m.content_blocks).is_empty());
    m.rollback();
}

#[test]
fn google_extraction_request_gets_large_output_guidance_once() {
    let f = fixture();
    let audio = f.uploads.join("talk.mp3");
    fs::write(&audio, b"ID3").unwrap();
    let parts = vec![
        uploaded(&audio, "talk.mp3", "audio/mpeg"),
        inline("doc.pdf", "application/pdf", PDF_B64),
    ];

    let m = materialize_turn_attachments_for_model(
        &input("Please transcribe this", parts.clone()),
        &f.uploads,
        &f.ws,
        caps(ProviderName::Google, true),
    )
    .unwrap();
    assert_eq!(
        m.display_text
            .matches(LARGE_MULTIMODAL_OUTPUT_GUIDANCE)
            .count(),
        1
    );
    assert!(m.display_text.contains(&format!(
        "[System: The user uploaded a file which has been saved to {}. The file is already attached as audio content below;",
        audio.display()
    )));
    assert!(
        m.display_text
            .contains("The file is already attached as document content below;")
    );

    // No guidance without an output-style request, or for non-Google providers.
    let m = materialize_turn_attachments_for_model(
        &input("what is this?", parts.clone()),
        &f.uploads,
        &f.ws,
        caps(ProviderName::Google, true),
    )
    .unwrap();
    assert!(!m.display_text.contains(LARGE_MULTIMODAL_OUTPUT_GUIDANCE));
    let m = materialize_turn_attachments_for_model(
        &input("Please transcribe this", parts),
        &f.uploads,
        &f.ws,
        caps(ProviderName::Openai, true),
    )
    .unwrap();
    assert!(!m.display_text.contains(LARGE_MULTIMODAL_OUTPUT_GUIDANCE));
}
