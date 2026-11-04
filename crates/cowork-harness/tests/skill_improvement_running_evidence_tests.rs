//! Job-store evidence caps vs. in-flight improvement runs (TS `JobStore.enqueueCompletedTurn` /
//! `finishJob` parity): while a job is claimed its usage/transcript arrays are left uncapped so
//! the claimed prefix stays aligned with the processed counts `finish_job` slices off; the
//! remainder is capped (newest kept) once the run finishes. Non-running jobs are capped on every
//! enqueue.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use cowork_harness::skill_improvement::{
    CompletedTurnSkillUsage, CompletedTurnSkillUsageInput, SKILL_IMPROVEMENT_DEBOUNCE_SECS,
    SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB, SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB,
    SkillImprovementJob, SkillImprovementJobStore,
};
use tempfile::TempDir;

const SKILL: &str = "foo";

fn used_at(seconds: i64) -> String {
    (DateTime::parse_from_rfc3339("2026-01-01T00:00:00.000Z")
        .unwrap()
        .with_timezone(&Utc)
        + Duration::seconds(seconds))
    .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn turn(turn_id: &str, seconds: i64) -> CompletedTurnSkillUsage {
    CompletedTurnSkillUsage {
        session_id: "session-1".to_owned(),
        turn_id: turn_id.to_owned(),
        working_directory: "/work".to_owned(),
        message_start_index: 0,
        message_end_index: 1,
        transcript: format!("transcript for {turn_id}"),
        usages: vec![CompletedTurnSkillUsageInput {
            skill_name: SKILL.to_owned(),
            kind: "tool".to_owned(),
            source: "skill-tool".to_owned(),
            turn_id: turn_id.to_owned(),
            used_at: used_at(seconds),
            skill_path: None,
            skill_source: Some("user".to_owned()),
        }],
    }
}

fn store() -> (TempDir, SkillImprovementJobStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SkillImprovementJobStore::new(dir.path());
    (dir, store)
}

fn record_turns(store: &SkillImprovementJobStore, prefix: &str, range: std::ops::Range<i64>) {
    for i in range {
        store
            .enqueue_completed_turn(turn(&format!("{prefix}{i}"), i))
            .expect("enqueue");
    }
}

fn job(store: &SkillImprovementJobStore) -> Option<SkillImprovementJob> {
    store.read().pending_jobs.get(SKILL).cloned()
}

fn usage_turn_ids(job: &SkillImprovementJob) -> Vec<String> {
    job.usage_events.iter().map(|e| e.turn_id.clone()).collect()
}

fn transcript_turn_ids(job: &SkillImprovementJob) -> Vec<String> {
    job.transcripts.iter().map(|t| t.turn_id.clone()).collect()
}

fn ids(prefix: &str, range: std::ops::Range<i64>) -> Vec<String> {
    range.map(|i| format!("{prefix}{i}")).collect()
}

fn finish(store: &SkillImprovementJobStore, usages: usize, transcripts: usize) {
    store
        .finish_job(
            SKILL,
            SKILL,
            "completed",
            &used_at(0),
            &used_at(1),
            "done",
            usages,
            transcripts,
            None,
        )
        .expect("finish");
}

#[test]
fn non_running_job_keeps_newest_usages_and_transcripts() {
    let (_dir, store) = store();
    record_turns(&store, "t", 0..30);

    let job = job(&store).expect("pending job");
    assert_eq!(job.status.as_deref(), Some("pending"));
    assert_eq!(usage_turn_ids(&job), ids("t", 5..30));
    assert_eq!(
        transcript_turn_ids(&job),
        ids(
            "t",
            (30 - SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB as i64)..30
        )
    );
    assert_eq!(job.usage_events.len(), SKILL_IMPROVEMENT_MAX_USAGES_PER_JOB);
    assert_eq!(job.last_usage_at, used_at(29));
}

#[test]
fn usage_recorded_during_run_survives_finish_as_pending_job() {
    let (_dir, store) = store();
    record_turns(&store, "t", 0..25);

    let claimed = store
        .claim_job_by_key(SKILL)
        .expect("claim")
        .expect("claimed job");
    assert_eq!(claimed.job.usage_events.len(), 25);
    let claimed_transcripts = claimed.job.transcripts.len();
    assert_eq!(
        claimed_transcripts,
        SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB
    );

    // Another turn records usage while the run waits on its model.
    record_turns(&store, "n", 100..103);
    let running = job(&store).expect("running job");
    assert_eq!(running.status.as_deref(), Some("running"));
    assert_eq!(running.usage_events.len(), 28, "no cap while running");
    assert_eq!(
        running.usage_events[..25],
        claimed.job.usage_events[..],
        "claimed prefix stays aligned"
    );
    assert_eq!(
        running.transcripts[..claimed_transcripts],
        claimed.job.transcripts[..]
    );

    finish(&store, 25, claimed_transcripts);

    let pending = job(&store).expect("new usage kept as pending job");
    assert_eq!(pending.status.as_deref(), Some("pending"));
    assert_eq!(pending.started_at, None);
    assert_eq!(usage_turn_ids(&pending), ids("n", 100..103));
    assert_eq!(transcript_turn_ids(&pending), ids("n", 100..103));
    assert_eq!(pending.last_usage_at, used_at(102));
    let expected_run_at = (DateTime::parse_from_rfc3339(&used_at(102))
        .unwrap()
        .with_timezone(&Utc)
        + Duration::seconds(SKILL_IMPROVEMENT_DEBOUNCE_SECS))
    .to_rfc3339_opts(SecondsFormat::Millis, true);
    assert_eq!(pending.run_at, expected_run_at);

    let state = store.read();
    assert_eq!(state.run_history[0].usage_count, 25);
}

#[test]
fn finish_caps_remaining_evidence_to_newest() {
    let (_dir, store) = store();
    record_turns(&store, "t", 0..25);
    let claimed = store.claim_job_by_key(SKILL).unwrap().unwrap();

    // More evidence than either cap arrives mid-run.
    record_turns(&store, "n", 100..130);
    let running = job(&store).unwrap();
    assert_eq!(running.usage_events.len(), 55);
    assert_eq!(
        running.transcripts.len(),
        SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB + 30
    );
    assert_eq!(running.transcripts[..8], claimed.job.transcripts[..]);

    finish(
        &store,
        claimed.job.usage_events.len(),
        claimed.job.transcripts.len(),
    );

    let pending = job(&store).unwrap();
    assert_eq!(usage_turn_ids(&pending), ids("n", 105..130));
    assert_eq!(
        transcript_turn_ids(&pending),
        ids(
            "n",
            (130 - SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB as i64)..130
        )
    );
    assert_eq!(pending.last_usage_at, used_at(129));
}

#[test]
fn transcript_recorded_during_run_survives_finish() {
    let (_dir, store) = store();
    // Fill the transcript cap exactly with distinct turns.
    record_turns(
        &store,
        "t",
        0..SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB as i64,
    );
    let claimed = store.claim_job_by_key(SKILL).unwrap().unwrap();
    assert_eq!(
        claimed.job.transcripts.len(),
        SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB
    );

    record_turns(&store, "n", 100..102);
    let running = job(&store).unwrap();
    assert_eq!(
        running.transcripts.len(),
        SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB + 2,
        "transcripts are not capped while running"
    );
    assert_eq!(
        transcript_turn_ids(&running)[..SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB],
        ids("t", 0..SKILL_IMPROVEMENT_MAX_TRANSCRIPTS_PER_JOB as i64)[..]
    );

    finish(
        &store,
        claimed.job.usage_events.len(),
        claimed.job.transcripts.len(),
    );

    let pending = job(&store).unwrap();
    assert_eq!(transcript_turn_ids(&pending), ids("n", 100..102));
    assert_eq!(usage_turn_ids(&pending), ids("n", 100..102));
}

#[test]
fn finish_without_new_usage_removes_job() {
    let (_dir, store) = store();
    record_turns(&store, "t", 0..25);
    let claimed = store.claim_job_by_key(SKILL).unwrap().unwrap();
    finish(
        &store,
        claimed.job.usage_events.len(),
        claimed.job.transcripts.len(),
    );
    assert!(job(&store).is_none());
}

#[test]
fn transcript_dedupe_is_per_session_and_turn() {
    let (_dir, store) = store();
    let mut first = turn("same-turn", 0);
    first.usages.push(first.usages[0].clone());
    store.enqueue_completed_turn(first).unwrap();
    let mut other_session = turn("same-turn", 1);
    other_session.session_id = "session-2".to_owned();
    store.enqueue_completed_turn(other_session).unwrap();

    let job = job(&store).unwrap();
    assert_eq!(job.usage_events.len(), 3);
    let sessions: Vec<_> = job
        .transcripts
        .iter()
        .map(|t| t.session_id.as_str())
        .collect();
    assert_eq!(sessions, ["session-1", "session-2"]);
}
