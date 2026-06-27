---
name: task
description: Promote substantial, multi-step work from ordinary chat into durable task mode. Use when the user explicitly invokes /task or asks to create/start a task, or when an objective needs a persistent plan, progress tracking, artifacts, decisions, review, or work that may span sessions. Do not use for quick answers, simple one-step edits, or work that can be completed naturally in the current chat.
---

# Task Mode

Task mode is a one-way handoff from the current chat to a managed task. A successful `createTask` call replaces the chat with the task workspace and locks the source chat until the task reaches `completed`, `failed`, or `cancelled`.

## Decide whether to create a task

Create a task when either condition applies:

- The user explicitly invokes this skill, `/task`, or directly asks to create a task.
- The work is substantial enough to benefit from a durable brief, dependency-aware plan, progress state, artifacts, or later resumption.

Stay in standard chat for quick questions, exploratory conversation without a concrete objective, or small work that does not need managed state. Do not promote merely because a request has several sentences.

## Gather enough detail

Before calling `createTask`, make sure the conversation establishes:

- A concise title and concrete objective.
- Relevant background, current state, and constraints for the handoff.
- Fixed requirements and at least one observable acceptance criterion.
- A complete initial work plan with stable local keys, dependencies, and expected outputs.
- Material decisions already made, including any reasonable reversible assumptions.
- Whether the final result needs user review; default to review when uncertain.

Infer implementation details and reversible defaults yourself. Ask the user only when missing information would materially change scope, risk, or the delivered result. Bundle missing questions into one concise request. If the user supplied enough detail, do not ask for confirmation before creating the task.

## Build the initial plan

The plan must cover the whole known objective, not just the first action. Use short unique keys such as `research`, `implement`, and `verify`. Put prerequisite keys in `dependsOn`. List concrete deliverables in `expectedOutputs`; at least one work item must have an expected output.

Separate requirements by kind:

- `requirement`: requested behavior or deliverable.
- `constraint`: boundaries such as compatibility, safety, deadline, or allowed systems.
- `acceptance_criterion`: observable evidence that the task is done. At least one is required.

Record agent-made assumptions as decisions with appropriate confidence. Use a stable idempotency key for this handoff so retries cannot create duplicate tasks.

## Perform the handoff

Call `createTask` exactly once with the complete brief and plan. The tool validates graph integrity and creates the durable task in `working` state.

After a successful call, stop immediately. Do not call another tool, continue the original work, or emit a follow-up chat response. Task mode owns all subsequent execution and delivery.

If creation fails validation, correct the input and retry only when the error clearly indicates that no task was created. Never create a second task to work around an uncertain result; reuse the same idempotency key.

$ARGUMENTS
