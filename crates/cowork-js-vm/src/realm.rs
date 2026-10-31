use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::module::Declared;
use rquickjs::prelude::*;
use rquickjs::{AsyncContext, AsyncRuntime, CaughtError, Ctx, Error as QjsError, Function, Module};
use serde_json::Value;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::{DEFAULT_ISOLATE_HEAP_LIMIT_BYTES, DEFAULT_ISOLATE_MAX_STACK_BYTES};

/// Default wall-clock interrupt timeout in milliseconds (`30s`).
pub const DEFAULT_WALL_CLOCK_TIMEOUT_MS: u64 = 30_000;

/// Default maximum console lines captured per isolate run.
pub const DEFAULT_MAX_CONSOLE_LOGS: usize = 200;

/// Default maximum characters per captured console line.
pub const DEFAULT_MAX_CONSOLE_LINE_CHARS: usize = 2_000;

#[derive(Debug, Error)]
pub enum VmError {
    #[error("isolate out of memory (exceeded {limit_bytes} byte heap limit): {detail}")]
    OutOfMemory { limit_bytes: usize, detail: String },
    #[error("isolate execution timed out after {timeout_ms}ms")]
    TimedOut { timeout_ms: u64 },
    #[error("isolate execution cancelled")]
    Cancelled,
    #[error("{0}")]
    Execution(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeterminismMode {
    /// Standard clock/RNG (used by `codeMode` unless overridden).
    #[default]
    Live,
    /// Workflow determinism traps (`Date()`, `new Date()`, `Date.now()`, `Math.random()` throw).
    WorkflowTraps,
    /// Seeded deterministic clock & xorshift64* PRNG for reproducible script runs.
    Seeded { epoch_ms: i64, rng_seed: u64 },
}

#[derive(Debug, Clone)]
pub struct IsolateLimits {
    pub max_memory_bytes: usize,
    pub max_stack_bytes: usize,
    pub wall_clock_timeout_ms: u64,
    pub max_console_logs: usize,
    pub max_console_line_chars: usize,
    pub freeze_intrinsics: bool,
}

impl Default for IsolateLimits {
    fn default() -> Self {
        Self {
            max_memory_bytes: DEFAULT_ISOLATE_HEAP_LIMIT_BYTES,
            max_stack_bytes: DEFAULT_ISOLATE_MAX_STACK_BYTES,
            wall_clock_timeout_ms: DEFAULT_WALL_CLOCK_TIMEOUT_MS,
            max_console_logs: DEFAULT_MAX_CONSOLE_LOGS,
            max_console_line_chars: DEFAULT_MAX_CONSOLE_LINE_CHARS,
            freeze_intrinsics: true,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct VmEvalOptions {
    pub limits: IsolateLimits,
    pub determinism: DeterminismMode,
    pub cancel_token: Option<CancellationToken>,
}

#[derive(Debug, Clone)]
pub struct VmEvalResult {
    pub value: Value,
    pub logs: Vec<String>,
    pub logs_truncated: bool,
}

#[derive(Debug, Default)]
pub(crate) struct BoundedConsoleBuffer {
    pub lines: Vec<String>,
    pub truncated: bool,
    pub max_lines: usize,
    pub max_line_chars: usize,
}

impl BoundedConsoleBuffer {
    pub fn new(max_lines: usize, max_line_chars: usize) -> Self {
        Self {
            lines: Vec::new(),
            truncated: false,
            max_lines,
            max_line_chars,
        }
    }

    pub fn push(&mut self, level: &str, message: &str) {
        if self.lines.len() >= self.max_lines {
            self.truncated = true;
            return;
        }
        let clipped: String = message.chars().take(self.max_line_chars).collect();
        if level == "log" {
            self.lines.push(clipped);
        } else {
            self.lines.push(format!("[{level}] {clipped}"));
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InterruptCause {
    TimedOut,
    Cancelled,
}

pub(crate) struct RejectingResolver {
    pub deny_message: String,
}

impl Resolver for RejectingResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        Err(QjsError::new_resolving_message(
            base,
            name,
            self.deny_message.clone(),
        ))
    }
}

pub(crate) struct RejectingLoader {
    pub deny_message: String,
}

impl Loader for RejectingLoader {
    fn load<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, Declared>> {
        Err(QjsError::new_loading_message(
            name,
            self.deny_message.clone(),
        ))
    }
}

pub(crate) struct PreparedIsolate {
    pub rt: AsyncRuntime,
    pub ctx: AsyncContext,
    pub console: Arc<Mutex<BoundedConsoleBuffer>>,
    pub interrupt_cause: Arc<Mutex<Option<InterruptCause>>>,
    pub slice_deadline: Arc<Mutex<Instant>>,
    pub cancel_flag: Arc<AtomicBool>,
}

/// Builds a fresh `rquickjs::AsyncRuntime` + `AsyncContext` configured with:
/// - `Runtime::set_memory_limit`
/// - `Runtime::set_max_stack_size`
/// - Rejecting module loader/resolver
/// - Wall-clock + cancellation interrupt handler
pub(crate) async fn create_isolated_runtime(
    limits: &IsolateLimits,
    import_deny_message: &str,
    cancel_token: Option<&CancellationToken>,
) -> Result<PreparedIsolate, VmError> {
    let rt = AsyncRuntime::new()
        .map_err(|e| VmError::Execution(format!("failed creating QuickJS runtime: {e}")))?;
    if limits.max_memory_bytes > 0 {
        rt.set_memory_limit(limits.max_memory_bytes).await;
    }
    if limits.max_stack_bytes > 0 {
        rt.set_max_stack_size(limits.max_stack_bytes).await;
    }

    rt.set_loader(
        RejectingResolver {
            deny_message: import_deny_message.to_owned(),
        },
        RejectingLoader {
            deny_message: import_deny_message.to_owned(),
        },
    )
    .await;

    let timeout_ms = limits.wall_clock_timeout_ms.max(1);
    let slice_deadline = Arc::new(Mutex::new(
        Instant::now() + Duration::from_millis(timeout_ms),
    ));
    let cancel_flag = Arc::new(AtomicBool::new(
        cancel_token.is_some_and(CancellationToken::is_cancelled),
    ));
    let interrupt_cause = Arc::new(Mutex::new(None));

    let flag_for_handler = Arc::clone(&cancel_flag);
    let token_for_handler = cancel_token.cloned();
    let cause_for_handler = Arc::clone(&interrupt_cause);
    let deadline_for_handler = Arc::clone(&slice_deadline);
    rt.set_interrupt_handler(Some(Box::new(move || {
        if flag_for_handler.load(Ordering::Relaxed)
            || token_for_handler
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
        {
            let mut g = cause_for_handler.lock();
            if g.is_none() {
                *g = Some(InterruptCause::Cancelled);
            }
            return true;
        }
        if Instant::now() >= *deadline_for_handler.lock() {
            let mut g = cause_for_handler.lock();
            if g.is_none() {
                *g = Some(InterruptCause::TimedOut);
            }
            return true;
        }
        false
    })))
    .await;

    let ctx = AsyncContext::full(&rt)
        .await
        .map_err(|e| map_qjs_error(e, limits, &interrupt_cause))?;
    let console = Arc::new(Mutex::new(BoundedConsoleBuffer::new(
        limits.max_console_logs,
        limits.max_console_line_chars,
    )));

    Ok(PreparedIsolate {
        rt,
        ctx,
        console,
        interrupt_cause,
        slice_deadline,
        cancel_flag,
    })
}

/// Seals `globalThis` to the strict allowlist, installs bounded `console`, configures
/// `DeterminismMode`, nulls `Object.getPrototypeOf(globalThis)`, and optionally freezes JS intrinsics.
pub(crate) fn install_realm_seal<'js>(
    ctx: &Ctx<'js>,
    console: Arc<Mutex<BoundedConsoleBuffer>>,
    determinism: DeterminismMode,
    freeze_intrinsics: bool,
    extra_allowed_globals: &[&str],
) -> rquickjs::Result<()> {
    let console_push = Function::new(ctx.clone(), move |level: String, line: String| {
        console.lock().push(&level, &line);
    })?;
    ctx.globals().set("__cowork_console_push", console_push)?;

    let mut allowed = vec![
        "globalThis",
        "undefined",
        "NaN",
        "Infinity",
        "isNaN",
        "isFinite",
        "parseInt",
        "parseFloat",
        "decodeURI",
        "decodeURIComponent",
        "encodeURI",
        "encodeURIComponent",
        "Object",
        "Function",
        "Array",
        "String",
        "Boolean",
        "Number",
        "Math",
        "Date",
        "RegExp",
        "Error",
        "EvalError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "TypeError",
        "URIError",
        "AggregateError",
        "SuppressedError",
        "JSON",
        "Promise",
        "Map",
        "Set",
        "WeakMap",
        "WeakSet",
        "Symbol",
        "BigInt",
        "Proxy",
        "Reflect",
        "Iterator",
        "console",
        "ArrayBuffer",
        "DataView",
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "Float16Array",
        "Float32Array",
        "Float64Array",
        "BigInt64Array",
        "BigUint64Array",
        "DisposableStack",
        "AsyncDisposableStack",
    ];
    allowed.extend_from_slice(extra_allowed_globals);
    let allowed_json = serde_json::to_string(&allowed).unwrap_or_else(|_| "[]".to_owned());

    let determinism_js = match determinism {
        DeterminismMode::Live => String::new(),
        DeterminismMode::WorkflowTraps => r#"
            (() => {
              const deny = (what) => () => {
                throw new Error(
                  what + " is not available in workflow scripts: it would break journal resume. " +
                  "Derive the value from args or the call index instead."
                );
              };
              const RealDate = Date;
              function TrappedDate(...args) {
                if (!new.target) {
                  return deny("Date()")();
                }
                if (args.length === 0) {
                  return deny("new Date()")();
                }
                return Reflect.construct(RealDate, args, RealDate);
              }
              TrappedDate.UTC = RealDate.UTC.bind(RealDate);
              TrappedDate.parse = RealDate.parse.bind(RealDate);
              TrappedDate.now = deny("Date.now()");
              Object.defineProperty(TrappedDate, "prototype", {
                value: RealDate.prototype,
                writable: false,
                configurable: false,
              });
              Object.defineProperty(RealDate.prototype, "constructor", {
                value: TrappedDate,
                writable: false,
                configurable: false,
              });
              Object.defineProperty(globalThis, "Date", {
                value: TrappedDate,
                writable: false,
                configurable: false,
              });
              Object.defineProperty(Math, "random", {
                value: deny("Math.random()"),
                writable: false,
                configurable: false,
              });
            })();
        "#
        .to_owned(),
        DeterminismMode::Seeded { epoch_ms, rng_seed } => {
            let safe_seed = if rng_seed == 0 {
                0x9E37_79B9_7F4A_7C15_u64
            } else {
                rng_seed
            };
            format!(
                r#"
                (() => {{
                  const EPOCH = {epoch_ms};
                  let state = BigInt("{safe_seed}");
                  const MASK64 = (1n << 64n) - 1n;
                  const MUL = 2685821657736338717n;
                  const nextRandom = () => {{
                    state = (state ^ (state >> 12n)) & MASK64;
                    state = (state ^ ((state << 25n) & MASK64)) & MASK64;
                    state = (state ^ (state >> 27n)) & MASK64;
                    const out = (state * MUL) & MASK64;
                    const top53 = Number(out >> 11n);
                    return top53 / 9007199254740992;
                  }};
                  const RealDate = Date;
                  function SeededDate(...args) {{
                    if (!new.target) {{
                      return new RealDate(EPOCH).toString();
                    }}
                    if (args.length === 0) {{
                      return new RealDate(EPOCH);
                    }}
                    return Reflect.construct(RealDate, args, RealDate);
                  }}
                  SeededDate.UTC = RealDate.UTC.bind(RealDate);
                  SeededDate.parse = RealDate.parse.bind(RealDate);
                  SeededDate.now = () => EPOCH;
                  Object.defineProperty(SeededDate, "prototype", {{
                    value: RealDate.prototype,
                    writable: false,
                    configurable: false,
                  }});
                  Object.defineProperty(RealDate.prototype, "constructor", {{
                    value: SeededDate,
                    writable: false,
                    configurable: false,
                  }});
                  Object.defineProperty(globalThis, "Date", {{
                    value: SeededDate,
                    writable: false,
                    configurable: false,
                  }});
                  Object.defineProperty(Math, "random", {{
                    value: nextRandom,
                    writable: false,
                    configurable: false,
                  }});
                }})();
                "#
            )
        }
    };

    let freeze_js = if freeze_intrinsics {
        r#"
        (() => {
          const freeze = Object.freeze;
          const defineProperty = Object.defineProperty;
          const getOwnDesc = Object.getOwnPropertyDescriptor;
          const NativeTypeError = TypeError;

          // SES-style override-safe accessor conversion for Error prototypes so QuickJS C
          // `JS_Throw*Error` / `new Error(msg)` can define own `.message`/`.stack` on instances
          // even after `Error.prototype` is frozen, while direct prototype mutation still throws.
          const makeOverrideSafe = (proto, prop) => {
            if (!proto) return;
            const desc = getOwnDesc(proto, prop);
            if (!desc || !("value" in desc) || !desc.configurable) return;
            const initial = desc.value;
            const enumerable = Boolean(desc.enumerable);
            defineProperty(proto, prop, {
              get() { return initial; },
              set(v) {
                if (this === proto || this === null || (typeof this !== "object" && typeof this !== "function")) {
                  throw new NativeTypeError("Cannot mutate frozen prototype property " + String(prop));
                }
                defineProperty(this, prop, {
                  value: v,
                  writable: true,
                  enumerable,
                  configurable: true,
                });
              },
              enumerable,
              configurable: false,
            });
          };

          const errorProtos = [
            Error.prototype,
            TypeError.prototype,
            RangeError.prototype,
            SyntaxError.prototype,
            ReferenceError.prototype,
            URIError.prototype,
            EvalError.prototype,
            AggregateError.prototype,
          ];
          for (const ep of errorProtos) {
            makeOverrideSafe(ep, "message");
            makeOverrideSafe(ep, "name");
            makeOverrideSafe(ep, "stack");
            makeOverrideSafe(ep, "cause");
          }
          makeOverrideSafe(Object.prototype, "toString");
          makeOverrideSafe(Object.prototype, "valueOf");
          makeOverrideSafe(Function.prototype, "name");

          const targets = [
            Object, Object.prototype,
            Function, Function.prototype,
            Array, Array.prototype,
            String, String.prototype,
            Number, Number.prototype,
            Boolean, Boolean.prototype,
            RegExp, RegExp.prototype,
            Date, Date.prototype,
            Promise, Promise.prototype,
            Map, Map.prototype,
            Set, Set.prototype,
            WeakMap, WeakMap.prototype,
            WeakSet, WeakSet.prototype,
            Error, Error.prototype,
            TypeError, TypeError.prototype,
            RangeError, RangeError.prototype,
            SyntaxError, SyntaxError.prototype,
            ReferenceError, ReferenceError.prototype,
            URIError, URIError.prototype,
            EvalError, EvalError.prototype,
            AggregateError, AggregateError.prototype,
            ArrayBuffer, ArrayBuffer.prototype,
            DataView, DataView.prototype,
            JSON,
            Math,
            Reflect,
            console,
          ];
          for (const item of targets) {
            if (item && (typeof item === "object" || typeof item === "function")) {
              try { freeze(item); } catch {}
            }
          }
        })();
        "#
    } else {
        ""
    };

    let bootstrap = format!(
        r#"
        (() => {{
          const rawPush = globalThis.__cowork_console_push;
          delete globalThis.__cowork_console_push;
          const stringify = JSON.stringify;
          const join = Array.prototype.join;
          const map = Array.prototype.map;
          const formatArg = (arg) => {{
            if (typeof arg === "string") return arg;
            try {{
              const s = stringify(arg);
              if (typeof s === "string") return s;
            }} catch {{}}
            try {{ return String(arg); }} catch {{ return "[unprintable]"; }}
          }};
          const makeLogger = (level) => (...args) => {{
            try {{
              const parts = map.call(args, formatArg);
              rawPush(level, join.call(parts, " "));
            }} catch {{}}
          }};
          Object.defineProperty(globalThis, "console", {{
            value: {{
              log: makeLogger("log"),
              info: makeLogger("info"),
              warn: makeLogger("warn"),
              error: makeLogger("error"),
              debug: makeLogger("debug"),
            }},
            writable: true,
            configurable: true,
          }});

          const ALLOWED = new Set({allowed_json});
          for (const name of Object.getOwnPropertyNames(globalThis)) {{
            if (ALLOWED.has(name)) continue;
            try {{ delete globalThis[name]; }} catch {{}}
            if (name in globalThis) {{
              try {{
                Object.defineProperty(globalThis, name, {{ value: undefined, configurable: false }});
              }} catch {{}}
            }}
          }}
          try {{ Object.setPrototypeOf(globalThis, null); }} catch {{}}
        }})();
        {determinism_js}
        {freeze_js}
        "#
    );

    ctx.eval::<(), _>(bootstrap.as_bytes())
}

pub(crate) fn extract_caught_error<'js>(
    err: CaughtError<'js>,
    limits: &IsolateLimits,
    interrupt_cause: &Mutex<Option<InterruptCause>>,
) -> VmError {
    if let Some(cause) = *interrupt_cause.lock() {
        return match cause {
            InterruptCause::Cancelled => VmError::Cancelled,
            InterruptCause::TimedOut => VmError::TimedOut {
                timeout_ms: limits.wall_clock_timeout_ms,
            },
        };
    }

    let detail = match err {
        CaughtError::Exception(exc) => {
            let msg = exc.message().unwrap_or_default();
            let stack = exc.stack().unwrap_or_default();
            if msg.is_empty() && !stack.is_empty() {
                stack
            } else if msg.is_empty() {
                format!("{exc:?}")
            } else {
                msg
            }
        }
        CaughtError::Value(val) => format!("{val:?}"),
        CaughtError::Error(qerr) => qerr.to_string(),
    };

    classify_error_detail(detail, limits, interrupt_cause)
}

pub(crate) fn map_qjs_error(
    err: QjsError,
    limits: &IsolateLimits,
    interrupt_cause: &Mutex<Option<InterruptCause>>,
) -> VmError {
    if let Some(cause) = *interrupt_cause.lock() {
        return match cause {
            InterruptCause::Cancelled => VmError::Cancelled,
            InterruptCause::TimedOut => VmError::TimedOut {
                timeout_ms: limits.wall_clock_timeout_ms,
            },
        };
    }
    classify_error_detail(err.to_string(), limits, interrupt_cause)
}

fn classify_error_detail(
    detail: String,
    limits: &IsolateLimits,
    interrupt_cause: &Mutex<Option<InterruptCause>>,
) -> VmError {
    if let Some(cause) = *interrupt_cause.lock() {
        return match cause {
            InterruptCause::Cancelled => VmError::Cancelled,
            InterruptCause::TimedOut => VmError::TimedOut {
                timeout_ms: limits.wall_clock_timeout_ms,
            },
        };
    }
    let lower = detail.to_ascii_lowercase();
    if lower.contains("out of memory") || lower.contains("memory limit") {
        return VmError::OutOfMemory {
            limit_bytes: limits.max_memory_bytes,
            detail,
        };
    }
    if lower.contains("interrupted") {
        return VmError::TimedOut {
            timeout_ms: limits.wall_clock_timeout_ms,
        };
    }
    VmError::Execution(detail)
}

/// Evaluates an isolated TypeScript/JavaScript ES module exporting `default` (function or value)
/// inside a fresh QuickJS runtime on a dedicated blocking OS thread.
pub async fn eval_isolated_module(
    source: &str,
    options: VmEvalOptions,
) -> Result<VmEvalResult, VmError> {
    let js = crate::transpile::strip_typescript(source, "isolated.ts").map_err(|issues| {
        VmError::Execution(
            issues
                .into_iter()
                .map(|i| format!("{}: {}", i.path, i.message))
                .collect::<Vec<_>>()
                .join("; "),
        )
    })?;

    tokio::task::spawn_blocking(move || {
        let local_rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| VmError::Execution(format!("failed building isolate runtime: {e}")))?;

        local_rt.block_on(async move {
            let prepared = create_isolated_runtime(
                &options.limits,
                "imports are not available in isolated scripts",
                options.cancel_token.as_ref(),
            )
            .await?;

            let json_str: String = AsyncContext::async_with(&prepared.ctx, async |ctx| {
                install_realm_seal(
                    &ctx,
                    Arc::clone(&prepared.console),
                    options.determinism,
                    options.limits.freeze_intrinsics,
                    &[],
                )
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, &options.limits, &prepared.interrupt_cause))?;

                let runner_src = r#"
                    (async (modNs) => {
                      const def = modNs.default;
                      const out = typeof def === "function" ? await def() : def;
                      const serialized = JSON.stringify(out === undefined ? null : out);
                      if (typeof serialized !== "string") {
                        throw new Error("return value must be JSON data");
                      }
                      return serialized;
                    })
                "#;
                let runner: Function<'_> =
                    ctx.eval(runner_src.as_bytes()).catch(&ctx).map_err(|e| {
                        extract_caught_error(e, &options.limits, &prepared.interrupt_cause)
                    })?;

                let declared = Module::declare(ctx.clone(), "isolated.js", js)
                    .catch(&ctx)
                    .map_err(|e| {
                        extract_caught_error(e, &options.limits, &prepared.interrupt_cause)
                    })?;
                let (evaluated, eval_promise) = declared.eval().catch(&ctx).map_err(|e| {
                    extract_caught_error(e, &options.limits, &prepared.interrupt_cause)
                })?;
                eval_promise
                    .into_future::<()>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| {
                        extract_caught_error(e, &options.limits, &prepared.interrupt_cause)
                    })?;

                let ns = evaluated.namespace().catch(&ctx).map_err(|e| {
                    extract_caught_error(e, &options.limits, &prepared.interrupt_cause)
                })?;
                let out_promise: rquickjs::Promise<'_> =
                    runner.call((ns,)).catch(&ctx).map_err(|e| {
                        extract_caught_error(e, &options.limits, &prepared.interrupt_cause)
                    })?;
                out_promise
                    .into_future::<String>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| {
                        extract_caught_error(e, &options.limits, &prepared.interrupt_cause)
                    })
            })
            .await?;

            prepared.rt.idle().await;
            let parsed: Value = serde_json::from_str(&json_str)
                .map_err(|e| VmError::Execution(format!("invalid JSON return value: {e}")))?;
            let (logs, logs_truncated) = {
                let guard = prepared.console.lock();
                (guard.lines.clone(), guard.truncated)
            };
            Ok(VmEvalResult {
                value: parsed,
                logs,
                logs_truncated,
            })
        })
    })
    .await
    .map_err(|e| VmError::Execution(format!("isolate thread panicked: {e}")))?
}
