# Cowork Desktop

Electron + React + TypeScript desktop client for `agent-coworker`.

## Development

```bash
bun install
bun run dev
```

Dev mode enables Electron remote debugging on `localhost:9222` by default.
Set `COWORK_ELECTRON_REMOTE_DEBUG_PORT` to override the port.

## Build

```bash
bun run build
```

The build pipeline rebuilds bundled desktop resources (`cowork-server` sidecar + prompts/config/skills/docs) via the root `build:desktop-resources` script.
