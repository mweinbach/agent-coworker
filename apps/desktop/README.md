# Cowork Desktop

Electron + React + TypeScript desktop client for `agent-coworker`.

## Development

```bash
bun install
bun run dev
```

Dev mode enables Electron remote debugging on `localhost:9222` by default.
Set `COWORK_ELECTRON_REMOTE_DEBUG_PORT` to override the port.

Desktop renderer dev URL is restricted to loopback on `COWORK_DESKTOP_RENDERER_PORT` (default `1420`).
If `ELECTRON_RENDERER_URL` points to another app (for example the harness portal), desktop falls back to its own renderer URL.

## Control With agent-browser

Use [agent-browser](https://github.com/vercel-labs/agent-browser) to drive the Electron app over CDP.

Recommended once per machine:

```bash
brew install agent-browser
# or: npm install -g agent-browser
```

1. Start desktop in dev mode:

```bash
bun run dev
```

2. In another terminal (repo root), run agent-browser commands through the wrapper:

```bash
bun run desktop:browser -- snapshot -i
bun run desktop:browser -- click @e2
bun run desktop:browser -- screenshot tmp/desktop.png
```

From `apps/desktop`, you can also run:

```bash
bun run browser -- snapshot -i
```

By default the wrapper targets CDP port `9222`, or `COWORK_ELECTRON_REMOTE_DEBUG_PORT` when set.
The wrapper prefers a globally installed `agent-browser` binary and falls back to `bunx agent-browser` if it is not in `PATH`.

## Build

```bash
bun run build
```

The build pipeline rebuilds bundled desktop resources (`cowork-server` sidecar + prompts/config/skills/docs) via the root `build:desktop-resources` script.
