# Agent Coworker Project Context

`agent-coworker` is a terminal-first "coworker" AI agent designed to assist with software engineering tasks such as file management, code editing, shell execution, and web research. It is built for speed and extensibility, using a WebSocket-based server-client architecture.

## Project Overview

*   **Purpose:** A local-first AI assistant with deep system access (files, shell, web) and a tool-driven workflow.
*   **Main Technologies:**
    *   **Runtime:** Bun (high-performance JavaScript/TypeScript runtime).
    *   **Agent Framework:** Vercel AI SDK (`ai` package).
    *   **UI/UX:** OpenTUI + Solid.js for the terminal interface; Electron for the desktop application.
    *   **Communication:** Custom WebSocket protocol for decoupled client-server interaction.
*   **Core Architecture:**
    *   **Server (`src/server/`):** Manages `AgentSession` state, LLM orchestration, and WebSocket communication.
    *   **Agent (`src/agent.ts`):** Implements the agent loop, system prompt management, and tool execution.
    *   **Tools (`src/tools/`):** Built-in capabilities including `bash`, `read`, `write`, `edit`, `glob`, `grep`, `webSearch`, `webFetch`, and `spawnAgent`.
    *   **Clients:**
        *   **TUI (`apps/TUI/`):** Default interactive terminal UI built with OpenTUI + Solid.js. `src/tui/` is a thin launcher wrapper.
        *   **CLI (`src/cli/`):** Minimal REPL for direct interaction.
        *   **Desktop (`apps/desktop/`):** Native GUI wrapper using Electron.

## Building and Running

### Prerequisites
*   [Bun](https://bun.sh/) installed on your system.
*   API keys for desired providers (Google Gemini, OpenAI, or Anthropic) or login via community CLIs (`gemini`, `codex`, `claude`).

### Key Commands
*   **Install:** `bun install`
*   **Start TUI (Recommended):** `bun run start` (Launches server + TUI).
*   **Start CLI REPL:** `bun run cli`
*   **Start Server Only:** `bun run serve`
*   **Run Tests:** `bun test`
*   **Desktop Development:** `bun run desktop:dev`

### Execution Flags
*   `--dir <path>`: Sets the working directory for the agent.
*   `--yolo`: Bypasses command approval for risky operations (use with caution).
*   `--port <number>`: Specifies the WebSocket server port (default: 7337).

## Development Conventions

*   **Language & Style:**
    *   TypeScript in `strict` mode.
    *   ES Modules (ESM) throughout the project.
    *   2-space indentation.
    *   `camelCase` for variables and functions; `PascalCase` for types and components.
*   **WebSocket-First Logic:**
    *   All business logic MUST reside in the server/agent layer.
    *   UIs are thin clients that communicate via the protocol defined in `docs/websocket-protocol.md`.
    *   New features should be exposed via `ClientMessage` and `ServerEvent` unions in `src/server/protocol.ts`.
*   **Testing:**
    *   Tests are written using `bun:test` and located in the `test/` directory.
    *   Files are named `*.test.ts`.
    *   Mocks and temp directories are preferred over live network or system calls.
*   **Configuration:**
    *   Precedence: Defaults < User (`~/.agent/`) < Project (`./.agent/`) < Environment Variables. MCP server configs, auth, and session backups also live in `~/.cowork/` and `.cowork/`.
    *   Environment Variables: `AGENT_PROVIDER`, `AGENT_MODEL`, `AGENT_WORKING_DIR`.

## Key Files and Directories

*   `src/index.ts`: Main entry point for the CLI/TUI.
*   `src/agent.ts`: The core agent loop and LLM logic.
*   `src/server/protocol.ts`: Source of truth for the WebSocket protocol.
*   `docs/websocket-protocol.md`: Detailed documentation for building alternative clients.
*   `skills/`: Directory for domain-specific best practice guides (e.g., `pdf`, `slides`) loaded by the agent.
*   `prompts/`: System and sub-agent prompts.
