# Cowork

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/mweinbach/agent-coworker)

Cowork is a local-first AI work app for people who want an agent that can sit next to a real project, understand the files on disk, run the right tools, remember the thread, and hand work back in a form you can inspect.

It is built for everyday computer work, not just chat. Open a workspace, pick your model, connect the tools you trust, and ask Cowork to help you make progress: change code, inspect files, research a question, create a plan, spin up helper agents, or resume a previous thread when you come back later.

## What You Can Do

- **Work inside real folders.** Add a project or start a one-off chat, then let Cowork read, search, edit, and run commands in that workspace.
- **Keep conversations connected to work.** Threads are saved locally and can be resumed after restarts, so a project can keep its history instead of becoming a pile of throwaway chats.
- **Use the model you already prefer.** Cowork supports Google, OpenAI, Anthropic, Bedrock, Together, Fireworks, Fire Pass, NVIDIA, LM Studio, Baseten, OpenCode, and Codex CLI.
- **Bring in tools and apps.** Skills, plugins, MCP servers, web search, file tools, shell tools, and subagents are part of the product surface.
- **Delegate bigger jobs.** Ask Cowork to spawn focused helper agents for independent research, review, or implementation tasks.
- **Stay in control.** Risky tool actions go through approval flows unless you explicitly launch with `--yolo`.
- **Use it from your desk or phone.** The desktop app is the main client, and the optional mobile app can pair directly to your desktop for remote access while the desktop app is running.
- **Build on the same core.** The desktop app, CLI, mobile app, and custom clients all talk to the same WebSocket-first runtime.

## Product Tour

### Desktop App

The Electron desktop app is the easiest way to use Cowork day to day.

It includes:

- workspace picker and per-workspace settings
- guided onboarding for first setup
- provider connection flows and model selection
- chat threads with streaming markdown and resumable history
- quick chat from the menu bar or system tray
- skills and plugin management
- MCP server setup, validation, auth, and enable/disable controls
- remote access settings for phone pairing
- settings for privacy, telemetry, updates, defaults, and developer options

Run the desktop app:

```bash
bun run start
```

Run the one-time demo tour for a walkthrough without clearing your real state:

```bash
bun run desktop:demo
```

`desktop:demo` launches the normal desktop app with `COWORK_DEMO_MODE=1`, which opens the existing onboarding tour for that launch.

### CLI

The CLI is a lighter interface for terminal-first work. It connects to the same server runtime and supports provider setup, model switching, session management, and workspace control.

```bash
bun run cli
bun run cli -- --dir /path/to/project
```

Useful commands inside the REPL:

- `/connect <provider>` to sign in or save a key
- `/provider <name>` to switch providers
- `/model <id>` to switch models
- `/new` to start a new session
- `/resume <sessionId>` to continue previous work
- `/sessions` to list saved sessions
- `/tools` to see available tools
- `/cwd <path>` to change workspace

### Mobile Remote Access

The optional Expo mobile app can pair with the desktop app over a direct local HTTP/3 path. The desktop app shows a QR code; the phone verifies the desktop certificate pins, exchanges a one-time pairing nonce, and then sends Cowork JSON-RPC messages directly to the desktop sidecar.

There is no hosted relay in the data path for the v1 pairing flow. Trusted phones are managed from `Settings -> Remote Access`, where permissions can be granted or revoked per device.

See [docs/mobile-remote-access.md](./docs/mobile-remote-access.md) for the full pairing model.

## Why Local-First Matters

Cowork keeps the product boundary on your machine:

- your workspace remains local
- sessions are stored in `~/.cowork/sessions.db`
- provider keys and MCP credentials live in local Cowork auth stores
- tool execution happens server-side in the selected workspace
- UIs render state and send typed requests instead of owning business logic

External services are contacted only through the providers, tools, MCP servers, and connectors you configure.

## Quickstart

### 1. Install

Prerequisite: [Bun](https://bun.sh)

```bash
git clone https://github.com/mweinbach/agent-coworker
cd agent-coworker
bun install
```

### 2. Connect a Provider

You need at least one AI provider for live turns. Tests, docs checks, and basic app startup do not require provider credentials.

You can save provider auth from the desktop UI, use the CLI `/connect` flow, or set environment variables.

```bash
export OPENAI_API_KEY=...
bun run cli
```

Then, inside the REPL:

```text
/connect codex-cli
```

Supported provider auth:

| Provider | Auth |
| --- | --- |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Bedrock | AWS default credentials, profile, or explicit AWS env vars |
| Together | `TOGETHER_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Fire Pass | `FIREPASS_API_KEY` |
| NVIDIA | `NVIDIA_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| LM Studio | local server, optional `LM_STUDIO_API_KEY`, optional `LM_STUDIO_BASE_URL` |
| OpenCode Go | `OPENCODE_API_KEY` |
| OpenCode Zen | `OPENCODE_ZEN_API_KEY` |
| Codex CLI | built-in OAuth or API key flow through Cowork |

Saved provider credentials live under `~/.cowork/auth/connections.json`.

### 3. Start Working

Desktop:

```bash
bun run start
```

CLI:

```bash
bun run cli -- --dir /path/to/project
```

Server only:

```bash
bun run serve
bun run serve -- --dir /path/to/project
bun run serve -- --json
```

## Everyday Features

### Workspace-Aware Chat

Cowork works with project folders, not isolated prompts. The server can expose file reads, edits, search, shell commands, web research, and contextual skills to each turn.

Built-in tool IDs include:

- `bash`
- `read`, `write`, `edit`
- `glob`, `grep`
- `webSearch`, `webFetch`
- `todoWrite`
- `spawnAgent`
- `skill`, `memory`

When persistent agent control is enabled, sessions can also expose tools for listing, messaging, waiting on, inspecting, resuming, and closing helper agents.

### Skills, Plugins, and MCP

Skills are instruction bundles rooted in `SKILL.md`. Cowork discovers them from:

1. `.cowork/skills` in the current workspace
2. `~/.cowork/skills`
3. built-in `skills/`

MCP servers are configured in layers:

1. `.cowork/mcp-servers.json`
2. `~/.cowork/config/mcp-servers.json`
3. `config/mcp-servers.json`

MCP credentials are stored separately from config. See [docs/mcp-guide.md](./docs/mcp-guide.md) for setup details.

### Persistence and Recovery

Cowork stores session state locally so threads can survive restarts. Desktop transcript JSONL files are renderer cache; the canonical session store is `~/.cowork/sessions.db`.

Backup APIs are opt-in. Git workspaces should still use normal git checkpoints such as `git diff`, `git stash`, and worktrees.

See [docs/session-storage-architecture.md](./docs/session-storage-architecture.md) for the storage model.

## For Builders

Cowork is also an agent runtime you can build on.

The main design rule is simple: the server owns behavior; clients are thin.

```text
Desktop / CLI / Mobile / Custom Client
                |
                v
        JSON-RPC over WebSocket
                |
                v
          Cowork server runtime
 sessions | auth | MCP | persistence
 tools    | streaming | approvals
                |
                v
       model runtimes and tool execution
```

The JSON-RPC WebSocket protocol is documented in [docs/websocket-protocol.md](./docs/websocket-protocol.md). It covers provider auth, MCP management, session and thread control, file uploads, backup flows, subagents, streaming events, and observability.

Build a standalone Bun server binary:

```bash
bun run build:server-binary
./dist/cowork-server --host 0.0.0.0 --port 7337
```

When listening on non-loopback hosts, the server requires an access token for `/ws` and `/cowork/*`. Use `--json` to read `browserAccessToken`, or set `COWORK_BROWSER_ACCESS_TOKEN`.

## Development

Common commands:

```bash
bun test                    # run all tests
bun run typecheck           # typecheck root, harness, and desktop
bun run docs:check          # verify docs/protocol consistency
bun run desktop:dev         # run Electron desktop app in dev mode
bun run desktop:demo        # run desktop app with onboarding demo mode
bun run dev                 # watch the CLI entry point
bun run harness:run         # run harness scenarios in report-only mode
bun run test:stable         # sequential per-file test runner
```

Mobile commands:

```bash
bun run app:mobile:dev
bun run app:mobile:ios
bun run app:mobile:android
bun run app:mobile:typecheck
```

Repository map:

| Path | Purpose |
| --- | --- |
| `src/server/` | WebSocket server, JSON-RPC routes, session orchestration, persistence |
| `src/cli/` | CLI REPL and command parsing |
| `src/providers/` | Provider catalog, auth, and model adapters |
| `src/tools/` | Built-in server-side tools |
| `src/runtime/` | Runtime adapters |
| `src/mcp/` | MCP config, auth, and client lifecycle |
| `src/skills/` | Skill discovery and trigger extraction |
| `apps/desktop/` | Electron desktop app |
| `apps/mobile/` | Optional Expo mobile app |
| `packages/harness/` | Developer harness scripts and validation |
| `config/` | Built-in defaults and provider model configs |
| `skills/` | Bundled skills |
| `prompts/` | System and subagent prompts |
| `docs/` | Protocol, architecture, storage, MCP, mobile, and harness docs |

More docs:

- [docs/architecture.md](./docs/architecture.md)
- [docs/websocket-protocol.md](./docs/websocket-protocol.md)
- [docs/custom-tools.md](./docs/custom-tools.md)
- [docs/bundling-guide.md](./docs/bundling-guide.md)
- [docs/workspace-context.md](./docs/workspace-context.md)
- [docs/harness/index.md](./docs/harness/index.md)
- [docs/harness/config.md](./docs/harness/config.md)

## Status

Cowork is actively developed. The core local-first runtime and WebSocket architecture are stable enough to build on, while desktop polish, mobile remote access, provider behavior, and plugin workflows continue to move quickly.

README claims should match the code. If a feature changes, update this document with the implementation.

## License

This project uses a custom source-available license in [LICENSE](./LICENSE).

Forks and modifications are allowed, but you must clearly credit the original project and identify your changes. Selling the project, a fork, or a derivative product/service requires prior permission from Max Weinbach.
