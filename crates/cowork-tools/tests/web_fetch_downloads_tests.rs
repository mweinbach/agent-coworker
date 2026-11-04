//! Regression: `webFetch` must save binary documents/images byte-for-byte under the workspace
//! `Downloads/` folder (write-permission checked, 50MB cap enforced while streaming) instead of
//! decoding them into lossy UTF-8 mojibake.

use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::response::Response;
use axum::routing::get;
use cowork_config::ProviderName;
use cowork_tools::web::MAX_WEBFETCH_DOWNLOAD_BYTES;
use cowork_tools::{ToolExecutionContext, create_builtin_tools};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

const PDF_BYTES: &[u8] = b"%PDF-1.7\n\xff\xfe\x00\x01\x80\x81binary\x00tail";
const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\xde\xad\xbe\xef";

struct Dirs {
    base: PathBuf,
    home: PathBuf,
    ws: PathBuf,
}

impl Dirs {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("cowork-webfetch-dl-{}", Uuid::new_v4()));
        fs::create_dir_all(base.join("home")).unwrap();
        fs::create_dir_all(base.join("workspace")).unwrap();
        let base = fs::canonicalize(&base).unwrap();
        Self {
            home: base.join("home"),
            ws: base.join("workspace"),
            base,
        }
    }
}

impl Drop for Dirs {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn binary(content_type: &'static str, body: &'static [u8]) -> Response {
    Response::builder()
        .header("content-type", content_type)
        .body(Body::from(body))
        .unwrap()
}

async fn spawn_mock() -> SocketAddr {
    let app = Router::new()
        .route(
            "/files/report.pdf",
            get(|| async { binary("application/pdf", PDF_BYTES) }),
        )
        .route(
            "/download",
            get(|| async {
                Response::builder()
                    .header("content-type", "application/octet-stream")
                    .header("content-disposition", "attachment; filename=\"chart.png\"")
                    .body(Body::from(PNG_BYTES))
                    .unwrap()
            }),
        )
        .route(
            "/archive.zip",
            get(|| async { binary("application/zip", b"PK\x03\x04\xff") }),
        )
        .route(
            "/huge.pdf",
            get(|| async {
                // Chunked (no content-length) so the cap must be enforced while streaming.
                let chunk = vec![0u8; 1024 * 1024];
                let chunks = (MAX_WEBFETCH_DOWNLOAD_BYTES / chunk.len()) + 2;
                let stream = futures::stream::iter(
                    (0..chunks).map(move |_| Ok::<_, std::io::Error>(chunk.clone())),
                );
                Response::builder()
                    .header("content-type", "application/pdf")
                    .body(Body::from_stream(stream))
                    .unwrap()
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

fn pinned_ctx(dirs: &Dirs, mock: SocketAddr) -> ToolExecutionContext {
    let mut ctx = ToolExecutionContext::new_for_tests(
        dirs.home.clone(),
        dirs.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.dns_override_for_tests = Some(Arc::new(move |host: &str, port: u16| {
        if host == "files.example.test" {
            Ok((
                vec!["93.184.216.34".parse().unwrap()],
                Some(SocketAddr::new(mock.ip(), port)),
            ))
        } else {
            Err(format!("unexpected host lookup: {host}"))
        }
    }));
    ctx
}

async fn fetch(ctx: &ToolExecutionContext, mock: SocketAddr, path: &str) -> Result<String, String> {
    let args: Map<String, Value> = serde_json::from_value(json!({
        "url": format!("http://files.example.test:{}{path}", mock.port())
    }))
    .unwrap();
    create_builtin_tools(ctx)
        .get("webFetch")
        .expect("webFetch")
        .execute(args, ctx)
        .await
        .map(|out| out.as_text().unwrap_or_default())
        .map_err(|e| e.to_string())
}

fn downloads(ws: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(ws.join("Downloads"))
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn web_fetch_saves_binary_downloads_exactly_and_enforces_permissions_and_size_cap() {
    let dirs = Dirs::new();
    let mock = spawn_mock().await;
    let ctx = pinned_ctx(&dirs, mock);

    // PDF by content-type: exact bytes saved, path returned, no mojibake inline body.
    let out = fetch(&ctx, mock, "/files/report.pdf").await.unwrap();
    let saved = dirs.ws.join("Downloads/report.pdf");
    assert!(out.starts_with("File downloaded "), "{out}");
    assert!(out.contains(saved.to_str().unwrap()), "{out}");
    assert!(
        !out.contains('\u{FFFD}'),
        "binary body leaked inline: {out}"
    );
    assert_eq!(fs::read(&saved).unwrap(), PDF_BYTES);

    // Same name again never overwrites: suffixed filename.
    let out2 = fetch(&ctx, mock, "/files/report.pdf").await.unwrap();
    assert!(out2.contains("report-2.pdf"), "{out2}");
    assert_eq!(
        fs::read(dirs.ws.join("Downloads/report-2.pdf")).unwrap(),
        PDF_BYTES
    );

    // octet-stream + image content-disposition name: saved as image.
    let out3 = fetch(&ctx, mock, "/download").await.unwrap();
    assert!(out3.contains("chart.png"), "{out3}");
    assert_eq!(
        fs::read(dirs.ws.join("Downloads/chart.png")).unwrap(),
        PNG_BYTES
    );

    // Unsupported binary type is rejected instead of decoded.
    let err = fetch(&ctx, mock, "/archive.zip").await.unwrap_err();
    assert!(err.contains("Blocked non-text content type"), "{err}");

    // Size cap enforced while streaming a chunked body; nothing is written.
    let err = fetch(&ctx, mock, "/huge.pdf").await.unwrap_err();
    assert!(err.contains("exceeded 50MB limit"), "{err}");
    assert_eq!(
        downloads(&dirs.ws),
        vec!["chart.png", "report-2.pdf", "report.pdf"]
    );

    // Read-only sessions cannot download.
    let mut ro_ctx = ctx.clone();
    ro_ctx.read_only_role = true;
    let err = fetch(&ro_ctx, mock, "/files/report.pdf").await.unwrap_err();
    assert!(err.contains("read-only"), "{err}");
    assert_eq!(downloads(&dirs.ws).len(), 3);
}
