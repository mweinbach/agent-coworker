//! `turn/steer` admission must be serialized with queue insertion and admission closure: once
//! `close_admission()` returns, no later enqueue may succeed, and every enqueue that did succeed
//! must be visible to the turn's final `drain_pending()`. Otherwise a steer racing turn
//! completion is acknowledged (`steerAccepted` + `Ok`) yet neither processed nor rejected.

use std::collections::HashSet;
use std::sync::{Arc, Barrier};
use std::thread;

use cowork_harness::{HarnessEventSink, SteerCoordinator};
use parking_lot::Mutex;
use serde_json::Value;

#[derive(Default)]
struct RecordingSink {
    notifications: Mutex<Vec<(String, Value)>>,
}

impl RecordingSink {
    fn accepted_ids(&self) -> HashSet<String> {
        self.notifications
            .lock()
            .iter()
            .filter(|(method, _)| method == "cowork/session/steerAccepted")
            .filter_map(|(_, params)| params["steerRequestId"].as_str().map(str::to_owned))
            .collect()
    }
}

impl HarnessEventSink for RecordingSink {
    fn send_notification(&self, method: &str, params: Value) {
        self.notifications.lock().push((method.to_owned(), params));
    }
    fn send_server_request(&self, _request_id: &str, _method: &str, _params: Value) {}
}

fn coordinator(sink: &Arc<RecordingSink>) -> Arc<SteerCoordinator> {
    let sink: Arc<dyn HarnessEventSink> = Arc::clone(sink) as _;
    Arc::new(SteerCoordinator::new("thread", "turn", sink, None))
}

/// Races steer producers (with and without `clientMessageId`) against the turn's
/// close-then-final-drain sequence. Every `Ok` enqueue must surface in the final drain (or an
/// earlier step-boundary drain), every steer refused after closure must be an `Err`, and no
/// `steerAccepted` may be emitted for a refused steer.
#[test]
fn steer_enqueue_racing_close_admission_is_never_lost() {
    const ITERATIONS: usize = 400;
    const PRODUCERS: usize = 4;
    const STEERS_PER_PRODUCER: usize = 64;

    for iteration in 0..ITERATIONS {
        let sink = Arc::new(RecordingSink::default());
        let steer = coordinator(&sink);
        let start = Arc::new(Barrier::new(PRODUCERS + 1));

        let producers: Vec<_> = (0..PRODUCERS)
            .map(|p| {
                let steer = Arc::clone(&steer);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    let mut accepted = Vec::new();
                    let mut rejected = 0usize;
                    for i in 0..STEERS_PER_PRODUCER {
                        let cid = (i % 2 == 0).then(|| format!("cid-{p}-{i}"));
                        match steer.enqueue_steer(format!("guidance {p}/{i}"), cid) {
                            Ok(v) => {
                                assert_ne!(v.get("replayed"), Some(&Value::Bool(true)));
                                accepted.push(v["steerRequestId"].as_str().unwrap().to_owned());
                            }
                            Err(e) => {
                                assert_eq!(e.message, "Active turn no longer accepts steering.");
                                rejected += 1;
                            }
                        }
                    }
                    (accepted, rejected)
                })
            })
            .collect();

        start.wait();
        // Turn side: one step-boundary drain, then settle (close + final drain).
        let mut drained: HashSet<String> = steer
            .drain_pending()
            .into_iter()
            .map(|e| e.request_id)
            .collect();
        steer.close_admission();
        let final_drain: Vec<_> = steer.drain_pending();
        // `steerAccepted` must already have been emitted for everything the final drain sees, so
        // the client never observes a rejection before the matching acceptance.
        let accepted_before_final_drain = sink.accepted_ids();
        for entry in &final_drain {
            assert!(
                accepted_before_final_drain.contains(&entry.request_id),
                "iteration {iteration}: steerAccepted for {} not emitted before final drain",
                entry.request_id
            );
        }
        drained.extend(final_drain.into_iter().map(|e| e.request_id));

        let mut accepted_ok = HashSet::new();
        for producer in producers {
            let (accepted, _rejected) = producer.join().unwrap();
            accepted_ok.extend(accepted);
        }

        // Nothing may slip into the queue after the final drain.
        let late: Vec<_> = steer.drain_pending();
        assert!(
            late.is_empty(),
            "iteration {iteration}: {} steer(s) enqueued after close_admission + final drain",
            late.len()
        );
        assert!(steer.is_admission_closed());
        let lost: Vec<_> = accepted_ok.difference(&drained).collect();
        assert!(
            lost.is_empty(),
            "iteration {iteration}: accepted steers never drained: {lost:?}"
        );
        assert_eq!(
            sink.accepted_ids(),
            accepted_ok,
            "iteration {iteration}: steerAccepted must be emitted exactly for Ok enqueues"
        );
    }
}

/// A steer refused because admission closed must not reserve its `clientMessageId`: a retry with
/// the same id is refused again rather than "replayed" as if it had been accepted.
#[test]
fn steer_rejected_after_close_is_not_recorded_for_replay() {
    let sink = Arc::new(RecordingSink::default());
    let steer = coordinator(&sink);

    let accepted = steer
        .enqueue_steer("before close".to_owned(), Some("cid-ok".to_owned()))
        .expect("open turn admits steer");
    steer.close_admission();

    // A replay of an already-accepted steer still reports the original acceptance.
    let replay = steer
        .enqueue_steer("before close".to_owned(), Some("cid-ok".to_owned()))
        .expect("replay of accepted steer");
    assert_eq!(replay["replayed"], Value::Bool(true));
    assert_eq!(replay["steerRequestId"], accepted["steerRequestId"]);

    for _ in 0..2 {
        let err = steer
            .enqueue_steer("after close".to_owned(), Some("cid-late".to_owned()))
            .expect_err("closed turn refuses steer");
        assert_eq!(err.message, "Active turn no longer accepts steering.");
    }
    let err = steer
        .enqueue_steer("after close".to_owned(), None)
        .expect_err("closed turn refuses steer");
    assert_eq!(err.message, "Active turn no longer accepts steering.");

    let drained = steer.drain_pending();
    assert_eq!(drained.len(), 1);
    assert_eq!(
        Value::String(drained[0].request_id.clone()),
        accepted["steerRequestId"]
    );
    assert_eq!(
        sink.accepted_ids().len(),
        1,
        "no steerAccepted for refused steers"
    );
}
