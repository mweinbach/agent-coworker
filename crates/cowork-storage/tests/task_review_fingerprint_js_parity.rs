//! Review-material fingerprints must match the ones the TypeScript server persisted
//! (`JSON.stringify(stableNormalize(snapshot))` hashed with SHA-256), so passing reviews
//! recorded before the Rust migration still validate. Expected strings and hashes were produced
//! by running the `stableNormalize`/`stableStringify` code from `origin/main`'s
//! `src/server/tasks/taskReviewPolicy.ts` under Node.

use cowork_storage::{
    TaskRecord, build_task_review_material_snapshot, fingerprint_task_review_material,
    stable_stringify,
};
use serde_json::{Map, Value, json};

#[test]
fn canonical_json_renders_numbers_like_javascript() {
    let snapshot = json!({
        "schemaVersion": 1,
        "objective": "Ship the report",
        "context": "Q3 — résumé",
        "requirements": [],
        "workItems": [{
            "id": "wi-1", "title": "Draft", "description": "", "status": "done",
            "dependsOn": [], "assignedThreadId": null, "expectedOutputs": [],
            "completionEvidence": null, "position": 0
        }],
        "decisions": [
            { "question": "Format?", "resolution": "PDF", "source": "user", "scope": "task", "confidence": 1.0_f64, "status": "active" },
            { "question": "Tone?", "resolution": "Formal", "source": "agent", "scope": "task", "confidence": 0.0_f64, "status": "active" },
            { "question": "Length?", "resolution": "Short", "source": "agent", "scope": "task", "confidence": 0.85_f64, "status": "active" }
        ],
        "questions": [],
        "blockers": [],
        "artifacts": [{
            "id": "a1", "path": "out/report.pdf", "sizeBytes": 2048,
            "versions": [{ "version": 2, "sizeBytes": 1.5e21_f64 }],
            "tiny": 1.5e-7_f64, "neg": -2.5_f64
        }]
    });
    let expected = r#"{"artifacts":[{"id":"a1","neg":-2.5,"path":"out/report.pdf","sizeBytes":2048,"tiny":1.5e-7,"versions":[{"sizeBytes":1.5e+21,"version":2}]}],"blockers":[],"context":"Q3 — résumé","decisions":[{"confidence":1,"question":"Format?","resolution":"PDF","scope":"task","source":"user","status":"active"},{"confidence":0,"question":"Tone?","resolution":"Formal","scope":"task","source":"agent","status":"active"},{"confidence":0.85,"question":"Length?","resolution":"Short","scope":"task","source":"agent","status":"active"}],"objective":"Ship the report","questions":[],"requirements":[],"schemaVersion":1,"workItems":[{"assignedThreadId":null,"completionEvidence":null,"dependsOn":[],"description":"","expectedOutputs":[],"id":"wi-1","position":0,"status":"done","title":"Draft"}]}"#;
    assert_eq!(stable_stringify(&snapshot), expected);

    let Value::Object(map) = snapshot else {
        unreachable!()
    };
    assert_eq!(
        fingerprint_task_review_material(&map),
        "3ad66abd3ba111085227ea6c6a28e4af3ed9e31a569264b74e15276db3832f0c"
    );
}

#[test]
fn javascript_number_formatting_edge_cases() {
    for (value, js) in [
        (-0.0_f64, "0"),
        (1.0, "1"),
        (100.0, "100"),
        (0.1, "0.1"),
        (0.000001, "0.000001"),
        (0.0000001, "1e-7"),
        (123456789012345680000.0, "123456789012345680000"),
        (1e21, "1e+21"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (5e-324, "5e-324"),
        (-1234.5678, "-1234.5678"),
        (2f64.powi(60), "1152921504606847000"),
    ] {
        assert_eq!(stable_stringify(&json!(value)), js, "{value:e}");
    }
    assert_eq!(
        stable_stringify(&json!(9_007_199_254_740_993_u64)),
        "9007199254740992"
    );
    assert_eq!(stable_stringify(&json!(-42_i64)), "-42");
}

/// End to end through the snapshot builder: a task whose decisions carry `confidence` 1 and 0
/// (stored as `f64`) must fingerprint exactly as the TypeScript server did.
#[test]
fn snapshot_fingerprint_matches_typescript_for_integral_confidence() {
    let task: TaskRecord = serde_json::from_value(json!({
        "id": "task-1",
        "workspacePath": "/ws",
        "title": "Report",
        "objective": "Ship the report",
        "context": "",
        "sourceSessionId": null,
        "creationOrigin": "manual",
        "status": "awaiting_review",
        "revision": 3,
        "reviewRequired": true,
        "reviewRounds": 1,
        "createdAt": "2025-01-01T00:00:00.000Z",
        "updatedAt": "2025-01-01T00:00:00.000Z",
        "threadCount": 0,
        "completedWorkItemCount": 0,
        "totalWorkItemCount": 0,
        "activeBlockerCount": 0,
        "pendingQuestionCount": 0,
        "blockingQuestionCount": 0,
        "requirements": [],
        "threads": [],
        "workItems": [],
        "decisions": [
            { "id": "d2", "taskId": "task-1", "question": "B?", "resolution": "Formal", "source": "agent",
              "scope": "task", "confidence": 0.0, "status": "active", "createdAt": "2025-01-01T00:00:00.000Z", "supersedes": null },
            { "id": "d1", "taskId": "task-1", "question": "A?", "resolution": "PDF", "source": "user",
              "scope": "task", "confidence": 1.0, "status": "active", "createdAt": "2025-01-01T00:00:00.000Z", "supersedes": null }
        ],
        "questions": [],
        "artifacts": [],
        "blockers": [],
        "activity": [],
        "latestCheckpoint": null
    }))
    .expect("task fixture");
    let snapshot: Map<String, Value> = build_task_review_material_snapshot(&task, &[], &[]);
    assert_eq!(
        stable_stringify(&Value::Object(snapshot.clone())),
        r#"{"artifacts":[],"blockers":[],"context":"","decisions":[{"confidence":1,"question":"A?","resolution":"PDF","scope":"task","source":"user","status":"active"},{"confidence":0,"question":"B?","resolution":"Formal","scope":"task","source":"agent","status":"active"}],"objective":"Ship the report","questions":[],"requirements":[],"schemaVersion":1,"workItems":[]}"#
    );
    assert_eq!(
        fingerprint_task_review_material(&snapshot),
        "3d5aa812eb269f8986366ca31ba6a3b17aacf0251d0fe394cfc834d6864fa63c"
    );
}
