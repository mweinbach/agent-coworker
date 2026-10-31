use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cowork_js_vm::{
    CodeModeCatalog, CodeModeLimits, CodeModeOptions, CompileIssue, DEFAULT_WALL_CLOCK_TIMEOUT_MS,
    DeterminismMode, IsolateLimits, VmEvalOptions, WorkflowCompileResult, WorkflowJournal,
    WorkflowJournalEntry, WorkflowJournalOpenOptions, assert_safe_workflow_run_id,
    compile_workflow_source, digest_agent_call, eval_isolated_module, execute_code_mode,
    extract_result_envelope, hash_workflow_args, inspect_workflow_source, strip_typescript,
    validate_against_json_schema,
};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

struct EchoCatalog;

#[async_trait]
impl CodeModeCatalog for EchoCatalog {
    async fn search(&self, query: &str, _cancel: CancellationToken) -> Result<Value, String> {
        Ok(json!({
            "tools": [{
                "name": query,
                "description": "Echo tool",
                "inputSchema": { "type": "object" }
            }]
        }))
    }

    async fn call(
        &self,
        name: &str,
        arguments: Value,
        _cancel: CancellationToken,
    ) -> Result<Value, String> {
        if matches!(name, "codeMode" | "toolSearch" | "toolCall" | "prototype") {
            return Err(format!("tool \"{name}\" is not available in code mode"));
        }
        Ok(json!({
            "name": name,
            "arguments": arguments,
            "sources": [{ "url": "https://example.invalid/doc", "title": "Doc" }]
        }))
    }
}

#[tokio::test]
async fn oxc_strips_typescript_types_generics_enums_and_deep_research() {
    assert_eq!(DEFAULT_WALL_CLOCK_TIMEOUT_MS, 30_000);

    let ts_source = r#"
        interface Item<T> {
            id: string;
            payload: T;
        }
        type CountMap = Record<string, number>;
        enum Priority {
            Low = 1,
            High = 2,
        }
        export const compute = async <T extends number>(items: Array<Item<T>>): Promise<CountMap> => {
            const out: CountMap = {};
            for (const item of items) {
                out[item.id] = (item.payload as number) * Priority.High;
            }
            return out;
        };
    "#;

    let js = strip_typescript(ts_source, "sample.ts").expect("oxc strip should succeed");
    assert!(!js.contains("interface Item"));
    assert!(!js.contains("type CountMap"));
    assert!(js.contains("Priority"));

    // Verify bundled workflows/deep-research.ts compiles cleanly through oxc pipeline
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("workspace root")
        .to_path_buf();
    let deep_research = std::fs::read_to_string(repo_root.join("workflows/deep-research.ts"))
        .expect("read workflows/deep-research.ts");
    match compile_workflow_source(&deep_research) {
        WorkflowCompileResult::Ok { js, source_hash } => {
            assert!(!js.is_empty());
            assert_eq!(source_hash.len(), 64);
        }
        WorkflowCompileResult::Err { issues } => {
            panic!("deep-research.ts failed to compile: {issues:?}");
        }
    }

    let inspected = inspect_workflow_source(&deep_research, 2_000)
        .await
        .expect("inspect deep-research.ts");
    assert_eq!(inspected.meta.name, "deep-research");
    assert_eq!(
        inspected.meta.phases,
        vec!["plan", "research", "verify", "synthesize"]
    );
}

#[test]
fn workflow_compiler_rejects_static_and_dynamic_imports_and_missing_exports() {
    // Empty script
    match compile_workflow_source("   ") {
        WorkflowCompileResult::Err { issues } => {
            assert!(issues.iter().any(|i: &CompileIssue| i.path == "script"));
        }
        WorkflowCompileResult::Ok { .. } => panic!("expected empty script error"),
    }

    // Static import
    let with_static_import = r#"
        import fs from "node:fs";
        export const meta = { name: "bad", description: "bad", phases: ["one"] };
        export default async function run() { return fs; }
    "#;
    match compile_workflow_source(with_static_import) {
        WorkflowCompileResult::Err { issues } => {
            assert!(
                issues
                    .iter()
                    .any(|i| i.path == "imports" && i.message.contains("node:fs")),
                "unexpected issues: {issues:?}"
            );
        }
        WorkflowCompileResult::Ok { .. } => panic!("expected static import rejection"),
    }

    // Dynamic import() expression
    let with_dynamic_import = r#"
        export const meta = { name: "bad", description: "bad", phases: ["one"] };
        export default async function run() {
            return await import("node:fs");
        }
    "#;
    match compile_workflow_source(with_dynamic_import) {
        WorkflowCompileResult::Err { issues } => {
            assert!(
                issues.iter().any(|i| i.path == "imports"),
                "unexpected issues: {issues:?}"
            );
        }
        WorkflowCompileResult::Ok { .. } => panic!("expected dynamic import rejection"),
    }

    // Missing meta and default exports
    match compile_workflow_source("export const other = 1;") {
        WorkflowCompileResult::Err { issues } => {
            assert!(issues.iter().any(|i| i.path == "exports.meta"));
            assert!(issues.iter().any(|i| i.path == "exports.default"));
        }
        WorkflowCompileResult::Ok { .. } => panic!("expected missing exports rejection"),
    }
}

#[tokio::test]
async fn quickjs_enforces_byte_heap_limit_without_crashing_process() {
    let opts = CodeModeOptions {
        limits: CodeModeLimits {
            max_memory_bytes: 4 * 1024 * 1024, // 4 MiB hard cap
            timeout_ms: 5_000,
            ..CodeModeLimits::default()
        },
        cancel_token: None,
        on_call_event: None,
    };

    let err = execute_code_mode(
        r#"
        const chunks: string[] = [];
        while (true) {
            chunks.push("x".repeat(256 * 1024));
        }
        "#,
        Arc::new(EchoCatalog),
        opts,
    )
    .await
    .expect_err("runaway heap allocation must fail under set_memory_limit");

    let msg = err.to_string().to_ascii_lowercase();
    assert!(
        msg.contains("memory") || msg.contains("out of memory"),
        "expected OOM error message, got: {err}"
    );

    // Subsequent isolate must run cleanly in the same process
    let ok = execute_code_mode(
        "const values: number[] = [1, 2, 3]; return values.reduce((a, b) => a + b, 0);",
        Arc::new(EchoCatalog),
        CodeModeOptions::default(),
    )
    .await
    .expect("subsequent isolate should succeed cleanly");
    assert_eq!(ok.value, json!(6));
}

#[tokio::test]
async fn quickjs_interrupt_handler_terminates_infinite_loop_and_cancellation() {
    let started = Instant::now();
    let err = execute_code_mode(
        "while (true) {}",
        Arc::new(EchoCatalog),
        CodeModeOptions {
            limits: CodeModeLimits {
                timeout_ms: 150,
                ..CodeModeLimits::default()
            },
            cancel_token: None,
            on_call_event: None,
        },
    )
    .await
    .expect_err("while(true){} must be terminated by wall-clock interrupt handler");

    assert!(
        started.elapsed() < Duration::from_secs(3),
        "interrupt handler took too long: {:?}",
        started.elapsed()
    );
    let msg = err.to_string().to_ascii_lowercase();
    assert!(
        msg.contains("timed out") || msg.contains("interrupt") || msg.contains("exceeded"),
        "unexpected timeout error: {err}"
    );

    // Also verify external CancellationToken aborts while(true){}
    let cancel = CancellationToken::new();
    let cancel_trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        cancel_trigger.cancel();
    });
    let cancel_err = execute_code_mode(
        "while (true) {}",
        Arc::new(EchoCatalog),
        CodeModeOptions {
            limits: CodeModeLimits {
                timeout_ms: 10_000,
                ..CodeModeLimits::default()
            },
            cancel_token: Some(cancel),
            on_call_event: None,
        },
    )
    .await
    .expect_err("cancelled execution must abort");
    assert!(
        cancel_err
            .to_string()
            .to_ascii_lowercase()
            .contains("cancel")
            || cancel_err
                .to_string()
                .to_ascii_lowercase()
                .contains("interrupt"),
        "unexpected cancel error: {cancel_err}"
    );

    // Also verify metadata inspection halts top-level infinite loop
    let bad_meta_res = inspect_workflow_source(
        r#"
        const spin = (() => { while (true) {} })();
        export const meta = { name: "hang", description: String(spin), phases: ["main"] };
        export default async function run() { return null; }
        "#,
        150,
    )
    .await;
    assert!(bad_meta_res.is_err());
}

#[tokio::test]
async fn realm_seals_globals_freezes_intrinsics_and_supports_deterministic_clock_rng() {
    // 1. All 9 global constructor/prototype escape probes + ambient globals + frozen intrinsics
    let probe_res = execute_code_mode(
        r#"
        const body = "return [typeof process, typeof Bun, typeof fetch]";
        const probes = [
          () => (globalThis as any).constructor.constructor(body)(),
          () => Reflect.get(globalThis, "constructor").constructor(body)(),
          () => Object.getPrototypeOf(globalThis).constructor.constructor(body)(),
          () => Reflect.getPrototypeOf(globalThis).constructor.constructor(body)(),
          () => (globalThis as any).__proto__.constructor.constructor(body)(),
          () => Function("return this")().constructor.constructor(body)(),
          () => (globalThis as any).valueOf().constructor.constructor(body)(),
          () => (globalThis as any).toString.constructor(body)(),
          () => Object.getOwnPropertyDescriptor(globalThis, "constructor")!.value.constructor(body)(),
        ].map(probe => {
          try { return probe(); }
          catch (error: any) { return error.constructor.constructor(body)(); }
        });

        let prototypeMutationBlocked = false;
        try {
          (Object.prototype as any).polluted = "bad";
        } catch {
          prototypeMutationBlocked = true;
        }

        const dynamicImports: Array<{ message: string; host: string[] }> = [];
        for (const spec of ["node:fs", "bun", "https://example.invalid/mod.js"]) {
          try {
            await import(spec);
          } catch (err: any) {
            dynamicImports.push({
              message: String(err.message),
              host: err.constructor.constructor(body)(),
            });
          }
        }

        return {
          probes,
          prototypeMutationBlocked,
          frozen: {
            objectProto: Object.isFrozen(Object.prototype),
            arrayProto: Object.isFrozen(Array.prototype),
            functionProto: Object.isFrozen(Function.prototype),
            promiseProto: Object.isFrozen(Promise.prototype),
            json: Object.isFrozen(JSON),
            math: Object.isFrozen(Math),
            tools: Object.isFrozen(tools),
            console: Object.isFrozen(console),
          },
          ambient: [
            typeof (globalThis as any).fetch,
            typeof (globalThis as any).process,
            typeof (globalThis as any).Bun,
            typeof (globalThis as any).ShadowRealm,
            typeof (globalThis as any).WebAssembly,
            typeof (globalThis as any).Atomics,
            typeof (globalThis as any).SharedArrayBuffer,
            typeof (globalThis as any).WeakRef,
            typeof (globalThis as any).FinalizationRegistry,
            typeof (globalThis as any).Intl,
            typeof (globalThis as any).eval,
          ],
          importMetaKeys: Object.getOwnPropertyNames(import.meta),
          dynamicImports,
        };
        "#,
        Arc::new(EchoCatalog),
        CodeModeOptions::default(),
    )
    .await
    .expect("security probe script should succeed");

    assert_eq!(
        probe_res.value["probes"],
        json!(vec![vec!["undefined", "undefined", "undefined"]; 9])
    );
    assert_eq!(probe_res.value["prototypeMutationBlocked"], json!(true));
    assert_eq!(probe_res.value["frozen"]["objectProto"], json!(true));
    assert_eq!(probe_res.value["frozen"]["arrayProto"], json!(true));
    assert_eq!(probe_res.value["frozen"]["functionProto"], json!(true));
    assert_eq!(probe_res.value["frozen"]["promiseProto"], json!(true));
    assert_eq!(probe_res.value["frozen"]["json"], json!(true));
    assert_eq!(probe_res.value["frozen"]["math"], json!(true));
    assert_eq!(probe_res.value["frozen"]["tools"], json!(true));
    assert_eq!(probe_res.value["frozen"]["console"], json!(true));
    assert_eq!(probe_res.value["ambient"], json!(vec!["undefined"; 11]));
    assert_eq!(probe_res.value["importMetaKeys"], json!([]));
    assert_eq!(
        probe_res.value["dynamicImports"].as_array().unwrap().len(),
        3
    );
    for entry in probe_res.value["dynamicImports"].as_array().unwrap() {
        assert!(
            entry["message"]
                .as_str()
                .unwrap()
                .contains("imports are not available in code mode")
        );
        assert_eq!(
            entry["host"],
            json!(["undefined", "undefined", "undefined"])
        );
    }

    // 2. Workflow determinism traps vs seeded clock/RNG
    let trap_check = eval_isolated_module(
        r#"
        export default async function main() {
          const errors = [];
          for (const fn of [
            () => Date.now(),
            () => new Date().getTime(),
            () => Date(),
            () => {
              const d = new Date(0);
              const Ctor = d.constructor;
              return new Ctor().getTime();
            },
            () => Math.random(),
          ]) {
            try { fn(); errors.push("ok"); }
            catch (e) { errors.push(String(e.message)); }
          }
          return {
            errors,
            epochIso: new Date(0).toISOString(),
            maxVal: Math.max(2, 9, 4),
          };
        }
        "#,
        VmEvalOptions {
            limits: IsolateLimits::default(),
            determinism: DeterminismMode::WorkflowTraps,
            cancel_token: None,
        },
    )
    .await
    .expect("workflow traps eval");
    let errs = trap_check.value["errors"].as_array().unwrap();
    assert!(errs[0].as_str().unwrap().contains("Date.now()"));
    assert!(errs[1].as_str().unwrap().contains("new Date()"));
    assert!(errs[2].as_str().unwrap().contains("Date()"));
    assert!(
        errs[3].as_str().unwrap().contains("new Date()"),
        "errs = {errs:?}"
    );
    assert!(errs[4].as_str().unwrap().contains("Math.random()"));
    assert_eq!(
        trap_check.value["epochIso"],
        json!("1970-01-01T00:00:00.000Z")
    );
    assert_eq!(trap_check.value["maxVal"], json!(9));

    // Seeded deterministic mode produces identical sequence across runs
    let seeded_script = r#"
        export default async function main() {
          return {
            now: Date.now(),
            iso: new Date().toISOString(),
            r1: Math.random(),
            r2: Math.random(),
            r3: Math.random(),
          };
        }
    "#;
    let run1 = eval_isolated_module(
        seeded_script,
        VmEvalOptions {
            limits: IsolateLimits::default(),
            determinism: DeterminismMode::Seeded {
                epoch_ms: 1_700_000_000_000,
                rng_seed: 42,
            },
            cancel_token: None,
        },
    )
    .await
    .expect("seeded run 1");
    let run2 = eval_isolated_module(
        seeded_script,
        VmEvalOptions {
            limits: IsolateLimits::default(),
            determinism: DeterminismMode::Seeded {
                epoch_ms: 1_700_000_000_000,
                rng_seed: 42,
            },
            cancel_token: None,
        },
    )
    .await
    .expect("seeded run 2");
    assert_eq!(run1.value, run2.value);
    assert_eq!(run1.value["now"], json!(1_700_000_000_000i64));
    assert_ne!(run1.value["r1"], run1.value["r2"]);
}

#[tokio::test]
async fn code_mode_bridges_tools_enforces_concurrency_and_budgets_and_captures_logs() {
    struct ConcurrencyCatalog {
        active: AtomicUsize,
        peak: AtomicUsize,
        calls: AtomicUsize,
        two_active: Notify,
        gate: Notify,
    }

    #[async_trait]
    impl CodeModeCatalog for ConcurrencyCatalog {
        async fn search(&self, query: &str, _cancel: CancellationToken) -> Result<Value, String> {
            Ok(json!({ "tools": [{ "name": query }] }))
        }

        async fn call(
            &self,
            name: &str,
            arguments: Value,
            _cancel: CancellationToken,
        ) -> Result<Value, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let now_active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now_active, Ordering::SeqCst);
            if now_active == 2 {
                self.two_active.notify_waiters();
            }
            self.gate.notified().await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(json!({ "tool": name, "args": arguments }))
        }
    }

    let catalog = Arc::new(ConcurrencyCatalog {
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
        calls: AtomicUsize::new(0),
        two_active: Notify::new(),
        gate: Notify::new(),
    });

    let cat_for_run = Arc::clone(&catalog);
    let handle = tokio::spawn(async move {
        execute_code_mode(
            r#"
            interface LookupOut { tool: string; args: { idx: number } }
            console.log("starting batch", { count: 5 });
            const found = await tools.search("lookup");
            const out: LookupOut[] = await Promise.all(
                [0, 1, 2, 3, 4].map((idx: number) => tools.call("lookup", { idx }) as Promise<LookupOut>)
            );
            console.warn("finished batch");
            return { found, count: out.length, last: out[4] };
            "#,
            cat_for_run,
            CodeModeOptions {
                limits: CodeModeLimits {
                    max_concurrency: 2,
                    ..CodeModeLimits::default()
                },
                cancel_token: None,
                on_call_event: None,
            },
        )
        .await
    });

    catalog.two_active.notified().await;
    assert_eq!(catalog.calls.load(Ordering::SeqCst), 2);
    // Release all 5 calls in waves
    for _ in 0..8 {
        catalog.gate.notify_waiters();
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let res = handle.await.unwrap().expect("codeMode parallel run");
    assert_eq!(catalog.peak.load(Ordering::SeqCst), 2);
    assert_eq!(catalog.calls.load(Ordering::SeqCst), 5);
    assert_eq!(res.value["count"], json!(5));
    assert_eq!(
        res.value["last"],
        json!({ "tool": "lookup", "args": { "idx": 4 } })
    );
    assert_eq!(res.logs.len(), 2);
    assert!(res.logs[0].contains("starting batch"));
    assert!(res.logs[1].contains("finished batch"));

    // Budget enforcement: maxCalls
    let call_budget_err = execute_code_mode(
        r#"
        await tools.search("a");
        await tools.search("b");
        await tools.search("c");
        return "unreachable";
        "#,
        Arc::new(EchoCatalog),
        CodeModeOptions {
            limits: CodeModeLimits {
                max_calls: 2,
                ..CodeModeLimits::default()
            },
            cancel_token: None,
            on_call_event: None,
        },
    )
    .await
    .expect_err("exceeding max_calls must fail");
    assert!(call_budget_err.to_string().contains("maxCalls"));

    // Budget enforcement: maxArgumentBytes
    let arg_budget_err = execute_code_mode(
        r#"return await tools.call("echo", { big: "a".repeat(2048) });"#,
        Arc::new(EchoCatalog),
        CodeModeOptions {
            limits: CodeModeLimits {
                max_argument_bytes: 512,
                ..CodeModeLimits::default()
            },
            cancel_token: None,
            on_call_event: None,
        },
    )
    .await
    .expect_err("exceeding max_argument_bytes must fail");
    assert!(arg_budget_err.to_string().contains("maxArgumentBytes"));

    // Budget enforcement: maxOutputBytes
    let out_budget_err = execute_code_mode(
        r#"return { big: "z".repeat(4096) };"#,
        Arc::new(EchoCatalog),
        CodeModeOptions {
            limits: CodeModeLimits {
                max_output_bytes: 512,
                ..CodeModeLimits::default()
            },
            cancel_token: None,
            on_call_event: None,
        },
    )
    .await
    .expect_err("exceeding max_output_bytes must fail");
    assert!(out_budget_err.to_string().contains("maxOutputBytes"));
}

#[tokio::test]
async fn workflow_journal_replays_occurrences_and_validates_json_schemas() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let project_cowork_dir = tmp.path().join(".cowork");

    assert!(assert_safe_workflow_run_id("wf_abc123_def-9").is_ok());
    assert!(assert_safe_workflow_run_id("../escape").is_err());
    assert!(assert_safe_workflow_run_id("not_wf_prefix").is_err());

    let args_hash = hash_workflow_args(&json!({ "query": "rust quickjs" }));
    let d1 = digest_agent_call(&args_hash, "step one", &json!({ "phase": "plan" }));
    let d2 = digest_agent_call(&args_hash, "step two", &json!({ "phase": "research" }));
    assert_ne!(d1, d2);

    // Record out-of-order occurrences of identical digest d1 and verify index-sorted multiset replay
    let journal1 = WorkflowJournal::open(WorkflowJournalOpenOptions {
        project_cowork_dir: project_cowork_dir.clone(),
        run_id: "wf_run000000001".to_owned(),
        resume_from_run_id: None,
        persist: true,
    })
    .await
    .expect("open journal 1");

    journal1
        .append(&WorkflowJournalEntry {
            index: 2,
            digest: d1.clone(),
            phase: Some("plan".to_owned()),
            label: Some("second".to_owned()),
            result: json!("second-occurrence"),
            agent_id: Some("agent-2".to_owned()),
            usd_cost: Some(0.02),
        })
        .await
        .expect("append idx 2");
    journal1
        .append(&WorkflowJournalEntry {
            index: 0,
            digest: d1.clone(),
            phase: Some("plan".to_owned()),
            label: Some("first".to_owned()),
            result: json!("first-occurrence"),
            agent_id: Some("agent-1".to_owned()),
            usd_cost: Some(0.01),
        })
        .await
        .expect("append idx 0");
    journal1.flush().await.expect("flush");

    let resumed = WorkflowJournal::open(WorkflowJournalOpenOptions {
        project_cowork_dir: project_cowork_dir.clone(),
        run_id: "wf_run000000002".to_owned(),
        resume_from_run_id: Some("wf_run000000001".to_owned()),
        persist: true,
    })
    .await
    .expect("open resumed journal");

    let first = resumed.lookup(&d1).expect("first cached hit");
    assert_eq!(first.result, json!("first-occurrence"));
    let second = resumed.lookup(&d1).expect("second cached hit");
    assert_eq!(second.result, json!("second-occurrence"));
    assert!(resumed.lookup(&d1).is_none());

    // JSON schema envelope extraction + validation
    let schema = json!({
        "type": "object",
        "properties": {
            "count": { "type": "integer", "minimum": 1 }
        },
        "required": ["count"],
        "additionalProperties": false
    });
    let raw = extract_result_envelope(Some(
        "thinking...\n<workflow_result>{\"count\": 3}</workflow_result>",
    ));
    assert_eq!(raw.as_deref(), Some("{\"count\": 3}"));
    let ok = validate_against_json_schema(&schema, raw.as_deref()).expect("valid schema");
    assert_eq!(ok.ok_value(), Some(&json!({ "count": 3 })));

    let bad = validate_against_json_schema(&schema, Some("{\"count\": 0}")).expect("valid schema");
    assert!(!bad.issues().is_empty());
}
