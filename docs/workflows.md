# Workflows

Deterministic multi-agent orchestration. The agent authors a small script; the
harness runs it in a sandbox and drives child agents from it.

Gated by the `workflows` feature flag (`COWORK_ENABLE_WORKFLOWS=1`, default off).

## Why

Cowork already exposes `spawnAgent` / `waitForAgent`, so the model *can* already
orchestrate. The cost is that the orchestration is LLM tokens: every fan-out,
every wait, every retry is emitted into the parent's context window, one tool call
at a time, with no determinism and no replay.

A workflow moves that control flow into code:

| | `spawnAgent` + `waitForAgent` | `workflow` |
|---|---|---|
| Control flow | model tokens, in the parent's context | JavaScript, off-context |
| 50-agent fan-out | 50+ tool calls to emit and track | one tool call |
| Agent results | free text | JSON-Schema validated, with one repair turn |
| Re-running after a failure | everything again | unchanged prefix replays from journal |

For a single delegated task, `spawnAgent` remains the right tool.

## Script shape

Exactly two exports, zero imports:

```ts
export const meta = {
  name: "triage-flaky-tests",
  description: "Cluster flaky tests and propose fixes.",
  phases: ["collect", "diagnose"],
};

export default async function run({ agent, parallel, pipeline, phase, log, args, budget }) {
  phase("collect");
  const inventory = await agent("List failing tests under test/.", {
    label: "inventory",
    agentType: "explorer",
    schema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" } } },
      required: ["files"],
      additionalProperties: false,
    },
  });

  phase("diagnose");
  const diagnoses = await parallel(
    inventory.files.map((file) => () =>
      agent(`Diagnose flakiness in ${file}.`, { label: `diagnose:${file}`, effort: "low" })),
  );

  return { diagnosed: compact(diagnoses).length };
}
```

Host functions arrive as the **destructured argument to the default export**, not
as ambient globals. That is deliberate: it documents the contract in the source
the model writes, and it makes "`meta` must be a pure literal" structural — the
host functions do not exist yet during module evaluation, so `meta` cannot
reference them.

## API

| Function | Notes |
|---|---|
| `agent(prompt, opts?)` | One child agent. Returns final text, or a validated object when `opts.schema` is set. Prompts are limited to 20,000 characters. |
| `parallel(thunks)` | **Barrier** — awaits every thunk. A rejected thunk yields `null`. |
| `pipeline(items, ...stages)` | Per-item stages with **no barrier between them**. Stages receive `(prev, originalItem, index)`. |
| `judge(candidate, opts)` | `n` independent judges; `aggregate` is `majority`/`unanimous`/`meanScore`/`worst`. |
| `compact(items)` | Drops nulls. |
| `phase(title)` / `log(msg)` | Progress. Titles must appear in `meta.phases`. |
| `args`, `budget` | Frozen tool input; `{ total, spent(), remaining() }` in USD. `total` is the session hard-cap amount still available when the run starts. |

`agent()` options: `label`, `phase`, `schema` (JSON Schema literal), `model`,
`effort`, `agentType` (role id or profile ref), `targetPaths`, `isolation`
(`"none"`/`"brief"`) + `briefing`, `onError` (`"fail"` default, or `"null"`),
`timeoutMs`.

When a session hard cap is configured, workflow agent admission is serialized. The current child is
allowed to finish, then no later child starts after cumulative session + workflow spend reaches the
cap. This matches the session budget contract: it stops accepting new turns rather than interrupting
an already-running model request whose final cost is not yet known.

Prefer `pipeline` over `parallel`. A barrier is only correct when a stage
genuinely needs every prior result at once — deduping across the whole set, or an
early exit on zero results.

Do not concatenate full raw outputs from a broad fan-out into a single downstream
`agent()` prompt. Ask upstream agents for compact structured results, reduce results
in bounded batches, or return them for the parent to synthesize. Dynamic prompts
must remain below the 20,000-character limit.

## Execution model

The script is untrusted input, so it runs behind two boundaries:

- **`node:vm` context — authority.** A fresh realm has no ambient capabilities and
  confines the function-constructor chain. Inside it,
  `[].constructor.constructor("return typeof Bun")()` evaluates to `"undefined"`.
  This matters because `bash` is sandboxed by default
  (`DEFAULT_SANDBOX_CONFIG.mode = "workspace-write"`), so an unsandboxed script
  runner would grant *more* authority than the tool the model already has.
- **`Worker` thread — availability.** `vm` cannot interrupt `while(true){}`.
  Without a separate thread one such script would freeze the whole server. Worker
  startup is 13–16 ms against agent calls measured in seconds.

The realm is sealed with an **allowlist**, not a denylist. A fresh Bun vm realm
ships `ShadowRealm`, `WebAssembly`, `Atomics`, `SharedArrayBuffer`, `WeakRef`,
`FinalizationRegistry`, `Intl` and `eval`, and that set grows with each engine
release. Two of those are not cosmetic:

- `new ShadowRealm()` inside a vm context **panics the Bun process** — exit code 3,
  not a catchable exception. `terminate()` cannot save the host from that.
- `Intl` is an independent clock, and `WeakRef`/`FinalizationRegistry` expose GC
  ordering. Both silently poison journal replay.

`Date.now()`, zero-argument `new Date()` and `Math.random()` throw, because
nondeterminism makes resume unsound. `new Date(0)` and the rest of `Math` work.
Trapping `Date` alone is insufficient — `Date.prototype.constructor` is trapped
too, or `new (new Date(0).constructor)()` reads the wall clock straight through.

`test/workflows/sandbox.escape.test.ts` pins this surface so a Bun upgrade that
reopens the realm fails CI rather than the journal.

## Concurrency

`AgentControl` caps a parent at `MAX_ACTIVE_CHILDREN_PER_PARENT = 16`, counting
only children in `running` or `pending_init` — a finished but still-open child
does not hold a slot. Workflows self-throttle to
`WORKFLOW_MAX_INFLIGHT_AGENTS = 12`, deliberately below the cap, because the
parent turn can call `spawnAgent` directly while a workflow runs and those spawns
compete for the same slots.

Child agents receive no `agentControl`, so a workflow's children cannot themselves
run workflows. `workflow(label, fn)` inside a script is a labelled scope for
progress and journaling, not a nested run.

## Journal and resume

Each run appends to
`<projectCoworkDir>/workflows/runs/<runId>/journal.jsonl`, one entry per `agent()`
call. Passing `resumeFromRunId` replays every call the prior run already made:
a call is served from cache when it is the **byte-for-byte same request**, and
each recorded result is handed out at most once (so a script that legitimately
issues the same call twice consumes two entries, not one twice).

The digest covers the prompt, the options, and a hash of `args`. Two things are
deliberately excluded:

- **The script source hash** — including it would make any edit invalidate the
  whole journal, defeating the purpose: resume exists so that fixing a late stage
  does not re-pay for the early ones.
- **The call index** — `pipeline()` has no barrier between stages, so the order in
  which calls reach the host depends on how long each agent happened to take. An
  index-keyed cache would match nothing on a rerun whose timings shifted, which is
  precisely the control flow workflows exist for.

Content-addressing is also the stricter rule. If a later call genuinely depended
on an earlier one's output, that output appears in its prompt, so editing the
earlier call changes the later call's digest and it correctly re-runs.

`.cowork/` is gitignored and sits in `PROTECTED_METADATA_DIR_NAMES`, so child
agents cannot forge a cached result. That does not hold under
`--yolo`/`danger-full-access`, where the sandbox grants full access.

## Failure semantics

- `onError` defaults to `"fail"`: the `agent()` promise rejects and the error
  reaches the script. Set `"null"` to opt into null-coalescing per call.
- A child whose session **errored** rejects rather than returning its last text.
  `StatusBus` treats `errored` as terminal, so a naive `wait()` reports success for
  a crashed child; the runner checks `executionState` before reading the text.
- Task-lock errors and turn cancellation abort the entire run regardless of
  `onError` — otherwise a 300-way fan-out degrades into 300 silent nulls.
- A compile failure is returned as a **value** (`{ ok: false, issues }`), not
  thrown, so the model repairs the script in-context at zero spend.

## Dry run

`dryRun: true` executes the script with `agent()` stubbed and nothing spawned.
Because scripts are deterministic by construction, this yields the exact call
graph, fan-out count and phase list before any spend. Dry-run progress is not
emitted into session snapshots or displayed in workflow history.
