//! Regression: `webSearch` (Exa and Parallel) and `webFetch` race their HTTP waits (connect /
//! response headers / JSON body / streamed body) against turn cancellation, like TS
//! `raceWithAbort(..., ctx.abortSignal)`, so Stop returns promptly instead of waiting out the
//! request timeout against a stalled server.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cowork_config::ProviderName;
use cowork_tools::{ToolExecutionContext, create_builtin_tools};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

/// Accepts connections and never answers (or, with `partial_body`, sends headers and part of a
/// body, then stalls). Sockets are kept open until the test ends.
async fn stalled_server(partial_body: bool) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((mut sock, _)) = listener.accept().await {
            if partial_body {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 1000000\r\n\r\npartial",
                    )
                    .await;
            }
            held.push(sock);
        }
    });
    addr
}

fn ctx_with_cancel(dir: &tempfile::TempDir) -> (ToolExecutionContext, watch::Sender<bool>) {
    let mut ctx = ToolExecutionContext::new_for_tests(
        dir.path().join("home"),
        dir.path().join("ws"),
        ProviderName::Openai,
        "gpt-5.4",
    );
    let (tx, rx) = watch::channel(false);
    ctx.cancel_rx = Some(rx);
    (ctx, tx)
}

async fn run_cancelled(
    ctx: ToolExecutionContext,
    cancel: watch::Sender<bool>,
    tool: &str,
    args: Value,
) {
    let tool_name = tool.to_owned();
    let task = tokio::spawn(async move {
        let args: Map<String, Value> = serde_json::from_value(args).unwrap();
        create_builtin_tools(&ctx)[&tool_name]
            .execute(args, &ctx)
            .await
            .map(|out| out.to_json_value())
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !task.is_finished(),
        "{tool} finished before the stall was cancelled"
    );
    let started = Instant::now();
    cancel.send(true).unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap_or_else(|_| panic!("{tool} kept waiting on a stalled server after Stop"))
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    let err = res.expect_err("cancelled call must fail");
    assert!(
        err.to_string().contains(&format!("{tool} aborted")),
        "{err}"
    );
}

#[tokio::test]
async fn web_search_exa_and_parallel_stop_on_cancel() {
    let addr = stalled_server(false).await;
    for (key_var, key, url_var, extra) in [
        ("EXA_API_KEY", "exa_key", "COWORK_EXA_SEARCH_URL", None),
        (
            "PARALLEL_API_KEY",
            "parallel_key",
            "COWORK_PARALLEL_SEARCH_URL",
            Some(json!({ "webSearchBackend": "parallel" })),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, cancel) = ctx_with_cancel(&dir);
        ctx.env.insert(key_var.to_owned(), key.to_owned());
        ctx.env
            .insert(url_var.to_owned(), format!("http://{addr}/search"));
        if let Some(codex) = extra {
            ctx.provider_options.insert("codex-cli".to_owned(), codex);
        }
        run_cancelled(ctx, cancel, "webSearch", json!({ "query": "stalled" })).await;
    }
}

#[tokio::test]
async fn web_fetch_stops_on_cancel_while_waiting_for_headers_or_body() {
    for partial_body in [false, true] {
        let addr = stalled_server(partial_body).await;
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, cancel) = ctx_with_cancel(&dir);
        ctx.dns_override_for_tests = Some(Arc::new(move |_host: &str, port: u16| {
            Ok((
                vec!["93.184.216.34".parse().unwrap()],
                Some(SocketAddr::new(addr.ip(), port)),
            ))
        }));
        run_cancelled(
            ctx,
            cancel,
            "webFetch",
            json!({ "url": format!("http://stalled.example.test:{}/page", addr.port()) }),
        )
        .await;
    }
}
