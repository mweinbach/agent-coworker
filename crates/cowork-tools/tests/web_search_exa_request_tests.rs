//! Outgoing-request parity for `webSearch` (`test/tools/tools.webSearch.test.ts`): Exa search
//! `type`/`category` controls (including the `"news article"` alias), Exa defaults, and the
//! Parallel request body, asserted against a local mock search endpoint.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::http::HeaderMap;
use axum::routing::post;
use cowork_config::ProviderName;
use cowork_tools::{ToolError, ToolExecutionContext, create_builtin_tools};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

struct MockSearch {
    addr: SocketAddr,
    exa_bodies: Arc<Mutex<Vec<Value>>>,
    parallel_bodies: Arc<Mutex<Vec<Value>>>,
    handle: JoinHandle<()>,
}

impl Drop for MockSearch {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn spawn_mock_search() -> MockSearch {
    let exa_bodies = Arc::new(Mutex::new(Vec::new()));
    let parallel_bodies = Arc::new(Mutex::new(Vec::new()));
    let exa_c = Arc::clone(&exa_bodies);
    let par_c = Arc::clone(&parallel_bodies);
    let app = Router::new()
        .route(
            "/exa/search",
            post(move |headers: HeaderMap, body: String| {
                let bodies = Arc::clone(&exa_c);
                async move {
                    assert_eq!(headers.get("x-api-key").unwrap(), "exa_test_key");
                    bodies
                        .lock()
                        .push(serde_json::from_str::<Value>(&body).unwrap());
                    axum::Json(json!({
                        "results": [
                            {
                                "title": "Exa result",
                                "url": "https://example.com/exa",
                                "highlights": ["Exa highlight"]
                            }
                        ]
                    }))
                }
            }),
        )
        .route(
            "/parallel/search",
            post(move |headers: HeaderMap, body: String| {
                let bodies = Arc::clone(&par_c);
                async move {
                    assert_eq!(headers.get("x-api-key").unwrap(), "parallel_test_key");
                    bodies
                        .lock()
                        .push(serde_json::from_str::<Value>(&body).unwrap());
                    axum::Json(json!({
                        "results": [
                            {
                                "title": "Parallel result",
                                "url": "https://example.com/parallel",
                                "publish_date": "2026-06-01",
                                "excerpts": ["Parallel excerpt"]
                            }
                        ]
                    }))
                }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    MockSearch {
        addr,
        exa_bodies,
        parallel_bodies,
        handle,
    }
}

fn search_ctx(
    home: &tempfile::TempDir,
    ws: &tempfile::TempDir,
    mock: &MockSearch,
) -> ToolExecutionContext {
    let mut ctx = ToolExecutionContext::new_for_tests(
        home.path().to_path_buf(),
        ws.path().to_path_buf(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    ctx.env
        .insert("EXA_API_KEY".to_owned(), "exa_test_key".to_owned());
    ctx.env.insert(
        "COWORK_EXA_SEARCH_URL".to_owned(),
        format!("http://{}/exa/search", mock.addr),
    );
    ctx.env.insert(
        "PARALLEL_API_KEY".to_owned(),
        "parallel_test_key".to_owned(),
    );
    ctx.env.insert(
        "COWORK_PARALLEL_SEARCH_URL".to_owned(),
        format!("http://{}/parallel/search", mock.addr),
    );
    ctx
}

async fn run_web_search(ctx: &ToolExecutionContext, args: Value) -> Result<Value, ToolError> {
    let tools = create_builtin_tools(ctx);
    let tool = tools.get("webSearch").expect("webSearch registered");
    let args: Map<String, Value> = serde_json::from_value(args).unwrap();
    tool.execute(args, ctx).await.map(|out| out.to_json_value())
}

#[tokio::test]
async fn web_search_schema_advertises_exa_type_and_category_controls() {
    let home = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let ctx = ToolExecutionContext::new_for_tests(
        home.path().to_path_buf(),
        ws.path().to_path_buf(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    let tools = create_builtin_tools(&ctx);
    let tool = tools.get("webSearch").expect("webSearch registered");
    assert!(tool.description().contains("type/category"));

    let schema = tool.input_schema();
    let props = &schema["properties"];
    assert_eq!(
        props["type"]["enum"],
        json!([
            "neural",
            "fast",
            "auto",
            "deep",
            "deep-reasoning",
            "instant"
        ])
    );
    assert_eq!(
        props["type"]["description"],
        json!(
            "Optional Exa-only search type for more deliberate retrieval. Ignored by other web search providers."
        )
    );
    assert_eq!(
        props["category"]["enum"],
        json!([
            "company",
            "research paper",
            "news",
            "tweet",
            "personal site",
            "financial report",
            "people",
            "news article"
        ])
    );
    assert_eq!(
        props["category"]["description"],
        json!(
            "Optional Exa-only result category for focused search. Ignored by other web search providers."
        )
    );
}

#[tokio::test]
async fn exa_web_search_forwards_deep_type_and_company_category() {
    let home = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let mock = spawn_mock_search().await;
    let ctx = search_ctx(&home, &ws, &mock);

    let out = run_web_search(
        &ctx,
        json!({
            "query": "latest nvidia news",
            "maxResults": 5,
            "type": "deep",
            "category": "company"
        }),
    )
    .await
    .unwrap();
    assert_eq!(out["provider"], json!("exa"));
    assert_eq!(out["count"], json!(1));

    let bodies = mock.exa_bodies.lock().clone();
    assert_eq!(bodies.len(), 1);
    assert_eq!(
        bodies[0],
        json!({
            "query": "latest nvidia news",
            "numResults": 5,
            "type": "deep",
            "category": "company",
            "contents": { "highlights": { "maxCharacters": 2500 } }
        })
    );
    assert!(mock.parallel_bodies.lock().is_empty());
}

#[tokio::test]
async fn exa_web_search_normalizes_news_article_category_alias() {
    let home = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let mock = spawn_mock_search().await;
    let ctx = search_ctx(&home, &ws, &mock);

    run_web_search(
        &ctx,
        json!({ "query": "latest nvidia news", "category": "news article" }),
    )
    .await
    .unwrap();

    let bodies = mock.exa_bodies.lock().clone();
    assert_eq!(bodies.len(), 1);
    assert_eq!(
        bodies[0],
        json!({
            "query": "latest nvidia news",
            "numResults": 10,
            "type": "auto",
            "category": "news",
            "contents": { "highlights": { "maxCharacters": 2500 } }
        })
    );
}

#[tokio::test]
async fn exa_web_search_alias_query_defaults_type_auto_and_omits_category() {
    let home = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let mock = spawn_mock_search().await;
    let ctx = search_ctx(&home, &ws, &mock);

    run_web_search(
        &ctx,
        json!({ "searchQuery": "  latest   sdk\tchangelog ", "maxResults": 3 }),
    )
    .await
    .unwrap();

    let bodies = mock.exa_bodies.lock().clone();
    assert_eq!(bodies.len(), 1);
    let body = &bodies[0];
    assert_eq!(body["query"], json!("latest sdk changelog"));
    assert_eq!(body["numResults"], json!(3));
    assert_eq!(body["type"], json!("auto"));
    assert_eq!(body["contents"]["highlights"]["maxCharacters"], json!(2500));
    assert!(body.get("category").is_none());
}

#[tokio::test]
async fn web_search_rejects_unknown_exa_type_and_category() {
    let home = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let mock = spawn_mock_search().await;
    let ctx = search_ctx(&home, &ws, &mock);

    for args in [
        json!({ "query": "x", "type": "keyword" }),
        json!({ "query": "x", "category": "blog" }),
    ] {
        let err = run_web_search(&ctx, args).await.unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidArguments(_)),
            "unexpected error: {err:?}"
        );
    }
    assert!(mock.exa_bodies.lock().is_empty());
}

#[tokio::test]
async fn parallel_web_search_ignores_exa_controls_and_sends_ts_request_body() {
    let home = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let mock = spawn_mock_search().await;
    let mut ctx = search_ctx(&home, &ws, &mock);
    ctx.provider_options.insert(
        "codex-cli".to_owned(),
        json!({ "webSearchBackend": "parallel" }),
    );

    let out = run_web_search(
        &ctx,
        json!({
            "query": " latest parallel search updates ",
            "maxResults": 2,
            "type": "deep",
            "category": "company"
        }),
    )
    .await
    .unwrap();
    assert_eq!(out["provider"], json!("parallel"));
    assert_eq!(out["count"], json!(1));

    let bodies = mock.parallel_bodies.lock().clone();
    assert_eq!(bodies.len(), 1);
    assert_eq!(
        bodies[0],
        json!({
            "objective": "latest parallel search updates",
            "search_queries": ["latest parallel search updates"],
            "mode": "agentic",
            "max_results": 2,
            "excerpts": { "max_chars_per_result": 2500, "max_chars_total": 5000 }
        })
    );
    assert!(mock.exa_bodies.lock().is_empty());
}
