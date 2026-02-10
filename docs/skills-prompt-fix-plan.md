# Prompt + Skill Tool Reliability Fix Plan

## Why this plan

Recent evaluation runs show repeatable failures that are mostly integration issues (prompt/tool contract mismatches) rather than isolated model mistakes:

1. Required skill calls are skipped when prompts request names like `spreadsheet`/`slides`/`doc`, while examples still emphasize `xlsx`/`pptx`/`docx`.
2. Strict output format requirements (JSON-only final) are not consistently enforced for all providers.
3. Bash approval wording can trigger unnecessary pre-approval asks in some models.
4. The prompt over-weights `todoWrite` as the first action and under-weights tool-sequencing obligations.

## Current-state findings in this repo

- The runtime already appends an "Available Skills" section from discovered skills (`discoverSkills`) and includes name/description/triggers in the system prompt at startup.
- Built-in skill directories are currently named `spreadsheet`, `slides`, `doc`, `pdf`.
- The skill tool description/examples currently mention `xlsx`/`pptx`/`docx`, which is inconsistent with built-in names.
- The skill tool currently loads only `SKILL.md` (or flat `*.md`) and does not automatically expose nearby `references/` and helper paths.

## Fix objectives

1. Make skill invocation deterministic across providers.
2. Keep the system prompt dynamic and source-of-truth from actual skill files.
3. Preserve strict output-format compliance when required by user instructions/harness.
4. Avoid unnecessary ask/approval loops around bash.

## Implementation plan

### Phase 1 — Normalize skill naming + routing (highest impact)

- Add a skill resolver used by both prompt rendering and the `skill` tool.
  - Canonical skill name: directory name (e.g. `spreadsheet`).
  - Aliases: from `TRIGGER(S)` and built-in compatibility aliases (`xlsx -> spreadsheet`, `pptx -> slides`, `docx -> doc`).
- Update `skill` tool input guidance to prefer canonical names but accept aliases.
- Return a clear resolution message in tool output when alias resolution occurs, e.g.:
  - `Resolved skill "xlsx" -> "spreadsheet"`.

**Acceptance checks**
- Prompt examples and tool schema do not conflict on names.
- `skill({ skillName: "spreadsheet" })` and `skill({ skillName: "xlsx" })` both succeed.

### Phase 2 — Inject richer dynamic skill metadata into system prompt

- Continue dynamic append of available skills, but change format to include:
  - canonical name
  - short description (prefer frontmatter `description`, else first heading)
  - aliases/triggers
  - explicit call example for each canonical name
- Remove hard-coded references to legacy names from `prompts/system.md` where possible.
- Add one explicit requirement block near tool instructions:
  - "If task mentions any alias/trigger, map to canonical skill and call `skill` before artifact creation."

**Acceptance checks**
- Prompt footer accurately reflects local skill files without manual edits.
- Evaluation prompts using `spreadsheet/slides/doc/pdf` trigger `skill` calls.

### Phase 3 — Skill payload should include references and implementation pointers

- Extend `skill` tool return payload to include structured context:
  - `skill`: full SKILL.md content
  - `references`: discovered files under `references/`, `scripts/`, `assets/`, and `agents/` (path index + optional excerpts)
  - `usageHints`: concise "how to use this skill" notes
- Keep response bounded (index first, lazy-load large references with `read`).
- Document this contract so model can quickly open relevant files.

**Acceptance checks**
- Calling `skill("spreadsheet")` reveals SKILL.md plus references index.
- Models can follow-up with `read` on listed reference files in deterministic order.

### Phase 4 — Strict output protocol guardrails

- Add explicit protocol clause in system prompt:
  - "If user/harness requires JSON-only final output, emit exactly one JSON object and nothing else."
- Add provider-side response validator/repair for strict modes:
  - detect non-JSON wrappers and auto-rewrite to raw JSON when required.
- Add regression tests covering Claude-style prose wrappers.

**Acceptance checks**
- Runs that demand JSON-only final responses return parsable JSON with no leading/trailing prose.

### Phase 5 — Bash approvals + todo prioritization language

- Reword bash section to avoid meta-approval asks:
  - "Call `bash` directly when needed; the host handles approval prompts."
- Tweak todo wording from "default first move" to "use for multi-step tasks, but do not delay required tool calls (e.g., `skill` before deliverable creation)."

**Acceptance checks**
- GPT-5-mini style "ask before bash" behavior drops.
- Required `pwd`/`ls` steps execute via bash tool with host approval flow.

## Test plan

1. Unit tests for alias resolution and canonical mapping in skills discovery/tool execution.
2. Prompt snapshot test to assert dynamic skill injection format includes aliases and canonical names.
3. Skill tool test verifying returned payload includes references index for built-in skills.
4. Provider-format tests for strict JSON final output behavior.
5. End-to-end harness replay on the 10 problematic prompts, measuring:
   - skill-call rate when required
   - JSON-only compliance rate
   - bash step completion rate

## Web research notes (implementation references)

- Anthropic tool-use docs emphasize clear tool schemas and explicit when-to-call guidance.
  - https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
- Anthropic system-prompt guidance recommends unambiguous protocol instructions and concise hierarchy.
  - https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts
- Gemini function-calling docs similarly stress accurate tool descriptions/examples for reliable calls.
  - https://ai.google.dev/gemini-api/docs/function-calling

(Direct OpenAI docs pages for function-calling/prompt-engineering returned HTTP 403 from this environment; use mirror-accessible docs in CI or local browser as needed.)

## Rollout strategy

- Ship Phase 1 + Phase 2 together (highest leverage, low risk).
- Add Phase 4 guardrails before next benchmark run to stabilize harness protocol compliance.
- Phase 3 can follow with careful token-budget constraints.
- Track metrics per model family (Gemini/GPT/Claude) to ensure fixes are not provider-specific.
