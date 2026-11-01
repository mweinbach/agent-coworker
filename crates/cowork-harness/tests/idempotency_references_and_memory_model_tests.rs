//! Regression tests for the durable `clientMessageId` ledger, explicit turn `references` plus
//! normalized `@` mention resolution, and memory-generation failure handling.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cowork_harness::{
    MemoryGenerator, RemoteMemoryModel, TurnIdempotencyLedger, TurnReference, TurnReferenceKind,
    parse_turn_references, resolve_turn_references,
};
use cowork_inference::{ProviderTransportError, StepBudget};
use cowork_providers::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
};
use cowork_storage::MemoryStore;
use cowork_tools::discover_skills;
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

fn isolated_dirs(prefix: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("cowork-harness-{prefix}-{}", Uuid::new_v4()));
    let home = root.join("home");
    let ws = root.join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    (
        fs::canonicalize(home).unwrap(),
        fs::canonicalize(ws).unwrap(),
    )
}

/// Accepted-turn receipts as the server journals them (`internal/userMessageAccepted`).
#[derive(Default)]
struct FakeJournal {
    receipts: Mutex<Vec<Value>>,
    lookups: AtomicUsize,
}

impl FakeJournal {
    fn record(&self, cid: &str, turn_id: &str, fp: &str) {
        self.receipts
            .lock()
            .push(TurnIdempotencyLedger::build_journal_payload(
                cid, turn_id, fp,
            ));
    }

    fn load(&self, cid: &str) -> Option<Value> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        self.receipts
            .lock()
            .iter()
            .find(|p| p["clientMessageId"] == cid)
            .cloned()
    }
}

fn admit(ledger: &TurnIdempotencyLedger, journal: &FakeJournal, cid: &str, text: &str) -> String {
    let proposed = format!("turn-{cid}");
    let outcome = ledger
        .check_or_record_with_journal(cid, &proposed, text, &[], |k| journal.load(k))
        .unwrap();
    if !outcome.was_duplicate {
        journal.record(cid, &outcome.turn_id, &outcome.payload_fingerprint);
    }
    outcome.turn_id
}

#[test]
fn evicted_client_message_id_replays_from_the_journal_instead_of_starting_a_new_turn() {
    let journal = FakeJournal::default();
    let ledger = TurnIdempotencyLedger::new();
    for i in 0..300 {
        admit(
            &ledger,
            &journal,
            &format!("cid-{i}"),
            &format!("message {i}"),
        );
    }
    // While nothing was evicted, misses were authoritative and never hit the journal.
    let lookups_before_eviction = journal.lookups.load(Ordering::SeqCst);
    assert!(lookups_before_eviction < 300 - 256 + 1);

    // `cid-0` fell out of the 256-entry cache long ago; its receipt is still journaled.
    let retry = ledger
        .check_or_record_with_journal("cid-0", "turn-new", "message 0", &[], |k| journal.load(k))
        .unwrap();
    assert!(retry.was_duplicate, "evicted key must replay");
    assert_eq!(retry.turn_id, "turn-cid-0");
    let lookup = ledger
        .lookup_existing_with_journal("cid-1", "message 1", &[], |k| journal.load(k))
        .unwrap()
        .expect("evicted key must be found");
    assert_eq!(lookup.turn_id, "turn-cid-1");
    // Reusing an evicted key with a different payload is still a conflict.
    assert!(
        ledger
            .check_or_record_with_journal("cid-2", "turn-new", "other text", &[], |k| {
                journal.load(k)
            })
            .is_err()
    );

    // Restart: a fresh ledger hydrated from every journaled receipt keeps the same horizon.
    let restarted = TurnIdempotencyLedger::new();
    for payload in journal.receipts.lock().iter() {
        restarted.hydrate_from_journal_payload(payload);
    }
    let after_restart = restarted
        .check_or_record_with_journal("cid-0", "turn-new", "message 0", &[], |k| journal.load(k))
        .unwrap();
    assert!(after_restart.was_duplicate);
    assert_eq!(after_restart.turn_id, "turn-cid-0");

    // A genuinely new key is still admitted.
    let fresh = restarted
        .check_or_record_with_journal("cid-new", "turn-x", "new", &[], |k| journal.load(k))
        .unwrap();
    assert!(!fresh.was_duplicate);
    assert_eq!(fresh.turn_id, "turn-x");
}

#[test]
fn incomplete_ledger_consults_the_journal_on_every_miss() {
    let journal = FakeJournal::default();
    journal.record(
        "cid-a",
        "turn-a",
        &TurnIdempotencyLedger::fingerprint_input("hi", &[]),
    );
    let ledger = TurnIdempotencyLedger::new();
    ledger.mark_incomplete();
    let outcome = ledger
        .check_or_record_with_journal("cid-a", "turn-b", "hi", &[], |k| journal.load(k))
        .unwrap();
    assert!(outcome.was_duplicate);
    assert_eq!(outcome.turn_id, "turn-a");
}

fn write_skill(ws: &std::path::Path, name: &str, body: &str) {
    let dir = ws.join(".cowork/skills").join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {name} helper\n---\n{body}\n"),
    )
    .unwrap();
}

#[test]
fn explicit_references_and_normalized_mentions_inject_skills() {
    let (home, ws) = isolated_dirs("refs");
    let cowork_home = home.join(".cowork");
    write_skill(&ws, "documents", "DOCUMENTS-SKILL-BODY");
    write_skill(&ws, "slides", "SLIDES-SKILL-BODY");
    let plugin_dir = cowork_home.join("plugins/github-sync");
    fs::create_dir_all(&plugin_dir).unwrap();
    fs::write(plugin_dir.join("PLUGIN.md"), "Plugin docs for github-sync.").unwrap();
    let skills = discover_skills(None, &cowork_home, &ws);

    // Explicit reference with no mention in the text.
    let refs =
        parse_turn_references(Some(&[json!({ "kind": "skill", "name": "documents" })])).unwrap();
    let resolved = resolve_turn_references("Write the memo", &refs, &skills, &cowork_home, &ws);
    assert_eq!(resolved.injected_skill_names, vec!["documents".to_owned()]);
    assert!(resolved.injected_skill_blocks[0].contains("DOCUMENTS-SKILL-BODY"));

    // Desktop-style mentions: capitalized and followed by sentence punctuation.
    for text in [
        "Use @Documents.",
        "Use @documents. Then stop",
        "(@DOCUMENTS:) go",
    ] {
        let resolved = resolve_turn_references(text, &[], &skills, &cowork_home, &ws);
        assert_eq!(
            resolved.injected_skill_names,
            vec!["documents".to_owned()],
            "{text}"
        );
    }

    // References come first, mentions add to them, nothing is injected twice.
    let resolved = resolve_turn_references(
        "@slides and @documents please @GitHub-Sync.",
        &refs,
        &skills,
        &cowork_home,
        &ws,
    );
    assert_eq!(
        resolved.injected_skill_names,
        vec!["documents".to_owned(), "slides".to_owned()]
    );
    assert_eq!(resolved.referenced_plugins.len(), 1);
    assert_eq!(resolved.referenced_plugins[0].0, "github-sync");

    // Plugin reference; a plugin reference naming a skill resolves as the skill only.
    let resolved = resolve_turn_references(
        "go",
        &[
            TurnReference {
                kind: TurnReferenceKind::Plugin,
                name: "github-sync".to_owned(),
            },
            TurnReference {
                kind: TurnReferenceKind::Plugin,
                name: "documents".to_owned(),
            },
        ],
        &skills,
        &cowork_home,
        &ws,
    );
    assert!(resolved.injected_skill_names.is_empty());
    assert_eq!(resolved.referenced_plugins.len(), 1);

    let _ = fs::remove_dir_all(ws.parent().unwrap());
}

#[test]
fn malformed_references_are_rejected() {
    assert!(parse_turn_references(None).unwrap().is_empty());
    assert!(parse_turn_references(Some(&[json!({ "kind": "tool", "name": "x" })])).is_err());
    assert!(parse_turn_references(Some(&[json!({ "kind": "skill", "name": "  " })])).is_err());
    assert!(
        parse_turn_references(Some(&[json!({ "kind": "skill", "name": "x", "extra": 1 })]))
            .is_err()
    );
    let too_many: Vec<Value> = (0..33)
        .map(|i| json!({ "kind": "skill", "name": format!("s{i}") }))
        .collect();
    assert!(parse_turn_references(Some(&too_many)).is_err());
    assert_eq!(
        parse_turn_references(Some(&[json!({ "kind": "skill", "name": " documents " })])).unwrap(),
        vec![TurnReference {
            kind: TurnReferenceKind::Skill,
            name: "documents".to_owned()
        }]
    );
}

struct FailingTransport;

#[async_trait]
impl ProviderTransport for FailingTransport {
    async fn stream_step(
        &self,
        _req: ProviderStepRequest,
        _budget: &StepBudget,
        _on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        Err(ProviderTransportError::protocol("model not found"))
    }
}

#[tokio::test]
async fn failed_remote_memory_extraction_does_not_advance_the_cursor_or_write() {
    let (home, ws) = isolated_dirs("memgen");
    let store = MemoryStore::new(ws.join("memory.db"), home.join("memory.db"));
    let messages = vec![
        json!({ "role": "user", "content": "remember: always run cargo fmt before committing" }),
        json!({ "role": "assistant", "content": "Noted." }),
    ];
    let generated = MemoryGenerator::new()
        .maybe_generate_from_transcript(
            &messages,
            0,
            Some(&store),
            None,
            Some(RemoteMemoryModel {
                transport: Arc::new(FailingTransport),
                model_id: "gpt-4.1-mini".to_owned(),
                base_url: None,
                api_key: None,
            }),
        )
        .await;
    assert!(
        generated.is_err(),
        "a failed remote model must not report success"
    );
    assert!(
        store.list(None).unwrap_or_default().is_empty(),
        "nothing may be written when the run fails"
    );

    // Without a remote model the offline directive extraction still runs and advances.
    let next = MemoryGenerator::new()
        .maybe_generate_from_transcript(&messages, 0, Some(&store), None, None)
        .await
        .unwrap();
    assert_eq!(next, 2);
    assert_eq!(store.list(None).unwrap().len(), 1);
    let _ = fs::remove_dir_all(ws.parent().unwrap());
}
