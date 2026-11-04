//! Regression: `read` on a directory suggests a `glob` call. The suggested arguments must be
//! valid for `glob`'s schema (`cwd`, not `path`, with `additionalProperties: false`), so a model
//! that follows the hint lists the directory instead of failing validation.

use std::fs;

use cowork_config::ProviderName;
use cowork_tools::{
    ToolExecutionContext, ToolOutput, create_builtin_tools, normalize_and_validate_args,
};
use serde_json::{Map, Value, json};

#[tokio::test]
async fn read_directory_hint_args_validate_against_glob_schema() {
    let tmp = tempfile::tempdir().unwrap();
    let home = fs::canonicalize(tmp.path()).unwrap().join("home");
    let ws = fs::canonicalize(tmp.path()).unwrap().join("ws");
    fs::create_dir_all(ws.join("src")).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(ws.join("src").join("lib.rs"), "fn main() {}\n").unwrap();
    let ctx =
        ToolExecutionContext::new_for_tests(home, ws.clone(), ProviderName::Openai, "gpt-5.4");
    let tools = create_builtin_tools(&ctx);

    let out = tools["read"]
        .execute(
            serde_json::from_value(json!({ "filePath": "src" })).unwrap(),
            &ctx,
        )
        .await
        .unwrap();
    let ToolOutput::Text(hint) = out else {
        panic!("expected text: {out:?}");
    };
    assert!(
        hint.starts_with("Cannot read src because it is a directory."),
        "{hint}"
    );

    // The hint embeds the glob arguments as a JSON object.
    let start = hint.find("call glob with ").expect("glob suggestion") + "call glob with ".len();
    let mut stream = serde_json::Deserializer::from_str(&hint[start..]).into_iter::<Value>();
    let suggested: Map<String, Value> = match stream.next() {
        Some(Ok(Value::Object(map))) => map,
        other => panic!("no JSON args in hint: {other:?} / {hint}"),
    };
    assert_eq!(suggested.get("cwd"), Some(&json!("src")), "{hint}");

    let glob = &tools["glob"];
    normalize_and_validate_args(&glob.input_schema(), &suggested)
        .unwrap_or_else(|err| panic!("hint args rejected by glob: {err:?} / {hint}"));
    let listed = glob.execute(suggested, &ctx).await.unwrap();
    assert!(
        listed.as_text().unwrap_or_default().contains("lib.rs"),
        "{listed:?}"
    );
}
