/**
 * The script-authoring contract, injected into the `workflow` tool description.
 *
 * Ships as a TS constant rather than a `prompts/` file on purpose: `createTools`
 * is synchronous (`src/tools/index.ts:136`) and `defineTool` takes a plain string
 * (`src/tools/defineTool.ts:7-9`), so there is no point in the tool factory where
 * a file could be awaited. Same shape as `TASK_REVIEW_DESCRIPTION`.
 */
export const WORKFLOW_TOOL_DESCRIPTION = `Run a deterministic multi-agent workflow from a script you author.

Use this when orchestration should be REAL CODE rather than your own turn-by-turn tool calls: fanning out over a list, running a pipeline of stages, looping until a condition holds, or spawning more agents than you want to track by hand. The script runs in a sandbox off your context window, so a 50-agent fan-out costs you one tool call instead of 50.

For a single delegated task, use spawnAgent instead — a workflow is overhead you do not need.

## Script shape

A workflow script is a TypeScript module with exactly two exports and ZERO imports:

    export const meta = {
      name: "review-changes",
      description: "Review each changed file, then verify every finding.",
      phases: ["review", "verify"],
    };

    export default async function run({ agent, parallel, pipeline, phase, log, args, budget }) {
      phase("review");
      const files = args.files;

      const findings = await pipeline(
        files,
        (file) => agent(\`Review \${file} for correctness bugs.\`, {
          label: \`review:\${file}\`, phase: "review", agentType: "explorer",
          schema: {
            type: "object",
            properties: { bugs: { type: "array", items: { type: "string" } } },
            required: ["bugs"], additionalProperties: false,
          },
        }),
        (review, file) => agent(\`Verify these bugs in \${file}: \${review.bugs.join("; ")}\`, {
          label: \`verify:\${file}\`, phase: "verify", onError: "null",
        }),
      );

      log(\`checked \${files.length} files\`);
      return { verified: compact(findings) };
    }

## API

- \`agent(prompt, opts?)\` — run one child agent. Returns its final text, or a validated
  object when \`opts.schema\` is set. Options: \`label\`, \`phase\`, \`schema\` (a JSON Schema
  literal), \`model\`, \`effort\`, \`agentType\` (a role: default/explorer/research/worker/reviewer,
  or a profile ref), \`targetPaths\`, \`isolation\` ("none" | "brief") + \`briefing\`,
  \`onError\` ("fail" — default — or "null"), \`timeoutMs\`. The prompt is limited to
  20,000 characters.
- \`parallel(thunks)\` — BARRIER: awaits every thunk. A rejected thunk becomes null.
- \`pipeline(items, ...stages)\` — per-item staged execution with NO barrier between stages:
  item 2 can reach stage 3 while item 5 is still in stage 1. Prefer this over parallel().
  Each stage receives \`(previousResult, originalItem, index)\`.
- \`judge(candidate, { n, rubric, aggregate })\` — n independent judges, aggregated by
  "majority" | "unanimous" | "meanScore" | "worst".
- \`compact(items)\` — drop nulls left by failed agents.
- \`phase(title)\` / \`log(message)\` — progress. Titles must be members of \`meta.phases\`.
- \`args\` — the \`args\` tool input, frozen. \`budget\` — \`{ total, spent(), remaining() }\` in USD,
  where \`total\` is the session hard-cap amount still available when the workflow starts. A configured
  hard cap serializes agent admission so later calls stop after the threshold is crossed.

## Rules

- No imports, no require, no eval. Everything you need is the argument to the default export.
- \`meta\` must be a pure literal — no variables, calls, or template interpolation.
- \`Date.now()\`, \`new Date()\` and \`Math.random()\` throw: they would break run resume.
  \`new Date(0)\` and the rest of Math work fine.
- Prefer \`pipeline\` over \`parallel\`. Only use a barrier when a stage genuinely needs
  every prior result at once (dedup across the whole set, an early exit on zero results).
- Never concatenate full raw outputs from a wide fan-out into one later \`agent()\` prompt.
  Request compact structured results, reduce them in bounded batches, or return them for the
  parent to synthesize; every dynamically constructed prompt must stay under 20,000 characters.
- Return a compact summary. Do not return raw agent transcripts.`;
