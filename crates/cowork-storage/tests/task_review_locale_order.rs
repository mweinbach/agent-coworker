//! The TypeScript server ordered review-material arrays with
//! `stableStringify(key).localeCompare(...)` (ICU root collation), and the array order feeds the
//! persisted material fingerprints. A bytewise sort in the Rust port would reorder mixed-case
//! (or accented, or punctuated) entries, make unchanged work look changed, and reject passing
//! reviews as stale. Expected orders and the golden fingerprint below were produced by running
//! `origin/main`'s `src/server/tasks/taskReviewPolicy.ts` under Bun 1.4 (ICU 78.3).

use std::cmp::Ordering;

use cowork_storage::task_review_policy::js_locale_compare;
use cowork_storage::{
    TaskRecord, build_task_review_material_snapshot, fingerprint_task_review_material,
};
use serde_json::{Value, json};

fn js_sorted(items: &[&str]) -> Vec<String> {
    // Reverse first so the result cannot just echo the input order.
    let mut sorted: Vec<String> = items.iter().rev().map(|s| (*s).to_owned()).collect();
    sorted.sort_by(|a, b| js_locale_compare(a, b));
    sorted
}

#[test]
fn locale_compare_pairs_match_javascript() {
    for (a, b, expected) in [
        ("alpha", "Beta", Ordering::Less),
        ("Beta", "alpha", Ordering::Greater),
        ("a", "A", Ordering::Less),
        ("b", "A", Ordering::Greater),
        ("B", "a", Ordering::Greater),
        ("10", "9", Ordering::Less),
        ("9", "a", Ordering::Less),
        ("Z", "a1", Ordering::Greater),
        ("e", "é", Ordering::Less),
        ("é", "f", Ordering::Less),
        ("é", "ef", Ordering::Less),
        ("é", "e\u{301}", Ordering::Equal),
        ("a_b", "a-b", Ordering::Less),
        ("a-b", "a,b", Ordering::Less),
        ("\"a\"", "\"a-b\"", Ordering::Greater),
        ("", "a", Ordering::Less),
        ("same", "same", Ordering::Equal),
    ] {
        assert_eq!(js_locale_compare(a, b), expected, "{a:?} vs {b:?}");
    }
}

#[test]
fn locale_compare_orderings_match_javascript() {
    let cases: &[(&[&str], &[&str])] = &[
        (
            &["Beta", "alpha", "b", "A", "a", "B", "aB", "Ab", "ab", "AB"],
            &["a", "A", "ab", "aB", "Ab", "AB", "alpha", "b", "B", "Beta"],
        ),
        (
            &["b2", "10", "9", "a", "A1", "1a", "_1", "-1", "$1", " 1"],
            &[" 1", "_1", "-1", "$1", "10", "1a", "9", "a", "A1", "b2"],
        ),
        (
            &[
                "f",
                "é",
                "e",
                "E",
                "É",
                "è",
                "ê",
                "ë",
                "ef",
                "éa",
                "ea",
                "e\u{301}b",
                "ez",
            ],
            &[
                "e",
                "E",
                "é",
                "É",
                "è",
                "ê",
                "ë",
                "ea",
                "éa",
                "e\u{301}b",
                "ef",
                "ez",
                "f",
            ],
        ),
        (
            &[
                "a-b",
                "a_b",
                "a b",
                "a,b",
                "a.b",
                "a'b",
                "a\u{2019}b",
                "a\"b",
                "a\u{201C}b",
                "a\u{2014}b",
                "a\u{2013}b",
                "a\u{2026}b",
                "a...b",
                "a/b",
                "a(b",
                "a@b",
                "a#b",
                "a+b",
                "a=b",
                "ab",
            ],
            &[
                "a b",
                "a_b",
                "a-b",
                "a\u{2013}b",
                "a\u{2014}b",
                "a,b",
                "a...b",
                "a\u{2026}b",
                "a.b",
                "a'b",
                "a\u{2019}b",
                "a\"b",
                "a\u{201C}b",
                "a(b",
                "a@b",
                "a/b",
                "a#b",
                "a+b",
                "a=b",
                "ab",
            ],
        ),
        (
            &[
                r#"["requirement","alpha","permanent","user"]"#,
                r#"["requirement","Beta","permanent","user"]"#,
                r#"["requirement","alpha beta","permanent","user"]"#,
                r#"["requirement","alpha-beta","permanent","user"]"#,
                r#"["constraint","Zed","permanent","user"]"#,
            ],
            &[
                r#"["constraint","Zed","permanent","user"]"#,
                r#"["requirement","alpha beta","permanent","user"]"#,
                r#"["requirement","alpha-beta","permanent","user"]"#,
                r#"["requirement","alpha","permanent","user"]"#,
                r#"["requirement","Beta","permanent","user"]"#,
            ],
        ),
        (
            &[
                "Straße",
                "strasse",
                "Ærø",
                "aero",
                "ångström",
                "angstrom",
                "Łódź",
                "lodz",
                "\u{FB01}le",
                "file",
                "Ελλάδα",
                "Москва",
                "ёлка",
                "елка",
                "中文",
                "あ",
                "ア",
                "가",
            ],
            &[
                "aero",
                "Ærø",
                "angstrom",
                "ångström",
                "file",
                "\u{FB01}le",
                "lodz",
                "Łódź",
                "strasse",
                "Straße",
                "Ελλάδα",
                "елка",
                "ёлка",
                "Москва",
                "가",
                "あ",
                "ア",
                "中文",
            ],
        ),
        (
            &[
                "€5", "$5", "£5", "5", "©", "→", "✓", "😀", "≤", "×", "°C", "℃", "™", "TM", "№1",
                "No1", "½", "1/2",
            ],
            &[
                "°C", "℃", "©", "→", "×", "≤", "✓", "😀", "$5", "£5", "€5", "1/2", "½", "5", "No1",
                "№1", "TM", "™",
            ],
        ),
    ];
    for (input, expected) in cases {
        assert_eq!(js_sorted(input), *expected, "sorting {input:?}");
    }
}

const T: &str = "2025-01-01T00:00:00.000Z";

fn requirement(
    id: &str,
    kind: &str,
    text: &str,
    source: &str,
    permanence: &str,
    status: &str,
) -> Value {
    json!({ "id": id, "kind": kind, "text": text, "source": source, "permanence": permanence,
            "status": status, "createdAt": T, "supersedes": null })
}

fn work_item(id: &str, position: i64, depends_on: &[&str], expected_outputs: &[&str]) -> Value {
    json!({ "id": id, "taskId": "task-1", "title": format!("Item {id}"), "description": "",
            "status": "queued", "dependsOn": depends_on, "assignedThreadId": null,
            "claimedByThreadId": null, "expectedOutputs": expected_outputs,
            "completionEvidence": null, "position": position, "createdAt": T, "updatedAt": T })
}

fn decision(id: &str, question: &str) -> Value {
    json!({ "id": id, "taskId": "task-1", "question": question, "resolution": "Yes",
            "source": "user", "scope": "task", "confidence": 1, "status": "active",
            "createdAt": T, "supersedes": null })
}

fn question(id: &str, status: &str, blocking: bool, text: &str, option_ids: &[&str]) -> Value {
    let options: Vec<Value> = option_ids
        .iter()
        .map(|o| json!({ "id": o, "label": o, "description": "" }))
        .collect();
    json!({ "id": id, "taskId": "task-1", "threadId": null, "workItemId": null, "header": "H",
            "question": text, "context": "", "blocking": blocking, "urgency": "now",
            "defaultAction": null, "options": options, "recommendedOptionId": null,
            "status": status, "provisionalDecisionId": null, "answer": null,
            "answerOptionId": null, "resolutionSource": null, "supersedes": null,
            "createdAt": T, "resolvedAt": null })
}

fn blocker(id: &str, description: &str) -> Value {
    json!({ "id": id, "taskId": "task-1", "workItemId": null, "description": description,
            "blocking": true, "status": "active", "createdAt": T, "resolvedAt": null })
}

fn artifact(id: &str, path: &str) -> Value {
    json!({ "id": id, "taskId": "task-1", "workItemId": null, "threadId": null, "path": path,
            "kind": "file", "title": path, "createdBy": "agent", "provenance": {}, "createdAt": T })
}

/// The fixture `make_fixture.ts` fed to the TypeScript `buildTaskReviewMaterialSnapshot`.
fn mixed_order_task() -> TaskRecord {
    let texts = [
        "alpha",
        "Beta",
        "b",
        "A",
        "a",
        "10 items",
        "9 items",
        "Zebra",
        "é accent",
        "e plain",
        "f last",
        "co-op",
        "coop",
        "co_op",
        "don\u{2019}t stop",
        "dont stop",
        "\u{201C}quoted\u{201D}",
        "résumé",
        "resume",
        "Resume",
        "Ærø",
        "ångström",
        "z",
        "Straße",
        "strasse",
        "naïve \u{2014} dash",
        "naive - dash",
    ];
    let mut requirements: Vec<Value> = texts
        .iter()
        .enumerate()
        .map(|(i, text)| {
            requirement(
                &format!("r{i}"),
                "requirement",
                text,
                "user",
                "permanent",
                "active",
            )
        })
        .collect();
    requirements.push(requirement(
        "r-old",
        "constraint",
        "Superseded",
        "user",
        "permanent",
        "superseded",
    ));
    requirements.push(requirement(
        "r-c",
        "constraint",
        "Keep it short",
        "agent",
        "temporary",
        "active",
    ));

    serde_json::from_value(json!({
        "id": "task-1", "workspacePath": "/ws", "title": "Report", "objective": "Ship the report",
        "context": "", "sourceSessionId": null, "creationOrigin": "manual",
        "status": "awaiting_review", "revision": 3, "reviewRequired": true, "reviewRounds": 1,
        "createdAt": T, "updatedAt": T, "threadCount": 0, "completedWorkItemCount": 0,
        "totalWorkItemCount": 4, "activeBlockerCount": 2, "pendingQuestionCount": 2,
        "blockingQuestionCount": 2,
        "requirements": requirements,
        "threads": [],
        "workItems": [
            work_item("a", 0, &[], &[]),
            work_item("B", 0, &["b", "A", "a", "_x", "-x"], &["out/Z.md", "out/a.md"]),
            work_item("c", 10, &[], &[]),
            work_item("d", 9, &[], &[]),
        ],
        "decisions": [decision("d1", "alpha?"), decision("d2", "Beta?"), decision("d3", "beta?")],
        "questions": [
            question("q1", "pending", true, "Beta question", &["opt", "opt-b", "Opt-a", "opt_c"]),
            question("q2", "pending", true, "alpha question", &[]),
            question("q3", "answered", false, "Done?", &[]),
        ],
        "artifacts": [
            artifact("a1", "docs/a-b.md"),
            artifact("a2", "docs/a_b.md"),
            artifact("a3", "docs/Readme.md"),
            artifact("a4", "docs/notes.md"),
        ],
        "blockers": [blocker("b1", "Beta blocker"), blocker("b2", "alpha blocker")],
        "activity": [],
        "latestCheckpoint": null
    }))
    .expect("task fixture")
}

fn strings_at(snapshot: &serde_json::Map<String, Value>, array: &str, field: &str) -> Vec<String> {
    snapshot[array]
        .as_array()
        .expect("array")
        .iter()
        .map(|item| item[field].as_str().expect("string").to_owned())
        .collect()
}

#[test]
fn material_snapshot_keeps_typescript_locale_order_and_fingerprint() {
    let snapshot = build_task_review_material_snapshot(&mixed_order_task(), &[], &[]);

    assert_eq!(
        strings_at(&snapshot, "requirements", "text"),
        [
            "Keep it short",
            "\u{201C}quoted\u{201D}",
            "10 items",
            "9 items",
            "a",
            "A",
            "Ærø",
            "alpha",
            "ångström",
            "b",
            "Beta",
            "co_op",
            "co-op",
            "coop",
            "don\u{2019}t stop",
            "dont stop",
            "é accent",
            "e plain",
            "f last",
            "naive - dash",
            "naïve \u{2014} dash",
            "resume",
            "Resume",
            "résumé",
            "strasse",
            "Straße",
            "z",
            "Zebra",
        ]
    );
    assert_eq!(
        strings_at(&snapshot, "workItems", "id"),
        ["a", "B", "c", "d"]
    );
    assert_eq!(
        snapshot["workItems"][1]["dependsOn"],
        json!(["-x", "A", "_x", "a", "b"]),
        "dependsOn keeps JavaScript's default (UTF-16) sort"
    );
    assert_eq!(
        snapshot["workItems"][1]["expectedOutputs"],
        json!(["out/Z.md", "out/a.md"])
    );
    assert_eq!(
        strings_at(&snapshot, "decisions", "question"),
        ["alpha?", "beta?", "Beta?"]
    );
    assert_eq!(
        strings_at(&snapshot, "questions", "question"),
        ["Done?", "alpha question", "Beta question"]
    );
    assert_eq!(
        strings_at(
            snapshot["questions"][2].as_object().expect("question"),
            "options",
            "id"
        ),
        ["opt_c", "Opt-a", "opt-b", "opt"],
        "option ids are compared as JSON strings, quotes included"
    );
    assert_eq!(
        strings_at(&snapshot, "blockers", "description"),
        ["alpha blocker", "Beta blocker"]
    );
    assert_eq!(
        strings_at(&snapshot, "artifacts", "path"),
        [
            "docs/a_b.md",
            "docs/a-b.md",
            "docs/notes.md",
            "docs/Readme.md"
        ]
    );

    assert_eq!(
        fingerprint_task_review_material(&snapshot),
        "4caaa691ee76274c352ffb14308957ede011821ec155c419fe9d36046effdc8e"
    );
}
