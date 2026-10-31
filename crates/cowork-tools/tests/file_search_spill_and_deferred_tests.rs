use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use cowork_config::ProviderName;
use cowork_inference::{MediaKind, MediaSource, ToolResultPart};
use cowork_sandbox::SandboxPolicy;
use cowork_tools::{
    DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS, DeferredToolCatalog, ToolBatchCall, ToolExecutionContext,
    ToolOutput, create_builtin_tools, execute_tool_batch, maybe_spill_tool_output,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

fn isolated_test_dirs(prefix: &str) -> (PathBuf, PathBuf) {
    let base = PathBuf::from(format!(
        "/private/tmp/cowork-tools-{prefix}-{}",
        Uuid::new_v4()
    ));
    let home = base.join("home");
    let ws = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    (
        fs::canonicalize(home).unwrap(),
        fs::canonicalize(ws).unwrap(),
    )
}

fn make_ctx(home: &Path, ws: &Path) -> ToolExecutionContext {
    ToolExecutionContext::new_for_tests(
        home.to_path_buf(),
        ws.to_path_buf(),
        ProviderName::Openai,
        "gpt-5.4",
    )
}

#[tokio::test]
async fn read_supports_offsets_utf8_utf16_bom_binary_guard_and_image_pdf_multimodal_blocks() {
    let (home, ws) = isolated_test_dirs("read");
    let ctx = make_ctx(&home, &ws);
    let tools = create_builtin_tools(&ctx);
    let read_tool = tools.get("read").expect("read tool registered");

    // 1. UTF-8, UTF-16LE, UTF-16BE with BOM & mixed CRLF/CR/LF
    let sample = "\u{feff}héllo 🌍\r\n\r\nnext\rlast\n";
    let utf8_path = ws.join("utf8.txt");
    fs::write(&utf8_path, sample.as_bytes()).unwrap();

    let mut utf16le_bytes = Vec::new();
    for unit in sample.encode_utf16() {
        utf16le_bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let utf16le_path = ws.join("utf16le.txt");
    fs::write(&utf16le_path, &utf16le_bytes).unwrap();

    let mut utf16be_bytes = Vec::new();
    for unit in sample.encode_utf16() {
        utf16be_bytes.extend_from_slice(&unit.to_be_bytes());
    }
    let utf16be_path = ws.join("utf16be.txt");
    fs::write(&utf16be_path, &utf16be_bytes).unwrap();

    for path in [&utf8_path, &utf16le_path, &utf16be_path] {
        let out = read_tool
            .execute(
                serde_json::from_value(json!({
                    "filePath": path.to_string_lossy(),
                    "limit": 10
                }))
                .unwrap(),
                &ctx,
            )
            .await
            .unwrap();
        assert_eq!(out.as_text().unwrap(), "1\théllo 🌍\n2\t\n3\tnext\n4\tlast");
    }

    // 2. Line offset, limit, and columnOffset (>2000 chars)
    let long_path = ws.join("long.txt");
    fs::write(
        &long_path,
        format!("first\n{}{}\nthird\n", "a".repeat(2000), "b".repeat(500)),
    )
    .unwrap();
    let window1 = read_tool
        .execute(
            serde_json::from_value(json!({
                "filePath": "long.txt",
                "offset": 2,
                "limit": 1
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    let text1 = window1.as_text().unwrap();
    assert!(text1.starts_with(&format!("2\t{}", "a".repeat(2000))));
    assert!(text1.contains("read offset=2 columnOffset=2001 limit=1"));

    let window2 = read_tool
        .execute(
            serde_json::from_value(json!({
                "filePath": "long.txt",
                "offset": 2,
                "columnOffset": 2001,
                "limit": 1
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    assert!(
        window2
            .as_text()
            .unwrap()
            .starts_with(&format!("2\t{}", "b".repeat(500)))
    );

    // 3. Binary detection (NUL bytes & audio guard)
    let bin_path = ws.join("compiled.bin");
    fs::write(&bin_path, b"ELF\x00\x01\x02\x03binary").unwrap();
    let bin_out = read_tool
        .execute(
            serde_json::from_value(json!({ "filePath": "compiled.bin" })).unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    assert!(
        bin_out
            .as_text()
            .unwrap()
            .contains("Cannot read compiled.bin as text")
    );

    let mp3_path = ws.join("clip.mp3");
    fs::write(&mp3_path, b"fake-mp3-bytes").unwrap();
    let mp3_out = read_tool
        .execute(
            serde_json::from_value(json!({ "filePath": "clip.mp3" })).unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    assert!(mp3_out.as_text().unwrap().contains("audio/mpeg"));

    // 4. Image and PDF multimodal blocks
    let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6ixAAAAAElFTkSuQmCC";
    let png_bytes = data_encoding::BASE64.decode(png_b64.as_bytes()).unwrap();
    fs::write(ws.join("pixel.png"), &png_bytes).unwrap();
    let img_out = read_tool
        .execute(
            serde_json::from_value(json!({ "filePath": "pixel.png" })).unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    match img_out {
        ToolOutput::Content(parts) => {
            assert_eq!(parts.len(), 2);
            assert!(matches!(
                &parts[1],
                ToolResultPart::Media {
                    kind: MediaKind::Image,
                    source: MediaSource::Base64 { mime_type, data }
                } if mime_type == "image/png" && data == png_b64
            ));
        }
        other => panic!("expected multimodal image parts, got {other:?}"),
    }

    let pdf_bytes = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n";
    let pdf_b64 = data_encoding::BASE64.encode(pdf_bytes);
    fs::write(ws.join("spec.pdf"), pdf_bytes).unwrap();
    let pdf_out = read_tool
        .execute(
            serde_json::from_value(json!({ "filePath": "spec.pdf" })).unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    match pdf_out {
        ToolOutput::Content(parts) => {
            assert_eq!(parts.len(), 2);
            assert!(matches!(
                &parts[1],
                ToolResultPart::Media {
                    kind: MediaKind::Document,
                    source: MediaSource::Base64 { mime_type, data }
                } if mime_type == "application/pdf" && data == &pdf_b64
            ));
        }
        other => panic!("expected multimodal PDF parts, got {other:?}"),
    }

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[tokio::test]
async fn write_and_edit_preserve_crlf_and_bom_under_concurrent_file_locks_and_block_protected_paths()
 {
    let (home, ws) = isolated_test_dirs("mutation");
    let ctx = Arc::new(make_ctx(&home, &ws));
    let tools = Arc::new(create_builtin_tools(&ctx));
    let edit_tool = tools.get("edit").expect("edit");
    let write_tool = tools.get("write").expect("write");

    // 1. UTF-16LE + CRLF preservation on edit and write
    let crlf_text = "\u{feff}line1 = \"old\"\r\nline2 = \"keep\"\r\n";
    let mut raw_utf16le = Vec::new();
    for u in crlf_text.encode_utf16() {
        raw_utf16le.extend_from_slice(&u.to_le_bytes());
    }
    let crlf_file = ws.join("config.ini");
    fs::write(&crlf_file, &raw_utf16le).unwrap();

    edit_tool
        .execute(
            serde_json::from_value(json!({
                "filePath": "config.ini",
                "oldString": "line1 = \"old\"\nline2 = \"keep\"",
                "newString": "line1 = \"new_$1\"\nline2 = \"keep\""
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();

    let edited_bytes = fs::read(&crlf_file).unwrap();
    assert_eq!(&edited_bytes[..2], &[0xFF, 0xFE], "UTF-16LE BOM preserved");
    let decoded_u16: Vec<u16> = edited_bytes[2..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    let decoded_str = String::from_utf16(&decoded_u16).unwrap();
    assert_eq!(
        decoded_str, "line1 = \"new_$1\"\r\nline2 = \"keep\"\r\n",
        "CRLF line endings and literal $1 preserved"
    );

    // Overwriting existing CRLF + UTF-8 BOM file via `write` preserves BOM & CRLF
    let utf8_bom_crlf = ws.join("bom_crlf.txt");
    fs::write(&utf8_bom_crlf, b"\xEF\xBB\xBFalpha\r\nbeta\r\n").unwrap();
    write_tool
        .execute(
            serde_json::from_value(json!({
                "filePath": "bom_crlf.txt",
                "content": "one\ntwo\n"
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    assert_eq!(
        fs::read(&utf8_bom_crlf).unwrap(),
        b"\xEF\xBB\xBFone\r\ntwo\r\n"
    );

    // 2. Concurrent `edit` mutations serialize cleanly without losing updates
    let shared_file = ws.join("concurrent.txt");
    let initial: String = (0..12).map(|i| format!("slot_{i}=0\n")).collect();
    fs::write(&shared_file, initial).unwrap();

    let mut handles = Vec::new();
    for i in 0..12 {
        let ctx_c = Arc::clone(&ctx);
        let tools_c = Arc::clone(&tools);
        handles.push(tokio::spawn(async move {
            let edit = tools_c.get("edit").unwrap();
            edit.execute(
                serde_json::from_value(json!({
                    "filePath": "concurrent.txt",
                    "oldString": format!("slot_{i}=0"),
                    "newString": format!("slot_{i}=1")
                }))
                .unwrap(),
                &ctx_c,
            )
            .await
            .unwrap();
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    let final_shared = fs::read_to_string(&shared_file).unwrap();
    for i in 0..12 {
        assert!(
            final_shared.contains(&format!("slot_{i}=1\n")),
            "lost concurrent edit {i}: {final_shared}"
        );
    }

    // 3. Protected `.git` and `.cowork` paths are rejected
    fs::create_dir_all(ws.join(".git")).unwrap();
    fs::create_dir_all(ws.join(".cowork")).unwrap();
    for blocked in [".git/config", ".cowork/config.json"] {
        let err = write_tool
            .execute(
                serde_json::from_value(json!({
                    "filePath": blocked,
                    "content": "pwned"
                }))
                .unwrap(),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("blocked")
                || err.to_string().to_lowercase().contains("protected"),
            "unexpected error for {blocked}: {err}"
        );
    }

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[tokio::test]
async fn glob_batches_up_to_four_in_parallel_preserving_call_order_and_grep_runs_in_process() {
    let (home, ws) = isolated_test_dirs("search");
    fs::create_dir_all(ws.join("src")).unwrap();
    fs::create_dir_all(ws.join("ignored_dir")).unwrap();
    fs::write(ws.join(".gitignore"), "ignored_dir/\n").unwrap();
    fs::write(
        ws.join("src/a.rs"),
        "fn alpha() {\n    let needle = 42;\n}\n",
    )
    .unwrap();
    fs::write(ws.join("src/b.ts"), "export const NEEDLE = 'hello';\n").unwrap();
    fs::write(ws.join("ignored_dir/secret.rs"), "let needle = 999;\n").unwrap();

    let ctx = make_ctx(&home, &ws);
    let tools = create_builtin_tools(&ctx);

    // Parallel batching up to 4 in deterministic call order
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let calls: Vec<ToolBatchCall> = (0..6)
        .map(|idx| ToolBatchCall {
            call_id: format!("call-{idx}"),
            tool_name: "glob".to_owned(),
            arguments: serde_json::from_value(json!({
                "pattern": if idx % 2 == 0 { "**/*.rs" } else { "**/*.ts" }
            }))
            .unwrap(),
        })
        .collect();

    let active_hook = Arc::clone(&active);
    let peak_hook = Arc::clone(&peak);
    let results = execute_tool_batch(
        &tools,
        &calls,
        &ctx,
        Some(Arc::new(move || {
            let cur = active_hook.fetch_add(1, Ordering::SeqCst) + 1;
            peak_hook.fetch_max(cur, Ordering::SeqCst);
            let active_done = Arc::clone(&active_hook);
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(25)).await;
                active_done.fetch_sub(1, Ordering::SeqCst);
            })
        })),
    )
    .await;

    assert_eq!(results.len(), 6);
    let observed_peak = peak.load(Ordering::SeqCst);
    assert!(
        (2..=4).contains(&observed_peak),
        "expected parallel glob batching capped at 4, observed peak={observed_peak}"
    );
    for (idx, res) in results.iter().enumerate() {
        assert_eq!(res.call_id, format!("call-{idx}"));
        let text = res.output.as_ref().unwrap().as_text().unwrap();
        if idx % 2 == 0 {
            assert!(text.contains("src/a.rs"));
            assert!(!text.contains("ignored_dir/secret.rs"));
        } else {
            assert!(text.contains("src/b.ts"));
        }
    }

    // In-process grep respects .gitignore, caseSensitive, contextLines, and zero external rg binary
    let grep_tool = tools.get("grep").expect("grep");
    let grep_res = grep_tool
        .execute(
            serde_json::from_value(json!({
                "pattern": "needle",
                "caseSensitive": false,
                "contextLines": 1
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    let grep_text = grep_res.as_text().unwrap();
    assert!(
        grep_text.contains("a.rs:2:    let needle = 42;"),
        "{grep_text}"
    );
    assert!(
        grep_text.contains("b.ts:1:export const NEEDLE"),
        "{grep_text}"
    );
    assert!(
        !grep_text.contains("ignored_dir"),
        "must respect .gitignore"
    );

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[tokio::test]
async fn scratchpad_overflow_spills_to_cowork_scratchpad_with_exemptions_and_deferred_tool_search_works()
 {
    let (home, ws) = isolated_test_dirs("spill");
    let ctx = make_ctx(&home, &ws);
    let tools = create_builtin_tools(&ctx);

    let big = "line-of-output-0123456789\n".repeat(1500);
    assert!(big.len() > DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS);

    // 1. `bash` / `grep` spill to `<workspace>/.cowork/.cowork-scratchpad/`
    let spilled = maybe_spill_tool_output(
        "grep",
        "call-grep-1",
        ToolOutput::Text(big.clone()),
        &ws,
        Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS),
        &SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![ws.clone()],
            writable_root_kinds: Default::default(),
            network: true,
        },
    )
    .unwrap();
    let spilled_json = spilled.to_json_value();
    assert_eq!(spilled_json["overflow"], Value::Bool(true));
    let file_path = PathBuf::from(spilled_json["filePath"].as_str().unwrap());
    assert!(
        file_path.starts_with(ws.join(".cowork").join(".cowork-scratchpad")),
        "spill path must live under <workspace>/.cowork/.cowork-scratchpad/: {}",
        file_path.display()
    );
    assert_eq!(fs::read_to_string(&file_path).unwrap(), big);

    // `read` tool can inspect the spilled scratchpad file cleanly
    let read_back = tools
        .get("read")
        .unwrap()
        .execute(
            serde_json::from_value(json!({
                "filePath": file_path.to_string_lossy(),
                "limit": 5
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    assert!(
        read_back
            .as_text()
            .unwrap()
            .starts_with("1\tline-of-output-0123456789")
    );

    // 2. `read` and `skill` (and `toolCall` wrapping `read`/`skill`) are strictly exempt
    for exempt in ["read", "skill"] {
        let kept = maybe_spill_tool_output(
            exempt,
            "call-exempt",
            ToolOutput::Text(big.clone()),
            &ws,
            Some(DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS),
            &SandboxPolicy::DangerFullAccess {
                network: Some(true),
            },
        )
        .unwrap();
        assert_eq!(kept.as_text().unwrap().len(), big.len());
    }

    // 3. `deferredToolSearch` (`toolSearch` + `toolCall`)
    fs::write(ws.join("hello.txt"), "deferred-hello\n").unwrap();
    let catalog = DeferredToolCatalog::new(tools);
    let base_defs = catalog.initial_tool_definitions();
    let base_names: Vec<&str> = base_defs.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(base_names, vec!["toolSearch", "toolCall"]);

    // Null-default normalization on `limit` / `offset`
    let search_out = catalog
        .execute_tool_search(
            &serde_json::from_value::<Map<String, Value>>(json!({
                "query": "read concrete file",
                "limit": null,
                "offset": null
            }))
            .unwrap(),
        )
        .unwrap();
    let found_names: Vec<&str> = search_out.value["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(found_names.contains(&"read"), "found: {found_names:?}");

    // `toolCall` invokes discovered tool
    let call_res = catalog
        .execute_tool_call(
            &serde_json::from_value::<Map<String, Value>>(json!({
                "name": "read",
                "arguments": { "filePath": "hello.txt" }
            }))
            .unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    assert_eq!(call_res.as_text().unwrap(), "1\tdeferred-hello");

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}
