//! Regression: `webFetch` HTML conversion must prefer `<main>`, then `<article>`, over `<body>`
//! (`extractLikelyContentFragment` parity). A combined CSS selector list matches in document
//! order, so `<body>` always won and long intro/sidebar text crowded out the real content once
//! `maxChars` truncation applied.

use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::routing::get;
use cowork_config::ProviderName;
use cowork_tools::{ToolExecutionContext, create_builtin_tools, html_to_clean_markdown};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use uuid::Uuid;

const MAIN_MARKER: &str = "MAIN-CONTENT-MARKER";
const ARTICLE_MARKER: &str = "ARTICLE-CONTENT-MARKER";
const SIDEBAR_MARKER: &str = "SIDEBAR-NOISE";

fn sidebar_text(chars: usize) -> String {
    let unit = format!("{SIDEBAR_MARKER} intro paragraph text. ");
    unit.repeat(chars / unit.len() + 1)
}

fn page_with_long_intro_before_main() -> String {
    format!(
        "<!doctype html><html><head><title>T</title></head><body>\
         <div class=\"sidebar\"><p>{}</p></div>\
         <main><h1>Requested Topic</h1><p>{MAIN_MARKER} the body the user asked for.</p></main>\
         </body></html>",
        sidebar_text(5_000)
    )
}

#[test]
fn prefers_main_over_long_surrounding_body_text() {
    let md = html_to_clean_markdown(&page_with_long_intro_before_main());
    assert!(md.contains(MAIN_MARKER), "main content missing: {md}");
    assert!(md.contains("# Requested Topic"), "heading missing: {md}");
    assert!(!md.contains(SIDEBAR_MARKER), "sidebar leaked: {md}");
}

#[test]
fn main_wins_over_article_even_when_article_comes_first() {
    let html = format!(
        "<html><body><article><p>{ARTICLE_MARKER}</p></article>\
         <main><p>{MAIN_MARKER}</p></main></body></html>"
    );
    let md = html_to_clean_markdown(&html);
    assert!(md.contains(MAIN_MARKER), "{md}");
    assert!(!md.contains(ARTICLE_MARKER), "{md}");
}

#[test]
fn first_main_is_used_when_several_exist() {
    let html =
        "<html><body><main><p>FIRST-MAIN</p></main><main><p>SECOND-MAIN</p></main></body></html>";
    let md = html_to_clean_markdown(html);
    assert!(md.contains("FIRST-MAIN"), "{md}");
    assert!(!md.contains("SECOND-MAIN"), "{md}");
}

#[test]
fn article_alone_is_selected_over_body() {
    let html = format!(
        "<html><body><div><p>{}</p></div>\
         <article><h2>Post</h2><p>{ARTICLE_MARKER}</p></article></body></html>",
        sidebar_text(2_000)
    );
    let md = html_to_clean_markdown(&html);
    assert!(md.contains(ARTICLE_MARKER), "{md}");
    assert!(!md.contains(SIDEBAR_MARKER), "{md}");
}

#[test]
fn falls_back_to_body_without_main_or_article() {
    let html = "<html><head><title>HEAD-TITLE</title><style>.x{}</style></head>\
                <body><div><p>BODY-ONE</p></div><section><p>BODY-TWO</p></section></body></html>";
    let md = html_to_clean_markdown(html);
    assert!(md.contains("BODY-ONE"), "{md}");
    assert!(md.contains("BODY-TWO"), "{md}");
    assert!(!md.contains("HEAD-TITLE"), "{md}");
}

#[test]
fn fragment_without_body_is_converted_whole() {
    let md = html_to_clean_markdown("<p>FRAGMENT-ONLY</p><script>evil()</script>");
    assert!(md.contains("FRAGMENT-ONLY"), "{md}");
    assert!(!md.contains("evil"), "{md}");
}

#[tokio::test]
async fn web_fetch_returns_main_content_when_intro_exceeds_max_chars() {
    let base = std::env::temp_dir().join(format!("cowork-webfetch-main-{}", Uuid::new_v4()));
    let home: PathBuf = base.join("home");
    let ws: PathBuf = base.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();

    let app = Router::new().route(
        "/page",
        get(|| async {
            (
                [("content-type", "text/html; charset=utf-8")],
                page_with_long_intro_before_main(),
            )
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock: SocketAddr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let mut ctx = ToolExecutionContext::new_for_tests(home, ws, ProviderName::Openai, "gpt-5.4");
    ctx.dns_override_for_tests = Some(Arc::new(move |host: &str, port: u16| {
        if host == "docs.example.test" {
            Ok((
                vec!["93.184.216.34".parse().unwrap()],
                Some(SocketAddr::new(mock.ip(), port)),
            ))
        } else {
            Err(format!("unexpected host lookup: {host}"))
        }
    }));

    let args: Map<String, Value> = serde_json::from_value(json!({
        "url": format!("http://docs.example.test:{}/page", mock.port()),
        "maxChars": 500
    }))
    .unwrap();
    let out = create_builtin_tools(&ctx)
        .get("webFetch")
        .expect("webFetch")
        .execute(args, &ctx)
        .await
        .expect("webFetch succeeds")
        .as_text()
        .unwrap_or_default();

    server.abort();
    let _ = fs::remove_dir_all(&base);

    assert!(
        out.contains(MAIN_MARKER),
        "main content truncated away: {out}"
    );
    assert!(!out.contains(SIDEBAR_MARKER), "sidebar leaked: {out}");
}

#[test]
fn system_proxy_cannot_replace_the_validated_destination() {
    // Set proxy variables only in the child. Port zero cannot accept a connection; the
    // pinned fetch to the fixture's loopback listener must still return its article.
    let name = "web_fetch_returns_main_content_when_intro_exceeds_max_chars";
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name])
        .env("HTTP_PROXY", "http://127.0.0.1:0")
        .env("NO_PROXY", "")
        .env_remove("no_proxy")
        .env_remove("REQUEST_METHOD")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&child.stdout);
    assert!(
        child.status.success() && stdout.contains("1 passed"),
        "{stdout}"
    );
}
