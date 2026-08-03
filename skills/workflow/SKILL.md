---
name: workflow
description: Author and run a deterministic multi-agent workflow — a JavaScript script that fans out, pipelines, loops, and judges across many child agents. Use when the work decomposes into many similar units (review every changed file, research N topics, migrate M call sites), when it needs adversarial verification or a judge panel, or when the user asks to "use a workflow", "fan out agents", or be exhaustive. Do not use for a single delegated task — spawnAgent is cheaper.
---

# Workflows

A workflow is a script you write that orchestrates child agents in real code. The
harness runs it in a sandbox and drives `AgentControl` from it.

## When this is worth it

Reach for a workflow when the work is **wide** (many similar units) or needs
**structure** (verify each finding independently, judge N candidates, loop until
nothing new turns up). One `workflow` call replaces dozens of `spawnAgent` /
`waitForAgent` calls and keeps their transcripts out of your context.

Do **not** use it for a single delegated task. `spawnAgent` is one call and has no
sandbox to reason about.

## Reusable workflows

Call `{ action: "list" }` to discover bundled and saved workflows. Run one by name:

```json
{
  "name": "deep-research",
  "args": {
    "query": "Compare two migration approaches",
    "model": "provider:model-id",
    "verificationModel": "provider:stronger-model-id"
  }
}
```

Save a validated definition for the current project or every project:

```json
{
  "action": "save",
  "name": "review-changes",
  "scope": "project",
  "script": "export const meta = ..."
}
```

Project workflows live in `.cowork/workflows/`; global workflows live in
`~/.cowork/workflows/`; bundled workflows ship with Cowork. Resolution order is
project, global, bundled. A name is lowercase kebab-case and must match
`meta.name`. Saving compiles and inspects metadata but does not run child agents.
Existing files require an explicit `overwrite: true`.

The bundled `deep-research` workflow plans bounded questions, gathers structured
source-backed claims, independently verifies every claim, and synthesizes only
claims that survive. It reports failed shards, dropped claims, and uncertainties
as coverage limitations and marks the result partial when coverage is incomplete.
Use `args.model` for the default child model, with optional `plannerModel`,
`researchModel`, `verificationModel`, and `synthesisModel` phase overrides.

## The contract

Two exports, zero imports. Host functions arrive as the argument to the default
export:

```ts
export const meta = {
  name: "review-diff",
  description: "Review each changed file, then verify every finding.",
  phases: ["review", "verify"],
};

export default async function run({ agent, parallel, pipeline, phase, log, args, budget }) {
  phase("review");
  const findings = await pipeline(
    args.files,
    (file) => agent(`Review ${file} for correctness bugs.`, {
      label: `review:${file}`, phase: "review", agentType: "explorer",
      schema: {
        type: "object",
        properties: {
          bugs: {
            type: "array",
            items: {
              type: "object",
              properties: { line: { type: "number" }, claim: { type: "string" } },
              required: ["line", "claim"], additionalProperties: false,
            },
          },
        },
        required: ["bugs"], additionalProperties: false,
      },
    }),
    (review, file) => parallel(review.bugs.map((bug) => () =>
      agent(`Try to REFUTE this claim about ${file}:${bug.line}: ${bug.claim}`, {
        label: `verify:${file}:${bug.line}`, phase: "verify", onError: "null",
        schema: {
          type: "object",
          properties: { refuted: { type: "boolean" }, why: { type: "string" } },
          required: ["refuted", "why"], additionalProperties: false,
        },
      }).then((verdict) => ({ ...bug, file, verdict })))),
  );

  const real = compact(findings.flat()).filter((f) => f.verdict && !f.verdict.refuted);
  log(`${real.length} findings survived verification`);
  return { findings: real };
}
```

## API

| | |
|---|---|
| `agent(prompt, opts?)` | One child agent. Returns final text, or a validated object when `opts.schema` is set. |
| `parallel(thunks)` | **Barrier** — awaits all. A rejected thunk yields `null`. |
| `pipeline(items, ...stages)` | Per-item stages, **no barrier between them**. Stages get `(prev, originalItem, index)`. |
| `judge(candidate, opts)` | `n` independent judges; `aggregate`: `majority`/`unanimous`/`meanScore`/`worst`. |
| `compact(items)` | Drop nulls. |
| `phase(title)`, `log(msg)` | Progress. Titles must be in `meta.phases`. |
| `args`, `budget` | Frozen tool input; `{ total, spent(), remaining() }` in USD. |

`agent()` options: `label`, `phase`, `schema`, `model`, `effort`, `agentType`
(`default`/`explorer`/`research`/`worker`/`reviewer`, or a profile ref),
`targetPaths`, `isolation` + `briefing`, `onError`, `timeoutMs`.

## Default to pipeline, not parallel

`pipeline` has no barrier between stages: item 2 can reach stage 3 while item 5 is
still in stage 1. Wall-clock is the slowest single chain, not the sum of per-stage
maxima.

A barrier is only correct when a stage genuinely needs **every** prior result at
once — deduping across the whole set, or exiting early when the total is zero. It
is *not* justified by "I need to flatten first" (do that inside a stage) or "the
stages feel separate" (that is what pipeline models).

If you write `const a = await parallel(...); const b = a.flat(); await parallel(b...)`
and the middle line has no cross-item dependency, it should have been a pipeline.

## Patterns worth knowing

**Adversarial verify.** Ask verifiers to *refute*, not to confirm. Kill a finding
when a majority refute it. This is what stops plausible-but-wrong results.

**Perspective-diverse verify.** When something can fail in more than one way, give
each verifier a distinct lens (correctness, security, performance, does-it-repro)
instead of N identical ones. Diversity catches what redundancy cannot.

**Judge panel.** Generate N independent attempts from different angles, score them,
then synthesize from the winner while grafting the best ideas from the rest. Beats
one-attempt-iterated when the solution space is wide.

**Loop-until-dry.** For unknown-size discovery, keep going until K consecutive
rounds surface nothing new. Dedupe against everything *seen*, not against what was
*confirmed* — otherwise rejected items reappear every round and it never converges.

```ts
const seen = new Set(); const confirmed = []; let dry = 0;
while (dry < 2) {
  const fresh = compact(await parallel(FINDERS.map((f) => () => agent(f))))
    .flatMap((r) => r.items).filter((i) => !seen.has(key(i)));
  if (!fresh.length) { dry++; continue; }
  dry = 0; fresh.forEach((i) => seen.add(key(i)));
  confirmed.push(...fresh);
}
```

**Budget-scaled depth.** `while (budget.total && budget.remaining() > 50_000) { ... }`.
Guard on `budget.total` — with no ceiling set, `remaining()` is `Infinity`.

**No silent caps.** If you bound coverage (top-N, sampling, no retry), `log()` what
was dropped. Silent truncation reads as "covered everything" when it did not.

## Rules the sandbox enforces

- **No imports, no require, no eval.** Everything is the default export's argument.
- **`meta` must be a pure literal** — no variables, calls, or interpolation.
- **`Date.now()`, `new Date()` and `Math.random()` throw.** They would break run
  resume. `new Date(0)` and the rest of `Math` work. Derive variation from `args`
  or the stage index instead.
- **`onError` defaults to `"fail"`** — the promise rejects and you handle it. Use
  `"null"` to opt into null-coalescing, then `compact()`.

## Iterating

A script that does not compile comes back as `{ ok: false, issues }` — fix it and
call again, no spend. Use `dryRun: true` to see the whole call graph and fan-out
count before spending anything.

Use `action: "save"` after the definition compiles. Saved definitions are reusable
by name, while an inline `{ script }` remains best for one-off orchestration.

If a run fails partway, pass `resumeFromRunId` with the previous run id: every call
that is byte-for-byte identical replays from the journal for free, and only what
actually changed re-runs.

## Scale to the ask

"Find any bugs" → a few finders, single-vote verify. "Audit this thoroughly" or
"be comprehensive" → a larger finder pool, 3–5 vote adversarial verification, and a
synthesis stage. Lean toward thoroughness for review/audit/research, and toward
brevity for quick checks.
