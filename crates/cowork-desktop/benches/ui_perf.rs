//! Headless UI perf harness for the native desktop app.
//!
//! Drives the Main window's real `view` and `poll` (`cowork_desktop::perf_hooks`) in a Rune
//! `Runtime` with no window or GPU, over a realistic long-thread fixture, and reports per-step
//! CPU frame time (input/state change + poll + commit/layout/paint-instance build) for the
//! interactions that feel slow: opening and switching long threads, streaming, typing,
//! scrolling, opening settings, resizing, and sitting idle. Navigation steps also report the
//! motion frames they leave running until the runtime rests (`settle`, `frames`).
//!
//! ```sh
//! cargo bench -p cowork-desktop --bench ui_perf                  # all scenarios
//! cargo bench -p cowork-desktop --bench ui_perf -- typing scroll # a subset
//! cargo bench -p cowork-desktop --bench ui_perf -- --items 600 --json out.json
//! ```
//!
//! Numbers leave out GPU upload and presentation. Compare builds with paired, alternating runs
//! by median. Debug builds run the same scenarios (`cargo run`'s profile) but are far slower.

use std::time::Instant;

use cowork_desktop::actions::{Action, NavAction, StoreEvent};
use cowork_desktop::perf_hooks;
use cowork_desktop::router::{SettingsPageId, ViewId};
use cowork_desktop::state::{
    AppState, FeedItem, FeedMessageRole, ServerLifecycleState, SkillSummary, ThreadRecord,
    ThreadStatus, ToolRunStatus, WorkspaceRecord,
};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;

const VIEWPORT: (f32, f32) = (1280.0, 820.0);
const DT: f64 = 1.0 / 120.0;
/// Frames a settle may run (2 s at 120 Hz) before the harness stops waiting for rest.
const SETTLE_CAP: u32 = 240;
const WS_ID: &str = "ws-perf";

struct Opts {
    items: usize,
    filter: Vec<String>,
    json: Option<String>,
}

fn parse_opts() -> Opts {
    let mut opts = Opts {
        items: 400,
        filter: Vec::new(),
        json: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--items" => {
                opts.items = args.next().and_then(|v| v.parse().ok()).expect("--items N");
            }
            "--json" => opts.json = args.next(),
            // `cargo bench` passes `--bench`; ignore it and any other flag.
            a if a.starts_with('-') => {}
            a => opts.filter.push(a.to_string()),
        }
    }
    opts
}

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

const ASSISTANT_BODY: &str = "### Summary\n\nI traced the slow path through the **session runtime** and the `turn/start` handler. \
The main costs are:\n\n1. Rebuilding the transcript projection on every notification\n2. Serializing the full feed for persistence\n\
3. Re-shaping text that did not change\n\n```rust\nfn apply(&mut self, delta: &str) {\n    self.content.push_str(delta);\n    self.revision += 1;\n}\n```\n\n\
| Phase | Before | After |\n| --- | --- | --- |\n| view | 12 ms | 1 ms |\n| layout | 6 ms | 2 ms |\n\n\
See [the protocol doc](https://example.invalid/docs) and `crates/cowork-server/src/jsonrpc.rs` for details. \
Next I will verify the fix against the regression suite and report back with numbers.";

const USER_BODY: &str = "Can you look at why the transcript lags when a thread gets long? Check `feed.rs` and the reducer.";

fn tool(id: String, name: &str, ts: i64, output: serde_json::Value) -> FeedItem {
    FeedItem::Tool {
        id: id.clone(),
        tool_name: name.to_string(),
        title: Some(format!("{name} {id}")),
        call_id: Some(format!("call-{id}")),
        status: ToolRunStatus::Completed,
        input: json!({ "path": "crates/cowork-desktop/src/views/chat/feed.rs", "command": "cargo test -p cowork-desktop" }),
        output: Some(output),
        error: None,
        diff: None,
        streaming: false,
        timestamp_ms: ts,
        completed_at_ms: Some(ts + 900),
        output_truncated: false,
    }
}

/// A thread of `items` feed items in turns of user / reasoning / tools / assistant.
fn long_feed(thread: &str, items: usize) -> Vec<FeedItem> {
    let mut feed = Vec::with_capacity(items);
    let mut ts = 1_700_000_000_000i64;
    let mut turn = 0usize;
    while feed.len() < items {
        let p = format!("{thread}-{turn}");
        feed.push(FeedItem::Message {
            id: format!("u-{p}"),
            role: FeedMessageRole::User,
            content: USER_BODY.to_string(),
            client_message_id: None,
            attachments: Vec::new(),
            references: Vec::new(),
            citations: Vec::new(),
            streaming: false,
            timestamp_ms: ts,
        });
        feed.push(FeedItem::Reasoning {
            id: format!("r-{p}"),
            content: "**Planning** Read the feed builder, then the reducer, then measure."
                .to_string(),
            mode: "summary".to_string(),
            streaming: false,
            timestamp_ms: ts + 1_000,
        });
        feed.push(tool(
            format!("t1-{p}"),
            "read_file",
            ts + 2_000,
            json!({ "lines": 288 }),
        ));
        feed.push(tool(
            format!("t2-{p}"),
            "bash",
            ts + 3_000,
            json!({ "exitCode": 0, "stdout": "test result: ok. 412 passed; 0 failed\n".repeat(6) }),
        ));
        feed.push(FeedItem::Message {
            id: format!("a-{p}"),
            role: FeedMessageRole::Assistant,
            content: ASSISTANT_BODY.to_string(),
            client_message_id: None,
            attachments: Vec::new(),
            references: Vec::new(),
            citations: Vec::new(),
            streaming: false,
            timestamp_ms: ts + 4_000,
        });
        ts += 60_000;
        turn += 1;
    }
    feed.truncate(items);
    feed
}

/// The thread ids the fixture creates, newest first.
fn thread_id(i: usize) -> String {
    format!("th-perf-{i}")
}

fn fixture(items: usize) -> AppState {
    // Real (non-scene) code paths: poll, menus and shared-state turns all run.
    let mut s = AppState::default();
    s.scene_mode = false;
    s.onboarding.completed = true;
    s.native_ready = true;
    s.system_dark_override = Some(true);
    let mut ws = WorkspaceRecord::new(WS_ID, "Perf Project", "/tmp/cowork-perf", 1_700_000_000_000);
    ws.default_provider = Some("anthropic".to_string());
    ws.default_model = Some("claude-sonnet-4-5".to_string());
    s.workspaces.push(ws);
    s.workspace_order.push(WS_ID.to_string());
    s.active_workspace_id = Some(WS_ID.to_string());
    let ws_rt = s
        .workspace_runtime_by_id
        .entry(WS_ID.to_string())
        .or_default();
    ws_rt.server_state = ServerLifecycleState::Running {
        ws_url: "ws://127.0.0.1:7337/ws".to_string(),
        port: 7337,
    };
    for i in 0..40 {
        s.skills.push(SkillSummary {
            name: format!("skill-{i}"),
            description: "A bundled skill used to populate the mention catalog.".to_string(),
            scope: "global".to_string(),
            enabled: true,
            ..Default::default()
        });
    }
    // A sidebar with plenty of threads; the first two are long.
    for i in 0..60 {
        let id = thread_id(i);
        s.threads.push(ThreadRecord {
            id: id.clone(),
            workspace_id: WS_ID.to_string(),
            title: format!("Perf thread {i}: investigate transcript lag"),
            status: ThreadStatus::Active,
            session_id: Some(id.clone()),
            provider: Some("anthropic".to_string()),
            model: Some("claude-sonnet-4-5".to_string()),
            created_at: 1_700_000_000_000 - i as i64 * 1_000,
            updated_at: 1_700_000_060_000 - i as i64 * 1_000,
            ..Default::default()
        });
        let rt = s.thread_runtime_by_id.entry(id.clone()).or_default();
        rt.hydrated = true;
        rt.feed = long_feed(&id, if i < 2 { items } else { 10 });
    }
    s
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

struct Harness {
    rt: Runtime<AppState>,
    clock: f64,
}

impl Harness {
    fn new(state: AppState) -> Self {
        let mut rt = Runtime::new(state, perf_hooks::root_view, VIEWPORT, Env::new(true, 2.0));
        rt.frame(0.0);
        let mut h = Self { rt, clock: 0.0 };
        h.settle();
        h
    }

    /// One native-loop turn: `poll`, then the frame (commit only when something changed).
    fn frame(&mut self) -> bool {
        self.clock += DT;
        let now = self.clock;
        self.rt.update_if(|s, tx| perf_hooks::poll(s, now, tx));
        self.rt.frame(DT)
    }

    /// Runs frames until the runtime rests (bounded); returns how many ran.
    fn settle(&mut self) -> u32 {
        let mut frames = 0;
        while frames < SETTLE_CAP {
            frames += 1;
            if !self.frame() {
                break;
            }
        }
        frames
    }

    fn dispatch(&mut self, action: Action) {
        self.rt.update(move |s, _| s.dispatch(action));
    }

    fn commits(&self) -> u64 {
        self.rt.stats.commits
    }
}

#[derive(Default)]
struct Samples {
    ms: Vec<f64>,
    commits: u64,
    /// Per step, the frames after it until the runtime rests: total ms and frame count.
    settle_ms: Vec<f64>,
    settle_frames: Vec<f64>,
}

impl Samples {
    fn time(&mut self, h: &mut Harness, f: impl FnOnce(&mut Harness)) {
        let c0 = h.commits();
        let start = Instant::now();
        f(h);
        self.ms.push(start.elapsed().as_secs_f64() * 1000.0);
        self.commits += h.commits() - c0;
    }

    /// Times `f`, then the motion and fill frames it leaves running until the window rests.
    fn time_settled(&mut self, h: &mut Harness, f: impl FnOnce(&mut Harness)) {
        self.time(h, f);
        let start = Instant::now();
        let frames = h.settle();
        self.settle_ms.push(start.elapsed().as_secs_f64() * 1000.0);
        self.settle_frames.push(f64::from(frames));
    }
}

struct Report {
    name: &'static str,
    what: &'static str,
    samples: Samples,
    nodes: usize,
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

/// Puts the pointer over a thread's sidebar row and lets the hover settle (untimed).
fn hover_thread(h: &mut Harness, id: &str) {
    if let Some((x, y)) = h.rt.find(&format!("thread-{id}")) {
        h.rt.pointer_move(x, y);
        h.settle();
    }
}

/// Opens a thread as a user does, by clicking its sidebar row; dispatches the navigation when
/// the row isn't mounted. The step ends after the click's frame.
fn open_thread(h: &mut Harness, id: &str) {
    if let Some((x, y)) = h.rt.find(&format!("thread-{id}")) {
        h.rt.pointer_move(x, y);
        h.rt.pointer_down(x, y);
        h.rt.pointer_up(x, y);
    } else {
        h.dispatch(Action::Navigate(NavAction::OpenThread(id.to_string())));
    }
    h.frame();
    let active = h.rt.state.nav.current().active_thread_id.as_deref();
    assert_eq!(
        active,
        Some(id),
        "opening {id} took effect on the click's frame"
    );
}

/// Opening a long thread from the new-chat landing: the commit that first builds it.
fn scenario_open_thread(items: usize) -> Report {
    let mut samples = Samples::default();
    let mut h = Harness::new(fixture(items));
    for _ in 0..8 {
        h.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
        h.dispatch(Action::Navigate(NavAction::OpenNewChat {
            workspace_id: None,
        }));
        h.settle();
        hover_thread(&mut h, &thread_id(0));
        samples.time_settled(&mut h, |h| open_thread(h, &thread_id(0)));
    }
    Report {
        name: "open_thread",
        what: "landing -> long thread, first frame",
        nodes: h.rt.stats.layout_nodes,
        samples,
    }
}

/// Switching between two long threads in the sidebar.
fn scenario_switch_thread(items: usize) -> Report {
    let mut samples = Samples::default();
    let mut h = Harness::new(fixture(items));
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for i in 0..16 {
        let target = thread_id((i + 1) % 2);
        hover_thread(&mut h, &target);
        samples.time_settled(&mut h, |h| open_thread(h, &target));
    }
    Report {
        name: "switch_thread",
        what: "long thread <-> long thread, first frame",
        nodes: h.rt.stats.layout_nodes,
        samples,
    }
}

/// Assistant text streaming into the open long thread: one delta per frame.
fn scenario_streaming(items: usize) -> Report {
    let mut samples = Samples::default();
    let mut h = Harness::new(fixture(items));
    let tid = thread_id(0);
    open_thread(&mut h, &tid);
    h.settle();
    let notify = |h: &mut Harness, method: &str, params: serde_json::Value| {
        let method = method.to_string();
        h.rt.update(move |s, _| {
            s.apply_store_event(StoreEvent::WsNotification {
                workspace_id: WS_ID.to_string(),
                method,
                params,
            })
        });
    };
    notify(
        &mut h,
        "turn/started",
        json!({ "threadId": tid, "turnId": "turn-perf" }),
    );
    h.settle();
    let words = ASSISTANT_BODY.split_inclusive(' ').collect::<Vec<_>>();
    for chunk in words.chunks(3).take(150) {
        let delta: String = chunk.concat();
        samples.time(&mut h, |h| {
            notify(
                h,
                "item/agentMessage/delta",
                json!({ "threadId": tid, "itemId": "a-stream", "delta": delta }),
            );
            h.frame();
        });
    }
    Report {
        name: "streaming",
        what: "agentMessage delta -> frame",
        nodes: h.rt.stats.layout_nodes,
        samples,
    }
}

/// Typing into the composer of the open long thread: one key per frame.
fn scenario_typing(items: usize) -> Report {
    let mut samples = Samples::default();
    let mut h = Harness::new(fixture(items));
    open_thread(&mut h, &thread_id(0));
    h.settle();
    let (x, y) = h.rt.find("composer-input").expect("composer-input mounted");
    h.rt.pointer_move(x, y);
    h.frame();
    h.rt.pointer_down(x, y);
    h.frame();
    h.rt.pointer_up(x, y);
    h.settle();
    for ch in "please profile the transcript and fix the lag".chars() {
        samples.time(&mut h, |h| {
            h.rt.key(KeyEvent {
                key: Key::Text(ch.to_string()),
                mods: Mods::default(),
            });
            h.frame();
        });
    }
    let typed = h.rt.state.composer_edit.text.len();
    assert!(typed > 10, "typing reached the composer ({typed} bytes)");
    Report {
        name: "typing",
        what: "composer keystroke -> frame",
        nodes: h.rt.stats.layout_nodes,
        samples,
    }
}

/// Wheel-scrolling the long transcript up then down: one wheel event per frame.
fn scenario_scroll(items: usize) -> Report {
    let mut samples = Samples::default();
    let mut h = Harness::new(fixture(items));
    open_thread(&mut h, &thread_id(0));
    h.settle();
    let (x, y) = h.rt.find("chat-feed-scroll").expect("feed viewport");
    for i in 0..160 {
        let dy = if i < 80 { 120.0 } else { -120.0 };
        samples.time(&mut h, |h| {
            h.rt.wheel(x, y, dy);
            h.frame();
        });
    }
    Report {
        name: "scroll",
        what: "wheel -> frame over long transcript",
        nodes: h.rt.stats.layout_nodes,
        samples,
    }
}

/// Opening Settings from a long thread and going back.
fn scenario_settings(items: usize) -> Report {
    let mut samples = Samples::default();
    let mut h = Harness::new(fixture(items));
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for _ in 0..8 {
        samples.time_settled(&mut h, |h| {
            h.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
                SettingsPageId::Models,
            ))));
            h.frame();
        });
        samples.time_settled(&mut h, |h| open_thread(h, &thread_id(0)));
    }
    Report {
        name: "settings",
        what: "thread <-> settings, first frame",
        nodes: h.rt.stats.layout_nodes,
        samples,
    }
}

/// A live window resize with a long thread open: one width step per frame.
fn scenario_resize(items: usize) -> Report {
    let mut samples = Samples::default();
    let mut h = Harness::new(fixture(items));
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for i in 0..60 {
        let w = if i < 30 {
            VIEWPORT.0 - i as f32 * 8.0
        } else {
            VIEWPORT.0 - (60 - i) as f32 * 8.0
        };
        samples.time(&mut h, |h| {
            h.rt.set_viewport((w, VIEWPORT.1), 2.0);
            h.frame();
        });
    }
    Report {
        name: "resize",
        what: "viewport width step -> frame",
        nodes: h.rt.stats.layout_nodes,
        samples,
    }
}

/// An untouched window with a long thread open: polls and frames should commit nothing.
fn scenario_idle(items: usize) -> Report {
    let mut samples = Samples::default();
    let mut h = Harness::new(fixture(items));
    open_thread(&mut h, &thread_id(0));
    h.settle();
    for _ in 0..240 {
        samples.time(&mut h, |h| {
            h.frame();
        });
    }
    Report {
        name: "idle",
        what: "poll + frame, nothing changed",
        nodes: h.rt.stats.layout_nodes,
        samples,
    }
}

type Scenario = (&'static str, fn(usize) -> Report);

const SCENARIOS: &[Scenario] = &[
    ("open_thread", scenario_open_thread),
    ("switch_thread", scenario_switch_thread),
    ("streaming", scenario_streaming),
    ("typing", scenario_typing),
    ("scroll", scenario_scroll),
    ("settings", scenario_settings),
    ("resize", scenario_resize),
    ("idle", scenario_idle),
];

fn main() {
    let opts = parse_opts();
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "optimized"
    };
    println!(
        "cowork-desktop ui_perf: {} feed items per long thread, {profile} build, {}x{} @2x",
        opts.items, VIEWPORT.0, VIEWPORT.1
    );
    println!(
        "{:<14} {:>8} {:>9} {:>9} {:>9} {:>8} {:>8} {:>10} {:>7}  what",
        "scenario", "steps", "median", "p95", "max", "commits", "nodes", "settle", "frames"
    );
    let mut json_rows = Vec::new();
    for (name, run) in SCENARIOS {
        if !opts.filter.is_empty() && !opts.filter.iter().any(|f| name.contains(f.as_str())) {
            continue;
        }
        let report = run(opts.items);
        let mut sorted = report.samples.ms.clone();
        sorted.sort_by(f64::total_cmp);
        let (med, p95, max) = (
            pct(&sorted, 0.5),
            pct(&sorted, 0.95),
            sorted.last().copied().unwrap_or(0.0),
        );
        let median = |v: &[f64]| {
            let mut v = v.to_vec();
            v.sort_by(f64::total_cmp);
            pct(&v, 0.5)
        };
        let settled = !report.samples.settle_ms.is_empty();
        let (settle_ms, settle_frames) = (
            median(&report.samples.settle_ms),
            median(&report.samples.settle_frames),
        );
        let (settle_col, frames_col) = if settled {
            (format!("{settle_ms:.1}ms"), format!("{settle_frames:.0}"))
        } else {
            ("-".to_string(), "-".to_string())
        };
        println!(
            "{:<14} {:>8} {:>7.2}ms {:>7.2}ms {:>7.2}ms {:>8} {:>8} {:>10} {:>7}  {}",
            report.name,
            sorted.len(),
            med,
            p95,
            max,
            report.samples.commits,
            report.nodes,
            settle_col,
            frames_col,
            report.what
        );
        let mut row = json!({
            "scenario": report.name,
            "steps": sorted.len(),
            "median_ms": med,
            "p95_ms": p95,
            "max_ms": max,
            "commits": report.samples.commits,
            "layout_nodes": report.nodes,
        });
        if settled {
            row["settle_median_ms"] = json!(settle_ms);
            row["settle_median_frames"] = json!(settle_frames);
        }
        json_rows.push(row);
    }
    if let Some(path) = opts.json {
        let body = json!({ "items": opts.items, "profile": profile, "results": json_rows });
        std::fs::write(&path, serde_json::to_vec_pretty(&body).expect("json"))
            .expect("write --json output");
        println!("wrote {path}");
    }
}
