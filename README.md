# agent-coworker

Terminal-first “coworker” agent with:
- a WebSocket agent server (Bun)
- a TUI client (OpenTUI + React)
- a plain CLI REPL
- a small built-in toolbelt (bash/read/write/edit/glob/grep/web + memory/skills/todos/sub-agents)

## Quickstart

Prereqs: Bun installed.

```bash
bun install
```

Set an API key for the provider you want to use:
- Google Gemini: `GOOGLE_GENERATIVE_AI_API_KEY`
- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`

Run the TUI (starts the server automatically):
```bash
bun run start
# optionally target a directory:
bun run start -- --dir /path/to/project
```

Run the plain CLI:
```bash
bun run cli
```

Run the server directly:
```bash
bun run serve
```

## Configuration

Config merges built-in defaults + user + project overrides.

Environment variables:
- `AGENT_PROVIDER` (`google|openai|anthropic`)
- `AGENT_MODEL`
- `AGENT_WORKING_DIR`
- `AGENT_OUTPUT_DIR`
- `AGENT_UPLOADS_DIR`
- `AGENT_USER_NAME`

Config files (optional):
- `./.agent/config.json` (project)
- `~/.agent/config.json` (user)

## Development

Run tests:
```bash
bun test
```

Watch mode:
```bash
bun run dev
```

