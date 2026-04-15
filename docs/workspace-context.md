# Workspace Context

This document explains the workspace terms that are rendered into runtime prompts.

The short version: the static prompt should only describe layering at a high level. Exact absolute paths belong to the runtime-supplied `## Active Workspace Context` section.

## Core Terms

| Term | Meaning |
| --- | --- |
| `workspaceRoot` | The directory that contains the project `.agent/` directory. This is the anchor for project-level config, memory, and MCP overrides. |
| `workingDirectory` | The execution working directory for the current turn. The runtime prompt labels this as `Execution working directory`, and file tools plus shell defaults use it. |
| `gitRoot` | The nearest ancestor of `workingDirectory` that contains `.git`, when one exists. It may be the same as `workspaceRoot`, above it, or unrelated when the execution directory is outside the workspace tree. |

`workingDirectory` is intentionally not the same thing as `workspaceRoot`. A session can run inside a subdirectory of the workspace, or even outside the workspace root, while still keeping project-level `.agent/` data anchored at `workspaceRoot`.

## Runtime Source Of Truth

`## Active Workspace Context` is the source of truth for the exact absolute paths in the current turn. It renders:

- workspace root
- execution working directory
- optional git root
- working-directory relation to the workspace root
- optional output directory
- effective uploads directory
- project `.agent/` override root

If a contributor needs to know which absolute path the model will see, check this runtime section and the code that renders it, not the static prompt template.

## AGENTS.md Versus .agent/AGENT.md

These names are similar, but they serve different systems.

- `AGENTS.md` and `AGENTS.override.md` are hierarchical project instructions. They are loaded from the repository hierarchy and rendered into `## Project Instructions`.
- `.agent/AGENT.md` is project hot-cache memory. It is loaded by the memory system and is separate from hierarchical project instructions.
- `AGENTS.override.md` wins over `AGENTS.md` within the same directory.
- Project and user `AGENT.md` files participate in memory fallback, not in AGENTS hierarchy traversal.

In practice, a runtime prompt can include both project instructions and hot-cache memory, but they come from different loaders and should not be described interchangeably.

## Workspace Map Is Bounded Context

`## Workspace Map` is a bounded startup snapshot for orientation. It helps the model see the workspace root, execution directory, and git root without reading the whole tree up front.

It is not the filesystem source of truth:

- it is intentionally bounded and may omit files or directories
- it reflects startup-time context, not every later filesystem change
- it should not be used to infer exact absolute paths

When exact path semantics matter, trust `## Active Workspace Context` plus normal file reads/searches over the workspace map.

## Practical Guidance

- Use `workspaceRoot` when reasoning about project-level `.agent/` overrides.
- Use `workingDirectory` when reasoning about where tool calls execute by default.
- Use `gitRoot` when reasoning about repository scope and AGENTS hierarchy traversal.
- Keep static prompt wording high-level so runtime context, not baked-in Cowork internals, provides the exact path details.

## Related Sources

- [`src/workspace/context.ts`](../src/workspace/context.ts)
- [`src/prompt.ts`](../src/prompt.ts)
- [`src/projectInstructions.ts`](../src/projectInstructions.ts)
- [`docs/harness/config.md`](./harness/config.md)
