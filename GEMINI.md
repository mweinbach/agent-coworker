# Agent Coworker Project Context

`agent-coworker` is a "coworker" AI agent designed to assist with software engineering tasks such as file management, code editing, shell execution, and web research. It is built for speed and extensibility, using a WebSocket-based server-client architecture.

## Project Overview

*   **Purpose:** A local-first AI assistant with deep system access (files, shell, web) and a tool-driven workflow.
*   **Main Technologies:**
    *   **Runtime:** Bun (high-performance JavaScript/TypeScript runtime).
    *   **Agent runtime:** repo-owned runtime adapters selected by provider/runtime config.
    *   **UI/UX:** Electron for the desktop application plus a plain CLI REPL.
    *   **Communication:** Custom WebSocket protocol for decoupled client-server interaction.
*   **Core Architecture:**
    *   **Server (`src/server/`):** Manages `AgentSession` state, LLM orchestration, and WebSocket communication.
    *   **Agent (`src/agent.ts`):** Implements the agent loop, system prompt management, and tool execution.
    *   **Tools (`src/tools/`):** Built-in capabilities including `bash`, `read`, `write`, `edit`, `glob`, `grep`, `webSearch`, `webFetch`, `spawnAgent`, `todoWrite`, `skill`, and `memory`.
    *   **Clients:**
        *   **Desktop (`apps/desktop/`):** Primary native GUI using Electron.
        *   **CLI (`src/cli/`):** Minimal REPL for direct interaction.

## Building and Running

### Prerequisites
*   [Bun](https://bun.sh/) installed on your system.
*   API keys for desired providers (Google Gemini API, OpenAI API, or Anthropic API).

### Key Commands
*   **Install:** `bun install`
*   **Start Desktop (Recommended):** `bun run start` (Launches Electron app).
*   **Start CLI REPL:** `bun run cli`
*   **Start Server Only:** `bun run serve`
*   **Run Tests:** `bun test`
*   **Desktop Development:** `bun run desktop:dev`

### Execution Flags
These apply to `bun run cli`, `bun run serve`, and `bun src/index.ts` / `cowork`. They are **not** passed through `bun run start` (Electron dev); use workspace selection in the desktop app.

*   `--dir <path>`: Sets the working directory for the agent (CLI, server, or non-desktop `src/index.ts` entry).
*   `--yolo`: Bypasses command approval for risky operations (use with caution).
*   `--port <number>`: Specifies the WebSocket server port (default: 7337; server / relevant entrypoints).

## Development Conventions

*   **Language & Style:**
    *   TypeScript in `strict` mode.
    *   ES Modules (ESM) throughout the project.
    *   2-space indentation.
    *   `camelCase` for variables and functions; `PascalCase` for types and components.
*   **Desktop UI and shadcn/ui:**
    *   The Electron renderer in `apps/desktop` uses shadcn/ui. Do not introduce HeroUI or another component system for desktop UI.
    *   Run shadcn commands from `apps/desktop` with Bun, for example `bunx --bun shadcn@latest info --json`, `bunx --bun shadcn@latest docs button dialog`, and `bunx --bun shadcn@latest add <component>`.
    *   Use `apps/desktop/components.json` as the source of truth: Vite, Tailwind v4, radix base, lucide icons, `@/components/ui/*` imports, and `@/lib/utils`.
    *   Prefer existing shadcn primitives before custom markup. Use components such as `Button`, `Card`, `Dialog`, `Sheet`, `Tabs`, `Select`, `Switch`, `Checkbox`, `Tooltip`, `DropdownMenu`, `Command`, `Field`, `InputGroup`, `Separator`, `Skeleton`, and `Badge`.
    *   Follow shadcn conventions: semantic CSS tokens, component variants, `gap-*` instead of `space-*`, `size-*` for equal dimensions, `cn()` for conditional classes, and lucide icons with `data-icon` inside buttons.
    *   Preview updates to existing shadcn files with `--dry-run` or `--diff`; do not overwrite desktop-customized wrappers without checking their behavior and tests.
*   **WebSocket-First Logic:**
    *   All business logic MUST reside in the server/agent layer.
    *   UIs are thin clients that communicate via the protocol defined in `docs/websocket-protocol.md`.
    *   New features should be exposed as JSON-RPC methods in `src/server/jsonrpc/routes/` and schemas in `src/server/jsonrpc/schema.ts`. Internal session event types live in `src/server/protocol.ts`.
*   **Testing:**
    *   Tests are written using `bun:test` and located in the `test/` directory.
    *   Files are named `*.test.ts`.
    *   Mocks and temp directories are preferred over live network or system calls.
*   **Configuration:**
    *   Precedence: Defaults < User (`~/.cowork/config/`) < Project (`./.cowork/`) < Environment Variables. MCP server configs, auth, and session backups also live in `~/.cowork/` and `.cowork/`.
    *   Environment Variables: `AGENT_PROVIDER`, `AGENT_MODEL`, `AGENT_WORKING_DIR`.

## Key Files and Directories

*   `src/index.ts`: Main terminal entry point (CLI REPL).
*   `src/agent.ts`: The core agent loop and LLM logic.
*   `src/server/protocol.ts`: Internal `SessionEvent` union types. JSON-RPC schemas live in `src/server/jsonrpc/`.
*   `docs/websocket-protocol.md`: Detailed documentation for building alternative clients.
*   `docs/harness/index.md`: Harness docs map for context, config, observability, and the runbook.
*   `skills/`: Directory for domain-specific best practice guides (e.g., `pdf`, `slides`) loaded by the agent.
*   `prompts/`: System and sub-agent prompts.
