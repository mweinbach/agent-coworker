# Harness Config Reference

This document describes how the harness resolves configuration in [`src/config.ts`](../../src/config.ts).

## Precedence

Configuration resolves in this order:

1. Environment variables
2. Project config: `.agent/config.json`
3. User config: `~/.agent/config.json`
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
- `cloud.targetMode`
- `cloud.controlPlaneHost`
- `cloud.executionBackend`
- `cloud.sandboxProvider`
- `AGENT_ENABLE_MCP` or `enableMcp`
- `AGENT_ENABLE_MEMORY` or `enableMemory`
- `AGENT_MEMORY_REQUIRE_APPROVAL` or `memoryRequireApproval`
- `AGENT_INCLUDE_RAW_CHUNKS` or `includeRawChunks`
- `AGENT_BACKUPS_ENABLED` or `backupsEnabled`
- `AGENT_MODEL_MAX_RETRIES` or `modelSettings.maxRetries`
- `toolOutputOverflowChars`
- `providerOptions`
- `command`

## Cloud Deployment Defaults

Cowork now carries an explicit cloud deployment preference block in config so hosted operators and future clients can discover the intended rollout shape without reading source code.

Supported config keys:

- `cloud.targetMode`
  - `hosted-single-tenant`
  - `sandboxed-multi-tenant`
- `cloud.controlPlaneHost`
  - `fly-machines`
  - `railway`
  - `render`
- `cloud.executionBackend`
  - `local`
  - `sandbox`
- `cloud.sandboxProvider`
  - `e2b`
  - `vercel-sandbox`
  - `modal`

Current built-in defaults resolve to:

- `targetMode: hosted-single-tenant`
- `controlPlaneHost: fly-machines`
- `executionBackend: local`
- `sandboxProvider: e2b`

Interpretation:

- The first production milestone is a hosted single-tenant control plane.
- Fly Machines is the preferred control-plane home because it can host the long-lived Bun WebSocket server directly.
- Tool execution still defaults to `local` because the current server process remains the execution host until a sandbox backend is selected.
- `e2b` is the first sandbox prototype target once shell/filesystem execution moves out of the control plane.

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
