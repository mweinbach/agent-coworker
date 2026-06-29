# Harness Config Reference

This document describes how the harness resolves configuration in [`src/config.ts`](../../src/config.ts).

## Precedence

Configuration resolves in this order:

1. Environment variables
2. Project config: `.cowork/config.json`
3. User config: `~/.cowork/config/config.json`
4. Built-in defaults: `config/defaults.json`

Notes:

- `AGENT_WORKING_DIR` is environment-only.
- `outputDirectory` and `uploadsDirectory` are resolved relative to the repo `cwd`, not relative to `workingDirectory`.
- `runtime` is normalized per provider. Unsupported saved runtime values are coerced back to the provider-supported runtime.

## Core Selection

- `AGENT_PROVIDER` or `provider`
- `AGENT_RUNTIME` or `runtime`
- `AGENT_MODEL` or `model`
- `AGENT_WORKING_DIR`
- `AGENT_OUTPUT_DIR` or `outputDirectory`
- `AGENT_UPLOADS_DIR` or `uploadsDirectory`

## Session And Runtime Behavior

- `AGENT_USER_NAME` or `userName`
- `userProfile.instructions`
- `userProfile.work`
- `userProfile.details`
- `AGENT_ENABLE_MCP` or `enableMcp`
- `AGENT_ENABLE_MEMORY` or `enableMemory`
- `AGENT_MEMORY_REQUIRE_APPROVAL` or `memoryRequireApproval`
- `AGENT_INCLUDE_RAW_CHUNKS` or `includeRawChunks`
- `AGENT_BACKUPS_ENABLED` or `backupsEnabled` (defaults to `false`; enables advanced backup APIs)
- `AGENT_MODEL_MAX_RETRIES` or `modelSettings.maxRetries`
- `toolOutputOverflowChars`
- `providerOptions`
- `command`

Backups are opt-in and are not part of the default chat hot path. For git workspaces, prefer git-native checkpointing with `git diff`, `git stash`, and `git worktree`. Enable `backupsEnabled` only when a workspace needs Cowork-managed manual recovery snapshots, such as non-git projects.

## Child-Agent Routing

These settings are config-file driven today:

- `childModelRoutingMode`
- `preferredChildModel`
- `preferredChildModelRef`
- `allowedChildModelRefs`

Invalid child-routing config is ignored with a warning and the harness falls back to the current provider/model defaults.

## Observability

- `AGENT_OBSERVABILITY_ENABLED`
- top-level `observabilityEnabled`
- `AGENT_OBSERVABILITY_RECORD_INPUTS` or `observability.recordInputs`
- `AGENT_OBSERVABILITY_RECORD_OUTPUTS` or `observability.recordOutputs`
- `AGENT_OBSERVABILITY_RECORD_PAYLOADS` as shorthand for both payload flags
- `LANGFUSE_PUBLIC_KEY` or `observability.publicKey`
- `LANGFUSE_SECRET_KEY` or `observability.secretKey`
- `LANGFUSE_BASE_URL` or `observability.baseUrl`
- `LANGFUSE_TRACING_ENVIRONMENT` or `observability.tracingEnvironment`
- `LANGFUSE_RELEASE` or `observability.release`

`otelEndpoint` is derived from the resolved base URL as:

- `<baseUrl>/api/public/otel/v1/traces`

See [`observability.md`](./observability.md) for runtime behavior and health reporting.

## Harness Flags

- `AGENT_HARNESS_REPORT_ONLY` or `harness.reportOnly`
- `AGENT_HARNESS_STRICT_MODE` or `harness.strictMode`

These values are parsed into `config.harness` and are primarily used by raw-loop workflows.

- `reportOnly` marks the run as harness/report mode in emitted metadata and artifacts.
- `strictMode` enables strict raw-loop outcome validation:
  - the final response must satisfy the scenario contract
  - required artifacts must validate
  - missing/malformed final contracts fail without a repair pass

The session runtime path does not currently enforce raw-loop strict validation semantics directly, but raw-loop runs now respect the resolved config/env value unless a CLI override is supplied.

## Built-In Resource Resolution

- `COWORK_BUILTIN_DIR`
  - Overrides the built-in resource root used to find prompts, config, and bundled skills
- `COWORK_DISABLE_BUILTIN_SKILLS`
  - Removes the built-in `skills/` directory from the resolved skill search path

## Feature Flags

Feature flags are defined in `src/shared/featureFlags.ts` and resolved by `resolveFeatureFlags({ isPackaged, env, overrides })`. Resolution order is: build-time default (`defaultEnabled`) → env override → experimental-env gate → locally persisted override → packaged `forced-off`.

- **Production builds ignore locally flipped overrides.** When `isPackaged` is true (packaged Electron app; surfaced to the server as `COWORK_IS_PACKAGED=true`), the persisted/config override layer is skipped entirely. Every flag resolves to its build-time default plus any env override. A flag flipped in development (via the dev-only Feature Flags settings page) therefore never leaks into a production build on the same machine. To change a flag's production value, change its compiled `defaultEnabled`.
- `tasks` / `COWORK_ENABLE_TASKS` — gates the durable Tasks feature: the desktop Tasks UI, the model's `createTask` tool, and the `task/*` JSON-RPC routes. Defaults **off**; `restartRequired` (the desktop passes the resolved value to its sidecar server via env at spawn). `config.tasksEnabled` is the resolved boolean read by `resolveTasksFeatureEnabled` (`src/server/tasks/flags.ts`). Enable in development with `COWORK_ENABLE_TASKS=1` or the desktop toggle.
