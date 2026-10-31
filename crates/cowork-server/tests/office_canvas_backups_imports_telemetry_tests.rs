use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Response, StatusCode, header};
use axum::routing::post;
use cowork_config::ProviderName;
use cowork_protocol::WEBSOCKET_SUBPROTOCOL;
use cowork_server::{ServerOptions, start_server};
use cowork_storage::{
    PersistedSessionMutation, PersistedSessionSnapshotData, SessionDb, SessionDbOptions,
    SessionKind, SessionPersistenceStatus, SessionTitleSource,
};
use futures_util::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct IsolatedServerEnv {
    _root: TempDir,
    base: PathBuf,
    home: PathBuf,
    cowork_home: PathBuf,
    workspace: PathBuf,
    env: HashMap<String, String>,
}

impl IsolatedServerEnv {
    fn new(prefix: &str) -> Self {
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in("/private/tmp")
            .expect("tempdir in /private/tmp");
        let base = fs::canonicalize(root.path()).unwrap();
        let home = base.join("home");
        let cowork_home = home.join(".cowork");
        let workspace = base.join("workspace");
        let tmp_dir = base.join("tmp");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cowork_home).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&tmp_dir).unwrap();

        let mut env = HashMap::new();
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
        env.insert("TMPDIR".into(), tmp_dir.to_string_lossy().into_owned());
        env.insert(
            "COWORK_HOME_OVERRIDE".into(),
            cowork_home.to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_ELECTRON_USER_DATA_DIR".into(),
            base.join("electron").to_string_lossy().into_owned(),
        );
        env.insert(
            "COWORK_DESKTOP_USER_DATA_DIR".into(),
            base.join("desktop").to_string_lossy().into_owned(),
        );
        env.insert("COWORK_DISABLE_RUNTIME".into(), "1".into());
        env.insert("COWORK_RUNTIME_ALLOW_NETWORK".into(), "0".into());
        env.insert("COWORK_DISABLE_NETWORK_TELEMETRY".into(), "1".into());
        env.insert(
            "PATH".into(),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        );
        Self {
            _root: root,
            base,
            home,
            cowork_home,
            workspace,
            env,
        }
    }

    fn server_options(&self, yolo: bool) -> ServerOptions {
        ServerOptions {
            working_directory: self.workspace.clone(),
            host: "127.0.0.1".into(),
            port: 0,
            yolo,
            mobile_h3: false,
            mobile_h3_host: "127.0.0.1".into(),
            mobile_h3_port: 0,
            homedir: Some(self.home.clone()),
            built_in_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
            env: self.env.clone(),
        }
    }
}

fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default();
        for (name, body) in entries {
            writer.start_file(*name, opts).expect("start zip entry");
            writer.write_all(body).expect("write zip entry");
        }
        writer.finish().expect("finish zip");
    }
    cursor.into_inner()
}

const TINY_PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D', b'R',
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, b'I', b'D', b'A', b'T', 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, b'I', b'E', b'N',
    b'D', 0xae, 0x42, 0x60, 0x82,
];

async fn connect_ready_ws(ws_url: &str) -> WsStream {
    let mut req = ws_url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        WEBSOCKET_SUBPROTOCOL.parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();

    ws.send(WsMessage::Text(
        json!({
            "id": "init-1",
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "m3-office-backups-imports-e2e", "version": "1.0.0" },
                "capabilities": { "experimentalApi": true, "toolRetryLineage": true }
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let _ = ws.next().await.unwrap().unwrap();

    ws.send(WsMessage::Text(
        json!({
            "method": "initialized",
            "params": {}
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    ws
}

async fn ws_call_collecting(
    ws: &mut WsStream,
    id: &str,
    method: &str,
    params: Value,
    notifs: &mut Vec<Value>,
) -> Value {
    ws.send(WsMessage::Text(
        json!({
            "id": id,
            "method": method,
            "params": params,
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();

    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), ws.next())
            .await
            .expect("ws_call timeout")
            .expect("ws open")
            .expect("ws frame ok");
        if let WsMessage::Text(txt) = frame {
            let val: Value = serde_json::from_str(&txt).unwrap();
            assert!(
                val.get("jsonrpc").is_none(),
                "JSON-RPC-lite frame must omit jsonrpc: {val}"
            );
            if val.get("id") == Some(&json!(id)) && val.get("method").is_none() {
                return val;
            }
            if val.get("method").is_some() {
                notifs.push(val);
            }
        }
    }
}

async fn collect_until<F>(ws: &mut WsStream, notifs: &mut Vec<Value>, timeout_ms: u64, pred: F)
where
    F: Fn(&[Value]) -> bool,
{
    if pred(notifs) {
        return;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(rem, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(txt)))) => {
                if let Ok(val) = serde_json::from_str::<Value>(&txt) {
                    assert!(
                        val.get("jsonrpc").is_none(),
                        "JSON-RPC-lite notification must omit jsonrpc: {val}"
                    );
                    if val.get("method").is_some() {
                        notifs.push(val);
                        if pred(notifs) {
                            return;
                        }
                    }
                }
            }
            _ => break,
        }
    }
}

fn sse_resp(body: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

fn chat_sse_text(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text:?}}}}}]}}\n\n",
            "data: {{\"id\":\"cmpl-txt\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":100,\"completion_tokens\":20,\"total_tokens\":120}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = text,
    )
}

#[tokio::test]
async fn websocket_ooxml_artifact_previews_diffs_canvas_spreadsheet_and_presentation_e2e() {
    let mut iso = IsolatedServerEnv::new("cowork-srv-ooxml-canvas-");
    iso.env.insert("COWORK_ENABLE_TASKS".into(), "1".into());
    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(|| async move { sse_resp(chat_sse_text("Kickoff turn acknowledged.")) }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let _llm_task = tokio::spawn(async move {
        axum::serve(llm_listener, llm_app).await.unwrap();
    });
    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{llm_port}/v1"),
    );
    fs::create_dir_all(iso.cowork_home.join("config")).unwrap();
    fs::write(
        iso.cowork_home.join("config/config.json"),
        serde_json::to_string_pretty(&json!({
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5"
        }))
        .unwrap(),
    )
    .unwrap();

    // Seed v1 OOXML files (.docx, .pptx, .xlsx) and a markdown canvas document inside workspace
    let docx_v1 = build_zip(&[
        (
            "word/document.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Exec Memo</w:t></w:r></w:p>
    <w:p><w:r><w:t>Revenue Q1 baseline.</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>KPI</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>"#,
        ),
        ("word/media/logo.png", TINY_PNG),
    ]);
    let docx_v2 = build_zip(&[
        (
            "word/document.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Exec Memo v2</w:t></w:r></w:p>
    <w:p><w:r><w:t>Revenue Q2 updated.</w:t></w:r><w:ins w:author="Ada"><w:r><w:t> +15%</w:t></w:r></w:ins></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>KPI</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>115</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>"#,
        ),
        ("word/media/logo.png", TINY_PNG),
    ]);

    let pptx_v1 = build_zip(&[
        (
            "ppt/presentation.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="9144000" cy="5143500"/>
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>"#,
        ),
        (
            "ppt/_rels/presentation.xml.rels",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>"#,
        ),
        (
            "ppt/slides/slide1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Kickoff Deck</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Bullet Alpha</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>"#,
        ),
    ]);
    let pptx_v2 = build_zip(&[
        (
            "ppt/presentation.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="9144000" cy="5143500"/>
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>"#,
        ),
        (
            "ppt/_rels/presentation.xml.rels",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>"#,
        ),
        (
            "ppt/slides/slide1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Kickoff Deck Updated</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Bullet Beta</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>"#,
        ),
    ]);

    let xlsx_v1 = build_zip(&[
        (
            "[Content_Types].xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>"#,
        ),
        (
            "xl/workbook.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"#,
        ),
        (
            "xl/sharedStrings.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
  <si><t>Revenue</t></si>
</sst>"#,
        ),
        (
            "xl/worksheets/sheet1.xml",
            br#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1"><v>250</v></c>
    </row>
  </sheetData>
</worksheet>"#,
        ),
    ]);

    fs::write(iso.workspace.join("memo.docx"), &docx_v1).unwrap();
    fs::write(iso.workspace.join("deck.pptx"), &pptx_v1).unwrap();
    fs::write(iso.workspace.join("budget.xlsx"), &xlsx_v1).unwrap();
    fs::write(iso.workspace.join("table.csv"), "Metric,Q1\nARR,120\n").unwrap();
    fs::write(
        iso.workspace.join("notes.md"),
        "# Draft\nInitial canvas body.\n",
    )
    .unwrap();

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let mut notifs = Vec::new();
    let cwd_str = iso.workspace.to_string_lossy().into_owned();

    // -------------------------------------------------------------------------
    // 1. OOXML Task Artifact Preview & Compare (`VAL-EXT-005`)
    // -------------------------------------------------------------------------
    let create_task = ws_call_collecting(
        &mut ws,
        "t-create",
        "task/create",
        json!({
            "cwd": cwd_str,
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5",
            "idempotencyKey": "idem-ooxml-task-1",
            "title": "Office Review Task",
            "objective": "Compare OOXML revisions",
            "context": "Compare OOXML revisions across v1 and v2.",
            "requirements": [
                { "kind": "acceptance_criterion", "text": "Inspect OOXML diffs", "permanence": "fixed" }
            ],
            "workItems": [
                { "key": "review", "title": "Inspect OOXML artifacts", "expectedOutputs": ["memo.docx"] }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert!(
        create_task.get("error").is_none(),
        "task/create failed: {create_task}"
    );
    let task_id = create_task["result"]["task"]["id"]
        .as_str()
        .expect("task id")
        .to_owned();
    let mut task_rev = create_task["result"]["task"]["revision"]
        .as_i64()
        .expect("task rev");

    // Register .docx, .pptx, and .xlsx v1 artifacts
    let mut artifact_ids = HashMap::new();
    let mut v1_ids = HashMap::new();
    for (label, rel_path) in [
        ("docx", "memo.docx"),
        ("pptx", "deck.pptx"),
        ("xlsx", "budget.xlsx"),
    ] {
        let reg = ws_call_collecting(
            &mut ws,
            &format!("reg-{label}"),
            "task/artifact/register",
            json!({
                "cwd": cwd_str,
                "taskId": task_id,
                "expectedRevision": task_rev,
                "path": rel_path,
                "title": format!("Artifact {label}"),
                "kind": "document",
            }),
            &mut notifs,
        )
        .await;
        assert!(reg.get("error").is_none(), "register {label} failed: {reg}");
        task_rev = reg["result"]["task"]["revision"].as_i64().unwrap();
        let art_id = reg["result"]["task"]["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["path"].as_str().is_some_and(|p| p.ends_with(rel_path)))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let art_read = ws_call_collecting(
            &mut ws,
            &format!("read-{label}"),
            "task/artifact/read",
            json!({
                "cwd": cwd_str,
                "taskId": task_id,
                "artifactId": art_id,
            }),
            &mut notifs,
        )
        .await;
        assert!(
            art_read.get("error").is_none(),
            "read {label} failed: {art_read}"
        );
        let ver_id = art_read["result"]["detail"]["versions"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        artifact_ids.insert(label, art_id);
        v1_ids.insert(label, ver_id);
    }

    // Patch budget.xlsx via spreadsheet RPC (which also produces v2 for artifact comparison!)
    let wb_ver_res = ws_call_collecting(
        &mut ws,
        "ss-ver-1",
        "cowork/workspace/spreadsheet/version",
        json!({ "cwd": cwd_str, "path": "budget.xlsx" }),
        &mut notifs,
    )
    .await;
    assert_eq!(wb_ver_res["result"]["ok"], true);
    let xlsx_ver_1 = wb_ver_res["result"]["version"].clone();

    notifs.clear();
    let ss_patch_res = ws_call_collecting(
        &mut ws,
        "ss-patch-1",
        "cowork/workspace/spreadsheet/patch",
        json!({
            "cwd": cwd_str,
            "path": "budget.xlsx",
            "expectedFileVersion": xlsx_ver_1,
            "operations": [
                {
                    "type": "cell",
                    "sheetName": "Summary",
                    "address": "B1",
                    "rawInput": "325"
                },
                {
                    "type": "cell",
                    "sheetName": "Summary",
                    "address": "C1",
                    "rawInput": "=B1*2"
                },
                {
                    "type": "format",
                    "sheetName": "Summary",
                    "range": "A1:C1",
                    "style": { "bold": true, "fillColor": "#FFEEAA" }
                },
                {
                    "type": "columnWidth",
                    "sheetName": "Summary",
                    "col": 1,
                    "widthPx": 140
                }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        ss_patch_res["result"]["ok"], true,
        "xlsx patch failed: {ss_patch_res}"
    );
    // Notification MUST NOT have arrived before the response in `ws_call_collecting`!
    assert!(
        !notifs
            .iter()
            .any(|n| n["method"] == "cowork/workspace/fileChanged"),
        "fileChanged must arrive AFTER RPC response: {notifs:?}"
    );
    collect_until(&mut ws, &mut notifs, 2000, |ns| {
        ns.iter()
            .any(|n| n["method"] == "cowork/workspace/fileChanged")
    })
    .await;
    assert!(
        notifs
            .iter()
            .any(|n| n["method"] == "cowork/workspace/fileChanged"
                && n["params"]["path"]
                    .as_str()
                    .is_some_and(|p| p.ends_with("budget.xlsx"))),
        "expected post-response fileChanged for budget.xlsx: {notifs:?}"
    );

    // Stale `expectedFileVersion` on spreadsheet patch must return `ok: false, error.kind == "conflict"`
    let ss_conflict = ws_call_collecting(
        &mut ws,
        "ss-patch-conflict",
        "cowork/workspace/spreadsheet/patch",
        json!({
            "cwd": cwd_str,
            "path": "budget.xlsx",
            "expectedFileVersion": xlsx_ver_1,
            "operations": [
                { "type": "cell", "sheetName": "Summary", "address": "B1", "rawInput": "999" }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(ss_conflict["result"]["ok"], false);
    assert_eq!(ss_conflict["result"]["error"]["kind"], "write_error");
    assert!(
        ss_conflict["result"]["error"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("changed")),
        "expected stale version message: {ss_conflict}"
    );

    // Read workbook snapshot and verify updated cell + formula + width
    let wb_snap = ws_call_collecting(
        &mut ws,
        "ss-wb-1",
        "cowork/workspace/spreadsheet/workbook",
        json!({ "cwd": cwd_str, "path": "budget.xlsx" }),
        &mut notifs,
    )
    .await;
    assert_eq!(wb_snap["result"]["ok"], true);
    assert_eq!(wb_snap["result"]["workbook"]["kind"], "xlsx");
    assert_eq!(
        wb_snap["result"]["workbook"]["sheets"][0]["name"],
        "Summary"
    );

    // Also verify CSV workbook + patch
    let csv_patch = ws_call_collecting(
        &mut ws,
        "ss-csv-patch",
        "cowork/workspace/spreadsheet/patch",
        json!({
            "cwd": cwd_str,
            "path": "table.csv",
            "operations": [
                { "type": "cell", "sheetName": "table", "address": "B2", "rawInput": "180" }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        csv_patch["result"]["ok"], true,
        "csv patch failed: {csv_patch}"
    );
    assert!(
        fs::read_to_string(iso.workspace.join("table.csv"))
            .unwrap()
            .contains("180")
    );

    // Write v2 of .docx and .pptx on disk and capture v2 for all 3 OOXML task artifacts
    fs::write(iso.workspace.join("memo.docx"), &docx_v2).unwrap();
    fs::write(iso.workspace.join("deck.pptx"), &pptx_v2).unwrap();

    for (label, expected_kind) in [("docx", "docx"), ("pptx", "pptx"), ("xlsx", "xlsx")] {
        let art_id = artifact_ids[label].clone();
        let cap = ws_call_collecting(
            &mut ws,
            &format!("cap-{label}"),
            "task/artifact/version/capture",
            json!({
                "cwd": cwd_str,
                "taskId": task_id,
                "artifactId": art_id,
                "expectedRevision": task_rev,
                "changeSummary": format!("Updated {label} to v2"),
            }),
            &mut notifs,
        )
        .await;
        assert!(cap.get("error").is_none(), "capture {label} failed: {cap}");
        task_rev = cap["result"]["task"]["revision"].as_i64().unwrap();
        let v2_id = cap["result"]["detail"]["versions"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();

        let prev = ws_call_collecting(
            &mut ws,
            &format!("prev-{label}"),
            "task/artifact/version/preview",
            json!({
                "cwd": cwd_str,
                "taskId": task_id,
                "artifactId": art_id,
                "versionId": v2_id,
            }),
            &mut notifs,
        )
        .await;
        assert_eq!(
            prev["result"]["preview"]["kind"], expected_kind,
            "unexpected preview kind for {label}: {prev}"
        );

        let cmp = ws_call_collecting(
            &mut ws,
            &format!("cmp-{label}"),
            "task/artifact/version/compare",
            json!({
                "cwd": cwd_str,
                "taskId": task_id,
                "artifactId": art_id,
                "baseVersionId": v1_ids[label],
                "targetVersionId": v2_id,
            }),
            &mut notifs,
        )
        .await;
        assert_eq!(
            cmp["result"]["comparison"]["kind"], expected_kind,
            "unexpected comparison kind for {label}: {cmp}"
        );
    }

    // -------------------------------------------------------------------------
    // 2. Presentation Preview (`cowork/workspace/presentation/preview`)
    // -------------------------------------------------------------------------
    let pres_ok = ws_call_collecting(
        &mut ws,
        "pres-ok",
        "cowork/workspace/presentation/preview",
        json!({ "cwd": cwd_str, "path": "deck.pptx" }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        pres_ok["result"]["ok"], true,
        "presentation preview failed: {pres_ok}"
    );
    let slides = pres_ok["result"]["slides"].as_array().unwrap();
    assert_eq!(slides.len(), 1);
    assert!(
        slides[0]["pngBase64"]
            .as_str()
            .is_some_and(|b| !b.is_empty()),
        "expected pngBase64 on slide preview: {pres_ok}"
    );

    let pres_outside = ws_call_collecting(
        &mut ws,
        "pres-out",
        "cowork/workspace/presentation/preview",
        json!({ "cwd": cwd_str, "path": "../outside.pptx" }),
        &mut notifs,
    )
    .await;
    assert_eq!(pres_outside["result"]["ok"], false);
    assert_eq!(pres_outside["result"]["error"]["kind"], "compile_error");
    assert_eq!(
        pres_outside["result"]["error"]["message"],
        "Path is outside the workspace root."
    );

    // -------------------------------------------------------------------------
    // 3. Canvas Document Lifecycle (`cowork/workspace/document/*`)
    // -------------------------------------------------------------------------
    let doc_open = ws_call_collecting(
        &mut ws,
        "doc-open-1",
        "cowork/workspace/document/open",
        json!({
            "path": "notes.md",
            "documentId": "doc-notes-1",
            "generation": 1
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        doc_open["result"]["ok"], true,
        "doc open failed: {doc_open}"
    );
    let rev1 = doc_open["result"]["document"]["revision"].clone();

    // Save updated content (`editRevision: 2`) and assert `cowork/workspace/fileChanged` arrives AFTER RPC response
    notifs.clear();
    let doc_save = ws_call_collecting(
        &mut ws,
        "doc-save-1",
        "cowork/workspace/document/save",
        json!({
            "documentId": "doc-notes-1",
            "generation": 1,
            "editRevision": 2,
            "content": "# Draft\nUpdated via Canvas save.\n"
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        doc_save["result"]["ok"], true,
        "doc save failed: {doc_save}"
    );
    assert_eq!(
        doc_save["result"]["status"], "saved",
        "doc save failed: {doc_save}"
    );
    assert!(
        !notifs
            .iter()
            .any(|n| n["method"] == "cowork/workspace/fileChanged"),
        "Canvas save fileChanged must arrive AFTER RPC response"
    );
    collect_until(&mut ws, &mut notifs, 2000, |ns| {
        ns.iter()
            .any(|n| n["method"] == "cowork/workspace/fileChanged")
    })
    .await;
    assert!(
        notifs
            .iter()
            .any(|n| n["method"] == "cowork/workspace/fileChanged"),
        "expected fileChanged after Canvas save"
    );
    let rev2 = doc_save["result"]["revision"].clone();
    assert_ne!(rev1, rev2);

    // Superseded `editRevision` (< 2) returns `ok: true, status: "superseded"`
    let doc_sup = ws_call_collecting(
        &mut ws,
        "doc-save-sup",
        "cowork/workspace/document/save",
        json!({
            "documentId": "doc-notes-1",
            "generation": 1,
            "editRevision": 1,
            "content": "# Ignored\n"
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(doc_sup["result"]["ok"], true);
    assert_eq!(doc_sup["result"]["status"], "superseded");

    // External modification triggers changed `revision` & `error.kind == "conflict"` on save
    std::thread::sleep(Duration::from_millis(20));
    fs::write(
        iso.workspace.join("notes.md"),
        "# External Edit\nChanged outside Canvas.\n",
    )
    .unwrap();
    let doc_rev_check = ws_call_collecting(
        &mut ws,
        "doc-rev-1",
        "cowork/workspace/document/revision",
        json!({
            "documentId": "doc-notes-1",
            "generation": 1
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(doc_rev_check["result"]["ok"], true);
    assert_ne!(doc_rev_check["result"]["revision"], rev2);

    let doc_conflict = ws_call_collecting(
        &mut ws,
        "doc-save-conflict",
        "cowork/workspace/document/save",
        json!({
            "documentId": "doc-notes-1",
            "generation": 1,
            "editRevision": 3,
            "content": "# Conflicting\n"
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(doc_conflict["result"]["ok"], false);
    assert_eq!(doc_conflict["result"]["error"]["kind"], "conflict");

    // `saveAs` traversal outside workspace fails; inside workspace succeeds & emits post-response `fileChanged`
    let doc_escape = ws_call_collecting(
        &mut ws,
        "doc-saveas-escape",
        "cowork/workspace/document/saveAs",
        json!({
            "documentId": "doc-notes-1",
            "generation": 1,
            "editRevision": 4,
            "path": "../escape.md",
            "content": "nope"
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(doc_escape["result"]["ok"], false);
    assert_eq!(doc_escape["result"]["error"]["kind"], "outside_workspace");

    notifs.clear();
    let doc_save_as = ws_call_collecting(
        &mut ws,
        "doc-saveas-ok",
        "cowork/workspace/document/saveAs",
        json!({
            "documentId": "doc-notes-1",
            "generation": 1,
            "editRevision": 5,
            "path": "notes-copy.md",
            "content": "# Saved Copy\n"
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(doc_save_as["result"]["ok"], true);
    assert_eq!(doc_save_as["result"]["status"], "saved");
    collect_until(&mut ws, &mut notifs, 2000, |ns| {
        ns.iter()
            .any(|n| n["method"] == "cowork/workspace/fileChanged")
    })
    .await;

    let doc_close = ws_call_collecting(
        &mut ws,
        "doc-close-1",
        "cowork/workspace/document/close",
        json!({
            "documentId": "doc-notes-1",
            "generation": 1
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(doc_close["result"]["ok"], true);
    assert_eq!(doc_close["result"]["documentId"], "doc-notes-1");

    server.shutdown().await;
}

#[tokio::test]
async fn websocket_workspace_backups_opt_in_lifecycle_and_turn_checkpoints_e2e() {
    let mut iso = IsolatedServerEnv::new("cowork-srv-backups-e2e-");
    fs::write(iso.workspace.join("app.txt"), "initial-v1\n").unwrap();

    // Mock Together LLM for turn execution
    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(|| async move { sse_resp(chat_sse_text("Turn finished cleanly.")) }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let _llm_task = tokio::spawn(async move {
        axum::serve(llm_listener, llm_app).await.unwrap();
    });
    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{llm_port}/v1"),
    );

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let mut notifs = Vec::new();
    let cwd_str = iso.workspace.to_string_lossy().into_owned();

    // 1. Disabled by default: workspace backups read must reject
    let disabled_res = ws_call_collecting(
        &mut ws,
        "bk-disabled",
        "cowork/backups/workspace/read",
        json!({ "cwd": cwd_str }),
        &mut notifs,
    )
    .await;
    assert!(
        disabled_res.get("error").is_some(),
        "backups must reject when disabled by default: {disabled_res}"
    );

    // 2. Enable workspace backups via `cowork/session/defaults/apply`
    let apply_res = ws_call_collecting(
        &mut ws,
        "cfg-enable-bk",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd_str,
            "config": { "backupsEnabled": true }
        }),
        &mut notifs,
    )
    .await;
    assert!(
        apply_res.get("error").is_none(),
        "defaults/apply failed: {apply_res}"
    );

    // 3. Start thread & toggle session backupsEnabled -> verify `cowork/session/backupState` ("requested")
    let start_res = ws_call_collecting(
        &mut ws,
        "th-start",
        "thread/start",
        json!({
            "cwd": cwd_str,
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5"
        }),
        &mut notifs,
    )
    .await;
    let thread_id = start_res["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    notifs.clear();
    let set_cfg = ws_call_collecting(
        &mut ws,
        "sess-bk-on",
        "cowork/session/config/set",
        json!({
            "threadId": thread_id,
            "config": { "backupsEnabled": true }
        }),
        &mut notifs,
    )
    .await;
    assert!(
        set_cfg.get("error").is_none(),
        "session config/set failed: {set_cfg}"
    );
    collect_until(&mut ws, &mut notifs, 2000, |ns| {
        ns.iter()
            .any(|n| n["method"] == "cowork/session/backupState")
    })
    .await;
    let bk_notif = notifs
        .iter()
        .find(|n| n["method"] == "cowork/session/backupState")
        .expect("expected session/backupState notification");
    assert_eq!(bk_notif["params"]["reason"], "requested");
    assert_eq!(bk_notif["params"]["backup"]["status"], "ready");
    assert_eq!(
        bk_notif["params"]["backup"]["originalSnapshot"]["kind"],
        "tar_gz"
    );

    // 4. Modify workspace file, run a turn, then create a manual checkpoint and inspect delta
    fs::write(iso.workspace.join("app.txt"), "modified-v2\n").unwrap();
    fs::write(iso.workspace.join("extra.txt"), "brand-new\n").unwrap();

    notifs.clear();
    let turn_res = ws_call_collecting(
        &mut ws,
        "turn-1",
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": "Hello backup turn" }]
        }),
        &mut notifs,
    )
    .await;
    assert!(turn_res.get("error").is_none());
    collect_until(&mut ws, &mut notifs, 5000, |ns| {
        ns.iter().any(|n| n["method"] == "turn/completed")
    })
    .await;

    let cp_res = ws_call_collecting(
        &mut ws,
        "bk-cp-manual",
        "cowork/backups/workspace/checkpoint",
        json!({
            "cwd": cwd_str,
            "targetSessionId": thread_id
        }),
        &mut notifs,
    )
    .await;
    assert!(
        cp_res.get("error").is_none(),
        "manual checkpoint failed: {cp_res}"
    );
    let checkpoints = cp_res["result"]["event"]["backups"][0]["checkpoints"]
        .as_array()
        .unwrap()
        .clone();
    assert!(
        checkpoints.len() >= 2,
        "expected initial + manual checkpoints: {checkpoints:?}"
    );
    let manual_cp_id = checkpoints.last().unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Read delta preview comparing initial baseline (`cp-0001`) against current modified workspace
    let delta_res = ws_call_collecting(
        &mut ws,
        "bk-delta",
        "cowork/backups/workspace/delta/read",
        json!({
            "cwd": cwd_str,
            "targetSessionId": thread_id,
            "checkpointId": "cp-0001"
        }),
        &mut notifs,
    )
    .await;
    assert!(
        delta_res.get("error").is_none(),
        "delta read failed: {delta_res}"
    );
    assert_eq!(
        delta_res["result"]["event"]["type"],
        "workspace_backup_delta"
    );
    let counts = &delta_res["result"]["event"]["counts"];
    assert!(
        counts["added"].as_u64().unwrap() + counts["modified"].as_u64().unwrap() >= 1,
        "expected added/modified files in delta counts: {delta_res}"
    );

    // 5. Restore original snapshot -> file content reverts to `initial-v1\n`, `extra.txt` removed, safety manual checkpoint created
    let restore_res = ws_call_collecting(
        &mut ws,
        "bk-restore",
        "cowork/backups/workspace/restore",
        json!({
            "cwd": cwd_str,
            "targetSessionId": thread_id,
            "checkpointId": "original"
        }),
        &mut notifs,
    )
    .await;
    assert!(
        restore_res.get("error").is_none(),
        "restore failed: {restore_res}"
    );
    assert_eq!(
        fs::read_to_string(iso.workspace.join("app.txt")).unwrap(),
        "initial-v1\n"
    );
    assert!(!iso.workspace.join("extra.txt").exists());

    // 6. Deleting initial checkpoint `cp-0001` is rejected; deleting manual checkpoint succeeds
    let del_init = ws_call_collecting(
        &mut ws,
        "bk-del-init",
        "cowork/backups/workspace/deleteCheckpoint",
        json!({
            "cwd": cwd_str,
            "targetSessionId": thread_id,
            "checkpointId": "cp-0001"
        }),
        &mut notifs,
    )
    .await;
    assert!(
        del_init.get("error").is_some(),
        "must forbid deleting initial checkpoint"
    );

    let del_manual = ws_call_collecting(
        &mut ws,
        "bk-del-manual",
        "cowork/backups/workspace/deleteCheckpoint",
        json!({
            "cwd": cwd_str,
            "targetSessionId": thread_id,
            "checkpointId": manual_cp_id
        }),
        &mut notifs,
    )
    .await;
    assert!(
        del_manual.get("error").is_none(),
        "delete manual checkpoint failed: {del_manual}"
    );

    // 7. Delete backup entry -> clears entry and sets live session `backupsEnabled` override to false
    notifs.clear();
    let del_entry = ws_call_collecting(
        &mut ws,
        "bk-del-entry",
        "cowork/backups/workspace/deleteEntry",
        json!({
            "cwd": cwd_str,
            "targetSessionId": thread_id
        }),
        &mut notifs,
    )
    .await;
    assert!(
        del_entry.get("error").is_none(),
        "delete entry failed: {del_entry}"
    );
    assert!(
        del_entry["result"]["event"]["backups"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    collect_until(&mut ws, &mut notifs, 2000, |ns| {
        ns.iter().any(|n| {
            n["method"] == "cowork/session/backupState" && n["params"]["reason"] == "delete"
        })
    })
    .await;
    assert!(
        notifs.iter().any(|n| {
            n["method"] == "cowork/session/backupState"
                && n["params"]["reason"] == "delete"
                && n["params"]["backup"]["status"] == "disabled"
        }),
        "expected disabled backupState notification on deleteEntry: {notifs:?}"
    );

    server.shutdown().await;
}

#[tokio::test]
async fn websocket_external_importers_conversations_and_skill_improvement_e2e() {
    let mut iso = IsolatedServerEnv::new("cowork-srv-importers-e2e-");

    // 1. Seed external Codex skill + Claude Code plugin in isolated `$HOME`
    let codex_skill_dir = iso.home.join(".codex/skills/codex-helper");
    fs::create_dir_all(&codex_skill_dir).unwrap();
    fs::write(
        codex_skill_dir.join("SKILL.md"),
        "---\nname: codex-helper\ndescription: Helps analyze Rust code\n---\nAlways check compiler errors carefully.\n",
    )
    .unwrap();

    let claude_plugin_cache = iso.home.join(".claude/plugins/cache/acme-kit/1.0.0");
    fs::create_dir_all(claude_plugin_cache.join(".claude-plugin")).unwrap();
    fs::create_dir_all(claude_plugin_cache.join("skills/acme-lint")).unwrap();
    let claude_manifest_raw = serde_json::to_string_pretty(&json!({
        "name": "acme-kit",
        "version": "1.0.0",
        "description": "Acme toolkit plugin",
        "mcpServers": "./.mcp.json"
    }))
    .unwrap();
    fs::write(
        claude_plugin_cache.join(".claude-plugin/plugin.json"),
        &claude_manifest_raw,
    )
    .unwrap();
    fs::write(
        claude_plugin_cache.join(".mcp.json"),
        serde_json::to_string_pretty(&json!({
            "mcpServers": {
                "acme-stdio": { "command": "echo", "args": ["ok"] }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        claude_plugin_cache.join("skills/acme-lint/SKILL.md"),
        "---\nname: acme-lint\ndescription: Lint helper\n---\nRun lint.\n",
    )
    .unwrap();
    fs::create_dir_all(iso.home.join(".claude/plugins")).unwrap();
    fs::write(
        iso.home.join(".claude/plugins/installed_plugins.json"),
        serde_json::to_string_pretty(&json!({
            "version": 2,
            "plugins": {
                "acme-kit@market": [
                    { "installPath": claude_plugin_cache.to_string_lossy() }
                ]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    // 2. Seed Codex conversation rollout + sqlite, Claude Code JSONL, and external Cowork `sessions.db`
    let codex_home = iso.home.join(".codex");
    let rollout_dir = codex_home.join("sessions/2026/03/20");
    fs::create_dir_all(&rollout_dir).unwrap();
    let rollout_path = rollout_dir.join("rollout-codex-e2e-1.jsonl");
    let long_tok = "B".repeat(180);
    let rollout_lines = [
        json!({
            "timestamp": "2026-03-20T10:00:00.000Z",
            "type": "session_meta",
            "payload": {
                "id": "codex-e2e-1",
                "cwd": iso.workspace.to_string_lossy(),
                "model_provider": "openai",
                "model": "gpt-5"
            }
        }),
        json!({
            "timestamp": "2026-03-20T10:00:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": format!("Audit token {long_tok}") }]
            }
        }),
        json!({
            "timestamp": "2026-03-20T10:00:02.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Audit complete." }]
            }
        }),
    ];
    fs::write(
        &rollout_path,
        rollout_lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    {
        let conn = Connection::open(codex_home.join("state_5.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT,
                created_at INTEGER,
                updated_at INTEGER,
                cwd TEXT,
                title TEXT,
                archived INTEGER DEFAULT 0,
                model_provider TEXT,
                model TEXT
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, archived, model_provider, model)
             VALUES (?1, ?2, 1774000800, 1774000802, ?3, 'Codex E2E Thread', 0, 'openai', 'gpt-5')",
            rusqlite::params![
                "codex-e2e-1",
                rollout_path.to_string_lossy().as_ref(),
                iso.workspace.to_string_lossy().as_ref(),
            ],
        )
        .unwrap();
    }

    let claude_proj_dir = iso.home.join(".claude/projects/proj-e2e");
    fs::create_dir_all(&claude_proj_dir).unwrap();
    let new_import_ws = iso.base.join("created-via-import-ws");
    fs::create_dir_all(&new_import_ws).unwrap();
    let claude_lines = [
        json!({
            "type": "user",
            "sessionId": "claude-e2e-1",
            "cwd": iso.base.join("missing-legacy-dir").to_string_lossy(),
            "timestamp": "2026-03-21T12:00:00.000Z",
            "message": { "role": "user", "content": "Hello Claude importer" }
        }),
        json!({
            "type": "assistant",
            "sessionId": "claude-e2e-1",
            "cwd": iso.base.join("missing-legacy-dir").to_string_lossy(),
            "timestamp": "2026-03-21T12:00:05.000Z",
            "message": {
                "role": "assistant",
                "model": "claude-sonnet-4-5",
                "content": [{ "type": "text", "text": "Imported from Claude Code." }]
            }
        }),
    ];
    fs::write(
        claude_proj_dir.join("claude-e2e-1.jsonl"),
        claude_lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();

    let ext_cowork_dir = iso.base.join("ext-cowork-home");
    let ext_db = SessionDb::open(SessionDbOptions {
        root_dir: ext_cowork_dir.clone(),
        sessions_dir: ext_cowork_dir.join("sessions"),
        db_path: None,
        busy_timeout_ms: None,
    })
    .await
    .unwrap();
    ext_db
        .persist_session_mutation(PersistedSessionMutation {
            session_id: "ext-cw-1".into(),
            event_type: "session_created".into(),
            event_ts: Some("2026-03-22T09:00:00.000Z".into()),
            direction: Some("outbound".into()),
            payload: Some(json!({})),
            snapshot: PersistedSessionSnapshotData {
                session_kind: SessionKind::Root,
                parent_session_id: None,
                role: None,
                mode: None,
                depth: None,
                nickname: None,
                task_type: None,
                target_paths: None,
                profile: None,
                requested_model: None,
                effective_model: None,
                requested_reasoning_effort: None,
                effective_reasoning_effort: None,
                execution_state: None,
                last_message_preview: Some("From external Cowork".into()),
                title: "External Cowork Thread".into(),
                title_source: SessionTitleSource::Manual,
                title_model: None,
                provider: ProviderName::Openai,
                model: "gpt-5".into(),
                working_directory: iso.workspace.to_string_lossy().into_owned(),
                output_directory: None,
                uploads_directory: None,
                provider_options: None,
                sandbox: None,
                enable_mcp: true,
                backups_enabled_override: None,
                created_at: "2026-03-22T09:00:00.000Z".into(),
                updated_at: "2026-03-22T09:00:05.000Z".into(),
                status: SessionPersistenceStatus::Closed,
                has_pending_ask: false,
                has_pending_approval: false,
                system_prompt: String::new(),
                messages: vec![
                    json!({ "role": "user", "content": "External Cowork prompt" }),
                    json!({ "role": "assistant", "content": "From external Cowork" }),
                ],
                last_memory_generated_index: None,
                provider_state: None,
                todos: Vec::new(),
                harness_context: None,
                cost_tracker: None,
            },
        })
        .await
        .unwrap();
    ext_db
        .persist_session_snapshot(
            "ext-cw-1",
            &json!({
                "sessionId": "ext-cw-1",
                "title": "External Cowork Thread",
                "updatedAt": "2026-03-22T09:00:05.000Z",
                "messages": [
                    { "role": "user", "content": "External Cowork prompt" },
                    { "role": "assistant", "content": "From external Cowork" }
                ],
                "feed": [
                    {
                        "id": "u1",
                        "type": "user",
                        "content": "External Cowork prompt",
                        "ts": "2026-03-22T09:00:00.000Z"
                    },
                    {
                        "id": "a1",
                        "type": "assistant",
                        "content": "From external Cowork",
                        "ts": "2026-03-22T09:00:05.000Z"
                    }
                ]
            }),
        )
        .await
        .unwrap();
    drop(ext_db);

    // Mock Together LLM for skill-usage turn
    let llm_app = Router::new().route(
        "/v1/chat/completions",
        post(|| async move { sse_resp(chat_sse_text("Used @codex-helper successfully.")) }),
    );
    let llm_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let llm_port = llm_listener.local_addr().unwrap().port();
    let _llm_task = tokio::spawn(async move {
        axum::serve(llm_listener, llm_app).await.unwrap();
    });
    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{llm_port}/v1"),
    );
    iso.env
        .insert("COWORK_WEB_DESKTOP_SERVICE".into(), "1".into());
    iso.env
        .insert("COWORK_BROWSER_ACCESS_TOKEN".into(), "imp-test-tok".into());

    let server = start_server(iso.server_options(true)).await.unwrap();
    let ws_with_tok = format!("{}?token=imp-test-tok", server.ws_url());
    let mut ws = connect_ready_ws(&ws_with_tok).await;
    let mut notifs = Vec::new();
    let cwd_str = iso.workspace.to_string_lossy().into_owned();

    // 3. `cowork/import/{list,skill,plugin}`
    let list_codex_skills = ws_call_collecting(
        &mut ws,
        "imp-list-skill",
        "cowork/import/list",
        json!({ "cwd": cwd_str, "source": "codex", "kind": "skill" }),
        &mut notifs,
    )
    .await;
    assert_eq!(list_codex_skills["result"]["event"]["type"], "import_list");
    assert_eq!(
        list_codex_skills["result"]["event"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let imp_skill = ws_call_collecting(
        &mut ws,
        "imp-skill-1",
        "cowork/import/skill",
        json!({
            "cwd": cwd_str,
            "source": "codex",
            "sourcePath": codex_skill_dir.to_string_lossy(),
            "targetScope": "workspace"
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(imp_skill["result"]["event"]["type"], "skills_catalog");
    assert!(
        iso.workspace
            .join(".cowork/skills/codex-helper/SKILL.md")
            .exists()
    );

    let imp_plugin = ws_call_collecting(
        &mut ws,
        "imp-plugin-1",
        "cowork/import/plugin",
        json!({
            "cwd": cwd_str,
            "source": "claude",
            "sourcePath": claude_plugin_cache.to_string_lossy(),
            "conversionRequired": true,
            "targetScope": "workspace"
        }),
        &mut notifs,
    )
    .await;
    let plugin_events = imp_plugin["result"]["events"].as_array().unwrap();
    assert_eq!(
        plugin_events.len(),
        4,
        "plugin import must return 4 refresh events"
    );
    // Original Claude plugin manifest must remain untouched!
    assert_eq!(
        fs::read_to_string(claude_plugin_cache.join(".claude-plugin/plugin.json")).unwrap(),
        claude_manifest_raw
    );

    // 4. `cowork/conversationImport/{sources/list,preview,workspaceMappings/validate,import}`
    let ext_db_path = ext_cowork_dir.join("sessions.db");
    let conv_sources = ws_call_collecting(
        &mut ws,
        "conv-sources",
        "cowork/conversationImport/sources/list",
        json!({
            "sources": [
                { "source": "codex" },
                { "source": "claude-code" },
                { "source": "cowork", "path": ext_db_path.to_string_lossy() }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert!(
        conv_sources.get("error").is_none(),
        "conv sources failed: {conv_sources}"
    );
    let src_arr = conv_sources["result"]["sources"].as_array().unwrap();
    assert!(
        src_arr.len() >= 3,
        "expected at least 3 source candidates: {src_arr:?}"
    );
    for expected_src in ["codex", "claude-code", "cowork"] {
        assert!(
            src_arr
                .iter()
                .any(|s| s["source"] == expected_src && s["available"] == true),
            "expected available source {expected_src}: {src_arr:?}"
        );
    }

    let codex_state_db = codex_home.join("state_5.sqlite");
    let conv_prev = ws_call_collecting(
        &mut ws,
        "conv-prev",
        "cowork/conversationImport/preview",
        json!({
            "sources": [
                { "source": "codex", "path": codex_state_db.to_string_lossy() },
                { "source": "claude-code" },
                { "source": "cowork", "path": ext_db_path.to_string_lossy() }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert!(
        conv_prev.get("error").is_none(),
        "conv preview failed: {conv_prev}"
    );
    let conversations = conv_prev["result"]["conversations"].as_array().unwrap();
    assert_eq!(
        conversations.len(),
        3,
        "expected 1 codex + 1 claude + 1 cowork conversation: {conversations:?}"
    );

    let codex_fp = conversations
        .iter()
        .find(|c| c["source"] == "codex")
        .unwrap()["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let claude_fp = conversations
        .iter()
        .find(|c| c["source"] == "claude-code")
        .unwrap()["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let cowork_fp = conversations
        .iter()
        .find(|c| c["source"] == "cowork")
        .unwrap()["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();

    // `.strict()` check: unknown field on `ConversationWorkspaceMappingInput` must return INVALID_PARAMS
    let strict_err = ws_call_collecting(
        &mut ws,
        "conv-strict-err",
        "cowork/conversationImport/workspaceMappings/validate",
        json!({
            "mappings": {
                (claude_fp.clone()): {
                    "kind": "create",
                    "path": new_import_ws.to_string_lossy(),
                    "unexpectedField": true
                }
            }
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(strict_err["error"]["code"], -32602);

    let map_valid = ws_call_collecting(
        &mut ws,
        "conv-map-ok",
        "cowork/conversationImport/workspaceMappings/validate",
        json!({
            "mappings": {
                (claude_fp.clone()): {
                    "kind": "create",
                    "path": new_import_ws.to_string_lossy(),
                    "name": "Created Via Import"
                }
            }
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        map_valid["result"]["valid"], true,
        "mapping validate failed: {map_valid}"
    );

    notifs.clear();
    let conv_imp = ws_call_collecting(
        &mut ws,
        "conv-import-1",
        "cowork/conversationImport/import",
        json!({
            "sources": [
                { "source": "codex", "path": codex_state_db.to_string_lossy() },
                { "source": "claude-code" },
                { "source": "cowork", "path": ext_db_path.to_string_lossy() }
            ],
            "selected": [
                { "source": "codex", "fingerprint": codex_fp },
                { "source": "claude-code", "fingerprint": claude_fp },
                { "source": "cowork", "fingerprint": cowork_fp }
            ],
            "mappings": {
                (claude_fp.clone()): {
                    "kind": "create",
                    "path": new_import_ws.to_string_lossy(),
                    "name": "Created Via Import"
                }
            }
        }),
        &mut notifs,
    )
    .await;
    assert!(
        conv_imp.get("error").is_none(),
        "conv import failed: {conv_imp}"
    );
    assert_eq!(conv_imp["result"]["imported"].as_array().unwrap().len(), 3);
    assert_eq!(
        conv_imp["result"]["createdWorkspaces"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    collect_until(&mut ws, &mut notifs, 2000, |ns| {
        ns.iter().any(|n| n["method"] == "workspace/listChanged")
    })
    .await;
    assert!(
        notifs
            .iter()
            .any(|n| n["method"] == "workspace/listChanged"),
        "expected workspace/listChanged notification when import creates workspace"
    );

    // Verify `[redacted-provider-token]` scrubbing in imported Codex thread
    let codex_imported_sid = conv_imp["result"]["imported"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["source"] == "codex")
        .unwrap()["threadId"]
        .as_str()
        .unwrap()
        .to_owned();
    let read_imported = ws_call_collecting(
        &mut ws,
        "th-read-imported",
        "thread/read",
        json!({ "threadId": codex_imported_sid, "includeTurns": true }),
        &mut notifs,
    )
    .await;
    let read_str = serde_json::to_string(&read_imported).unwrap();
    assert!(
        !read_str.contains(&long_tok),
        "raw long token must be scrubbed in imported session"
    );

    // Re-importing the exact same conversations is idempotent (`skipped` with `already_imported`)
    let conv_reimp = ws_call_collecting(
        &mut ws,
        "conv-import-2",
        "cowork/conversationImport/import",
        json!({
            "sources": [{ "source": "codex", "path": codex_state_db.to_string_lossy() }],
            "selected": [
                { "source": "codex", "fingerprint": codex_fp }
            ]
        }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        conv_reimp["result"]["imported"].as_array().unwrap().len(),
        0
    );
    assert_eq!(
        conv_reimp["result"]["skipped"][0]["reason"],
        "already_imported"
    );

    // 5. `SkillImprovementService` (`cowork/skills/improvement/{status,run,restore}`)
    let _ = ws_call_collecting(
        &mut ws,
        "si-enable",
        "cowork/session/defaults/apply",
        json!({
            "cwd": cwd_str,
            "config": {
                "skillImprovementEnabled": true
            }
        }),
        &mut notifs,
    )
    .await;

    let th_si = ws_call_collecting(
        &mut ws,
        "th-si",
        "thread/start",
        json!({
            "cwd": cwd_str,
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5"
        }),
        &mut notifs,
    )
    .await;
    let si_tid = th_si["result"]["thread"]["id"].as_str().unwrap().to_owned();

    notifs.clear();
    let _ = ws_call_collecting(
        &mut ws,
        "turn-si",
        "turn/start",
        json!({
            "threadId": si_tid,
            "input": [{ "type": "text", "text": "Please run @codex-helper on this workspace" }]
        }),
        &mut notifs,
    )
    .await;
    collect_until(&mut ws, &mut notifs, 5000, |ns| {
        ns.iter().any(|n| n["method"] == "turn/completed")
    })
    .await;

    let si_status = ws_call_collecting(
        &mut ws,
        "si-status-1",
        "cowork/skills/improvement/status",
        json!({ "cwd": cwd_str }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        si_status["result"]["event"]["type"],
        "skill_improvement_status"
    );
    assert_eq!(si_status["result"]["event"]["enabled"], true);
    assert!(
        !si_status["result"]["event"]["pendingJobs"]
            .as_array()
            .unwrap()
            .is_empty(),
        "expected @codex-helper turn usage to enqueue a pending skill improvement job: {si_status}"
    );

    let si_run = ws_call_collecting(
        &mut ws,
        "si-run-1",
        "cowork/skills/improvement/run",
        json!({ "cwd": cwd_str, "skillName": "codex-helper" }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        si_run["result"]["event"]["type"],
        "skill_improvement_status"
    );

    let si_restore_ok = ws_call_collecting(
        &mut ws,
        "si-restore-ok",
        "cowork/skills/improvement/restore",
        json!({ "cwd": cwd_str, "skillName": "codex-helper" }),
        &mut notifs,
    )
    .await;
    assert_eq!(
        si_restore_ok["result"]["event"]["type"],
        "skill_improvement_status"
    );

    let si_restore_missing = ws_call_collecting(
        &mut ws,
        "si-restore-missing",
        "cowork/skills/improvement/restore",
        json!({ "cwd": cwd_str, "skillName": "codex-helper" }),
        &mut notifs,
    )
    .await;
    assert!(si_restore_missing.get("error").is_some());

    server.shutdown().await;
}

#[tokio::test]
async fn server_redacted_daily_jsonl_logs_and_nonblocking_telemetry_exporters_e2e() {
    let mut iso = IsolatedServerEnv::new("cowork-srv-telemetry-e2e-");

    // Seed a stale >14-day server log file to verify retention cleanup on first write
    let logs_dir = iso.cowork_home.join("logs");
    fs::create_dir_all(&logs_dir).unwrap();
    let stale_log = logs_dir.join("server-2020-01-01.log");
    fs::write(&stale_log, "{\"ts\":\"2020-01-01T00:00:00.000Z\"}\n").unwrap();

    // Local 127.0.0.1:0 mock receivers for Langfuse OTLP, Sentry envelope, and PostHog batch
    let langfuse_hits = Arc::new(AtomicUsize::new(0));
    let sentry_hits = Arc::new(AtomicUsize::new(0));
    let posthog_hits = Arc::new(AtomicUsize::new(0));
    let sentry_payloads: Arc<parking_lot::Mutex<Vec<String>>> =
        Arc::new(parking_lot::Mutex::new(Vec::new()));
    let langfuse_auth: Arc<parking_lot::Mutex<Option<String>>> =
        Arc::new(parking_lot::Mutex::new(None));
    let posthog_payloads: Arc<parking_lot::Mutex<Vec<Value>>> =
        Arc::new(parking_lot::Mutex::new(Vec::new()));

    let lf_hits_ref = Arc::clone(&langfuse_hits);
    let lf_auth_ref = Arc::clone(&langfuse_auth);
    let st_hits_ref = Arc::clone(&sentry_hits);
    let st_body_ref = Arc::clone(&sentry_payloads);
    let ph_hits_ref = Arc::clone(&posthog_hits);
    let ph_body_ref = Arc::clone(&posthog_payloads);

    let mock_app = Router::new()
        .route(
            "/api/public/otel/v1/traces",
            post(move |headers: HeaderMap, _body: Bytes| {
                let lf_hits = Arc::clone(&lf_hits_ref);
                let lf_auth = Arc::clone(&lf_auth_ref);
                async move {
                    lf_hits.fetch_add(1, Ordering::SeqCst);
                    if let Some(h) = headers.get(header::AUTHORIZATION) {
                        *lf_auth.lock() = h.to_str().ok().map(str::to_owned);
                    }
                    StatusCode::OK
                }
            }),
        )
        .route(
            "/api/1/envelope/",
            post(move |_headers: HeaderMap, body: Bytes| {
                let st_hits = Arc::clone(&st_hits_ref);
                let st_body = Arc::clone(&st_body_ref);
                async move {
                    st_hits.fetch_add(1, Ordering::SeqCst);
                    st_body
                        .lock()
                        .push(String::from_utf8_lossy(&body).into_owned());
                    StatusCode::OK
                }
            }),
        )
        .route(
            "/batch/",
            post(move |_headers: HeaderMap, body: Bytes| {
                let ph_hits = Arc::clone(&ph_hits_ref);
                let ph_body = Arc::clone(&ph_body_ref);
                async move {
                    ph_hits.fetch_add(1, Ordering::SeqCst);
                    if let Ok(v) = serde_json::from_slice::<Value>(&body) {
                        ph_body.lock().push(v);
                    }
                    StatusCode::OK
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(|body: Bytes| async move {
                let body_str = String::from_utf8_lossy(&body);
                if body_str.contains("TRIGGER_PROVIDER_ERROR") {
                    Response::builder()
                        .status(StatusCode::UNAUTHORIZED)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            json!({
                                "error": {
                                    "message": "Upstream rejected key sk-proj-supersecret1234567890abcdef and Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload"
                                }
                            })
                            .to_string(),
                        ))
                        .unwrap()
                } else {
                    sse_resp(chat_sse_text("Telemetry turn ok."))
                }
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = listener.local_addr().unwrap().port();
    let _mock_task = tokio::spawn(async move {
        axum::serve(listener, mock_app).await.unwrap();
    });

    // Enable Langfuse + Sentry + PostHog explicitly against local mock server (`COWORK_DISABLE_NETWORK_TELEMETRY` removed)
    iso.env.remove("COWORK_DISABLE_NETWORK_TELEMETRY");
    iso.env
        .insert("COWORK_TELEMETRY_MODE".into(), "local-dev".into());
    iso.env
        .insert("AGENT_OBSERVABILITY_ENABLED".into(), "1".into());
    iso.env
        .insert("LANGFUSE_PUBLIC_KEY".into(), "pk-lf-test".into());
    iso.env
        .insert("LANGFUSE_SECRET_KEY".into(), "sk-lf-test".into());
    iso.env.insert(
        "LANGFUSE_BASE_URL".into(),
        format!("http://127.0.0.1:{mock_port}"),
    );
    iso.env
        .insert("COWORK_CRASH_REPORTS_ENABLED".into(), "1".into());
    iso.env.insert(
        "COWORK_SENTRY_DSN".into(),
        format!("http://sentrypub@127.0.0.1:{mock_port}/1"),
    );
    iso.env
        .insert("COWORK_PRODUCT_ANALYTICS_ENABLED".into(), "1".into());
    iso.env
        .insert("COWORK_POSTHOG_KEY".into(), "phc_test_key".into());
    iso.env.insert(
        "COWORK_PRODUCT_ANALYTICS_INSTALLATION_ID".into(),
        "inst-test-1".into(),
    );
    iso.env.insert(
        "COWORK_POSTHOG_HOST".into(),
        format!("http://127.0.0.1:{mock_port}"),
    );
    iso.env
        .insert("TOGETHER_API_KEY".into(), "together-test-key".into());
    iso.env.insert(
        "TOGETHER_BASE_URL".into(),
        format!("http://127.0.0.1:{mock_port}/v1"),
    );

    let server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws = connect_ready_ws(server.ws_url()).await;
    let mut notifs = Vec::new();
    let cwd_str = iso.workspace.to_string_lossy().into_owned();

    let th = ws_call_collecting(
        &mut ws,
        "th-tel",
        "thread/start",
        json!({
            "cwd": cwd_str,
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5"
        }),
        &mut notifs,
    )
    .await;
    let tid = th["result"]["thread"]["id"].as_str().unwrap().to_owned();

    // Turn 1: Successful turn
    notifs.clear();
    let _ = ws_call_collecting(
        &mut ws,
        "turn-ok",
        "turn/start",
        json!({
            "threadId": tid,
            "input": [{ "type": "text", "text": "Run normal turn" }]
        }),
        &mut notifs,
    )
    .await;
    collect_until(&mut ws, &mut notifs, 5000, |ns| {
        ns.iter().any(|n| n["method"] == "turn/completed")
    })
    .await;

    // Turn 2: Failing turn leaking `sk-proj-supersecret...` & `Bearer ...` in error message
    notifs.clear();
    let _ = ws_call_collecting(
        &mut ws,
        "turn-err",
        "turn/start",
        json!({
            "threadId": tid,
            "input": [{ "type": "text", "text": "TRIGGER_PROVIDER_ERROR" }]
        }),
        &mut notifs,
    )
    .await;
    collect_until(&mut ws, &mut notifs, 5000, |ns| {
        ns.iter().any(|n| n["method"] == "turn/completed")
    })
    .await;

    // Shutdown flushes both daily JSONL file log and non-blocking HTTP telemetry queue
    server.shutdown().await;

    // Verify daily JSONL file log exists, stale log was swept, and secrets are redacted!
    assert!(
        !stale_log.exists(),
        "stale >14-day server-2020-01-01.log must be swept"
    );
    let log_files: Vec<PathBuf> = fs::read_dir(&logs_dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|d| d.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|n| n.starts_with("server-") && n.ends_with(".log"))
        })
        .collect();
    assert_eq!(
        log_files.len(),
        1,
        "expected 1 active daily server-YYYY-MM-DD.log"
    );
    let log_contents = fs::read_to_string(&log_files[0]).unwrap();
    assert!(
        !log_contents.contains("sk-proj-supersecret1234567890abcdef"),
        "raw OpenAI secret must NEVER be written to daily JSONL log: {log_contents}"
    );
    assert!(
        !log_contents.contains("eyJhbGciOiJIUzI1NiJ9.secretpayload"),
        "raw Bearer token must NEVER be written to daily JSONL log: {log_contents}"
    );
    assert!(
        log_contents.contains("[redacted-secret]") && log_contents.contains("[redacted]"),
        "expected [redacted-secret] and [redacted] markers in daily JSONL log: {log_contents}"
    );
    for line in log_contents.lines() {
        let parsed: Value = serde_json::from_str(line).expect("valid JSONL line");
        assert!(parsed.get("ts").is_some());
    }

    // Verify all 3 non-blocking telemetry exporters flushed to local mock receivers with redacted payloads!
    assert!(
        langfuse_hits.load(Ordering::SeqCst) >= 1,
        "expected Langfuse OTLP trace POST"
    );
    assert!(
        langfuse_auth
            .lock()
            .as_deref()
            .is_some_and(|h| h.starts_with("Basic ")),
        "expected Basic auth header on Langfuse OTLP export"
    );
    assert!(
        sentry_hits.load(Ordering::SeqCst) >= 1,
        "expected Sentry envelope POST"
    );
    let sentry_joined = sentry_payloads.lock().join("\n");
    assert!(
        !sentry_joined.contains("sk-proj-supersecret1234567890abcdef"),
        "Sentry envelope must redact credentials: {sentry_joined}"
    );
    assert!(
        posthog_hits.load(Ordering::SeqCst) >= 2,
        "expected PostHog batch POSTs"
    );
    for ph in posthog_payloads.lock().iter() {
        assert_eq!(
            ph["batch"][0]["properties"]["$process_person_profile"],
            false
        );
    }

    // Now verify `COWORK_DISABLE_NETWORK_TELEMETRY=1` keeps all exporters 100% inert even when URLs/keys are configured!
    let lf_before = langfuse_hits.load(Ordering::SeqCst);
    let st_before = sentry_hits.load(Ordering::SeqCst);
    let ph_before = posthog_hits.load(Ordering::SeqCst);

    iso.env
        .insert("COWORK_DISABLE_NETWORK_TELEMETRY".into(), "1".into());
    let inert_server = start_server(iso.server_options(true)).await.unwrap();
    let mut ws2 = connect_ready_ws(inert_server.ws_url()).await;
    let mut notifs2 = Vec::new();
    let th2 = ws_call_collecting(
        &mut ws2,
        "th-inert",
        "thread/start",
        json!({
            "cwd": cwd_str,
            "provider": "together",
            "model": "moonshotai/Kimi-K2.5"
        }),
        &mut notifs2,
    )
    .await;
    let tid2 = th2["result"]["thread"]["id"].as_str().unwrap().to_owned();
    let _ = ws_call_collecting(
        &mut ws2,
        "turn-inert-err",
        "turn/start",
        json!({
            "threadId": tid2,
            "input": [{ "type": "text", "text": "TRIGGER_PROVIDER_ERROR" }]
        }),
        &mut notifs2,
    )
    .await;
    collect_until(&mut ws2, &mut notifs2, 5000, |ns| {
        ns.iter().any(|n| n["method"] == "turn/completed")
    })
    .await;
    inert_server.shutdown().await;

    assert_eq!(langfuse_hits.load(Ordering::SeqCst), lf_before);
    assert_eq!(sentry_hits.load(Ordering::SeqCst), st_before);
    assert_eq!(posthog_hits.load(Ordering::SeqCst), ph_before);
}
