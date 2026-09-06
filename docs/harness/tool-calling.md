# Tool calling: PI, Codex, and optional envelopes

## Runtime ownership

PI supplies provider streaming. Cowork owns its step loop, tool validation,
execution, cancellation, and retry policy. PI is pinned to `0.85.1`; stream models
are prepared once per turn, and NVIDIA payload handling is request-local rather
than a process-wide `fetch` patch. Stream-consumer failures are not retried as
provider failures. A stable Cowork session ID is forwarded to PI when available.

PI cache retention is optional and provider-specific:

```json
{
  "providerOptions": {
    "anthropic": { "cacheRetention": "long" }
  }
}
```

Accepted values are `none`, `short`, and `long`. Omission preserves the SDK's
default; support and pricing remain provider-dependent. Cowork's custom Bedrock
adapter is separately owned, so an SDK upgrade does not automatically upgrade
that adapter.

Codex app-server owns a separate agent loop and its native execution tools.
Cowork supplies sandbox policy and services approval and dynamic-tool requests.
Native delegation is disabled so children continue through Cowork's lifecycle,
scope, and budget controls. A network ban explicitly disables native web search;
omitting web-search configuration is not a ban.

Codex-native execution tools remain **open by default**. Cowork built-in-tool
allowlists filter Cowork tools, not Codex's separate native tool registry. This
is intentional; no new default native allowlist is imposed. Sandbox policy,
network restrictions, and approval checks still apply. Use a Cowork-owned runtime
when exact built-in-tool allowlists are required.

The pinned `0.153.4` protocol does not support `networkAccess` on
`dangerFullAccess`. Cowork narrows a network-disabled full-access/YOLO turn to
`workspaceWrite` rather than sending an ignored field. Scratch roots are explicit,
with implicit `TMPDIR` and `/tmp` grants disabled.

## Optional portable primitives

Both settings default to `false`. Set them in user
`~/.cowork/config/config.json` or project `.cowork/config.json`; normal config
inheritance applies. They are configuration-file primitives, not new desktop
settings or JSON-RPC methods.

```json
{
  "toolCalling": {
    "codeMode": true,
    "deferredToolSearch": true
  }
}
```

- **`deferredToolSearch`** replaces eager Cowork tool schemas with stable
  `toolSearch({query, limit?, offset?})` and
  `toolCall({name, arguments})` envelopes. Search returns complete input schemas,
  defaults to five matches, and supports pagination and `*` browsing.
- **`codeMode`** adds `codeMode({code})`, where `code` is an async JavaScript
  function body. It can call `await tools.search(query)` and
  `await tools.call(name, arguments)`, then return JSON data. Code mode alone
  keeps direct tools available; enable deferred search too to reduce eager schemas.

Example code-mode body:

```js
const matches = await tools.search("read file");
return matches;
```

Tool names returned by search are not dynamically registered. Invoke them through
`toolCall`, or `tools.call` inside code mode. Existing MCP-only
`toolSearch`/`mcpCall` behavior remains unchanged when both options are off; it
uses the same generic catalog implementation.

### Authority and lifecycle

The catalog is assembled **after** provider ownership, agent-role, and profile
filtering. It cannot recover tools removed from a Codex turn, add child/root-only
capabilities, or activate an unapproved MCP server. MCP catalogs remain live and
leased while calls execute.

Each nested call validates its arguments using the tool's existing validation
contract, checks the actual tool name against the mutation gate, and retains the
original tool's approval behavior. Zod schemas are validated by the catalog;
JSON-Schema-backed tools retain transport/implementation-owned validation.
Unavailable, inherited, and recursive envelope names are rejected.

Code runs in a restricted VM realm on a Worker with source, output, time, call,
and concurrency limits. It receives no ambient filesystem, process, network, or
import capabilities. JSON and realm-native errors separate the script from host
objects. This is **not an OS sandbox** or a guarantee against JavaScript-engine
vulnerabilities.

Cancellation terminates the Worker and signals nested calls. Already dispatched
calls retain their transport/lifecycle ownership until they settle, even when a
tool ignores cancellation. A non-cooperative tool can therefore delay teardown;
timeout does not roll back completed side effects.

`toolCall` preserves the underlying result and its citation/source fields.
Code-mode scripts must return metadata they want to retain. Deferred `read` and
`skill` results remain inline; discovered schemas also remain inline. Code mode
enforces its own output bound rather than silently spilling script output.
Other PI overflow spills require both write permission and subsequent readability;
otherwise Cowork returns a bounded inline preview without a misleading file pointer.

## Native deferred loading is a different capability

These portable primitives do not claim provider-native schema activation.

- PI's native activation requires per-step `Context.tools` changes and preserved
  `ToolResultMessage.addedToolNames` in history. A search envelope alone is not
  that implementation.
- Codex native deferred functions require canonical namespaced registrations,
  experimental API negotiation, and model/provider support for namespace search.
  Legacy flat registrations remain accepted by the pinned release, but cannot be
  mixed with canonical registrations. The removed `features.tool_search` toggle
  does not enable native search.
- Codex's native code-mode host is separate from Cowork's portable Worker.
  Feature flags alone do not determine effective native code mode; model metadata
  can select the tool mode.

Verify future protocol changes against the deployed binary with
`codex app-server generate-ts --experimental --out <directory>` and
`generate-json-schema`, rather than assuming the latest documentation matches it.

## Remaining audit limits

- Linux adds inherited seccomp socket mediation to bubblewrap. It requires
  system Python with ctypes and native x86-64/AArch64; setup failure stops
  execution. Restricted commands cannot use pathname Unix IPC, including
  SSH-agent and Docker sockets. Anonymous stream socketpairs remain available.
- Runtime retention protects versions held by current processes using SQLite
  consumer leases, in addition to current plus one fallback. Leases last until
  process exit; older binaries and orphaned children that outlive their parent
  do not participate.
- Codex downloads are streamed with a 512 MiB per-artifact limit and a five-minute
  deadline. Forced repair verifies the staged executable and companions before
  replacing files. Activation is atomic per file, not across the entire set.
  The stricter archive symlink rules have regression coverage, but compatibility
  with every published runtime archive is unverified.
- Windows changes have deterministic policy coverage; native Windows enforcement
  must be tested on Windows. Actual Linux enforcement likewise requires a Linux
  host with usable bubblewrap.
- The installed macOS runtime `2026-06-22` contains LibreOffice `26.2.3.2`, which
  initializes Cocoa/AppKit even in headless mode. Real DOCX → PDF → PNG conversion
  passed outside the sandbox but aborted during application registration inside
  it. Forcing `SAL_USE_VCLPLUGIN=svp` did not fix that package. A genuinely
  sandbox-compatible headless runtime package is required; sandbox permissions
  were not widened to mask the problem. Explicit LibreOffice smoke checks now
  exercise sandbox enforcement and report this incompatibility. A
  [WASM replacement candidate](office-conversion.md) has passed local sandboxed
  DOCX/PPTX/XLSX conversion; production adoption remains gated on provenance,
  redistribution, lifecycle, and fidelity qualification.

The opt-in real document test supports `COWORK_RUNTIME_E2E_DIR`,
`COWORK_WORKSPACE_TOOLS_ROOT`, and `COWORK_RUNTIME_E2E_SANDBOX=1`:

```sh
bun run test -- test/coworkRuntime.e2e.integration.test.ts
```

The sandbox option fails rather than degrading when the required backend is
unavailable. Ordinary deterministic test runs do not download or execute a runtime.

## Verified upstream references

Checked against PI `0.85.1` and Codex `rust-v0.153.4` on 2026-09-06:

- [Codex app-server documentation](https://developers.openai.com/codex/app-server)
- [Pinned Codex sandbox wire types](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server-protocol/schema/typescript/v2/SandboxPolicy.ts)
- [Pinned dynamic-tool registration](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/dynamic_tools.rs)
- [Pinned Codex features](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/features/src/lib.rs)
- [PI release notes](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/CHANGELOG.md)
- [PI tool and streaming types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/types.ts)
