---
name: Bun
description: Use when building JavaScript/TypeScript applications, running scripts, managing dependencies, bundling code, or testing. Bun is a drop-in replacement for Node.js with integrated package manager, bundler, and test runner.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill

## Product summary

Bun is an all-in-one JavaScript/TypeScript runtime and toolkit. It ships as a single executable (`bun`) and includes a fast runtime (4x faster startup than Node.js), package manager (30x faster installs), bundler, and test runner. Agents use Bun to execute TypeScript/JSX directly without configuration, manage dependencies, bundle applications, and run tests. Key files: `bunfig.toml` (configuration), `package.json` (scripts and dependencies), `bun.lock` (lockfile). Primary CLI commands: `bun run`, `bun install`, `bun build`, `bun test`. See https://bun.com/docs for complete documentation.

## When to use

Reach for this skill when:
- **Running code**: User asks to execute a TypeScript, JSX, or JavaScript file directly
- **Managing dependencies**: Installing, adding, removing, or updating npm packages
- **Building/bundling**: Creating optimized bundles for browsers or servers
- **Testing**: Writing or running tests with Jest-like syntax
- **Scripts**: Running package.json scripts or shell commands
- **HTTP servers**: Building web servers with `Bun.serve()`
- **File operations**: Reading/writing files with optimized APIs
- **Monorepos**: Setting up workspaces with multiple packages
- **Deployment**: Preparing applications for production (bundling, executables)

## Quick reference

### Core commands

| Task | Command |
|------|---------|
| Run a file | `bun run index.ts` or `bun index.ts` |
| Run a script | `bun run dev` (from package.json) |
| Install dependencies | `bun install` |
| Add a package | `bun add lodash` |
| Add dev dependency | `bun add -d @types/node` |
| Remove a package | `bun remove lodash` |
| Bundle code | `bun build ./index.ts --outdir ./dist` |
| Run tests | `bun test` |
| Watch mode | `bun --watch run index.ts` |
| List scripts | `bun run` (no args) |

### File conventions

- `bunfig.toml` — Bun configuration (optional, zero-config by default)
- `package.json` — Project metadata, scripts, dependencies
- `bun.lock` — Binary lockfile (or `bun.lock.json` for text format)
- `*.test.ts`, `*_test.ts`, `*.spec.ts` — Test files (auto-discovered)
- `.env`, `.env.local`, `.env.production` — Environment variables (auto-loaded)

### Configuration sections in bunfig.toml

```toml
[install]
linker = "hoisted"  # or "isolated"
optional = true
dev = true
peer = true

[test]
root = "."
coverage = false
timeout = 5000

[run]
shell = "system"  # or "bun"
bun = true        # alias node → bun

[serve]
port = 3000
```

### Common Bun APIs

| API | Purpose |
|-----|---------|
| `Bun.serve()` | Start HTTP server with routes |
| `Bun.file(path)` | Read/write files efficiently |
| `Bun.write(path, data)` | Write to file |
| `Bun.env` | Access environment variables |
| `Bun.build()` | Bundle code programmatically |
| `Bun.spawn()` | Spawn child processes |
| `Bun.$ ` | Run shell commands |

## Decision guidance

### When to use `bun run` vs `bun` (naked command)

| Scenario | Use |
|----------|-----|
| Running a package.json script | `bun run dev` |
| Running a file directly | `bun index.ts` or `bun run index.ts` |
| Passing flags to Bun | `bun --watch run dev` |
| Passing flags to the script | `bun run dev --port 8080` |

### When to use `bun install` vs `bun add`

| Scenario | Use |
|----------|-----|
| Install all dependencies from package.json | `bun install` |
| Add a new package | `bun add lodash` |
| Add as dev dependency | `bun add -d typescript` |
| Add optional dependency | `bun add -O optional-pkg` |
| Remove a package | `bun remove lodash` |

### Linker strategy: hoisted vs isolated

| Strategy | Use when |
|----------|----------|
| `hoisted` (default for single packages) | You want a shared `node_modules` directory; compatible with Node.js tools |
| `isolated` (default for workspaces) | You have a monorepo; each package has its own dependencies; faster installs |

### Bundler target

| Target | Use when |
|--------|----------|
| `browser` (default) | Bundling for web browsers |
| `bun` | Bundling for Bun runtime; enables optimizations |
| `node` | Bundling for Node.js; uses Node export conditions |

## Workflow

### 1. Set up a new project
```bash
bun init my-app
cd my-app
```
Choose template: Blank, React, or Library. Creates `package.json`, `tsconfig.json`, `.gitignore`.

### 2. Install dependencies
```bash
bun install
```
Reads `package.json`, downloads packages, creates `bun.lock`. Bun auto-loads `.env` files.

### 3. Write and run code
```bash
# Direct execution (TypeScript/JSX supported natively)
bun run src/index.ts

# Or define a script in package.json
# "scripts": { "dev": "bun run src/index.ts" }
bun run dev
```

### 4. Add packages
```bash
bun add express
bun add -d @types/express
```
Updates `package.json` and `bun.lock`.

### 5. Build for production
```bash
bun build ./src/index.ts --outdir ./dist
```
Bundles TypeScript/JSX, minifies, generates sourcemaps. Output in `dist/`.

### 6. Run tests
```bash
bun test
```
Auto-discovers `*.test.ts`, `*.spec.ts` files. Uses Jest-like API.

### 7. Configure (optional)
Create `bunfig.toml` for Bun-specific settings (install behavior, test config, JSX, etc.). Most projects work without it.

## Common gotchas

- **Flag placement**: `bun --watch run dev` (flags after `bun`), not `bun run dev --watch` (flags at end go to the script)
- **TypeScript errors on Bun global**: Install `@types/bun` and add `"lib": ["ESNext"]` to `tsconfig.json`
- **Auto-install disabled by default in production**: Set `install.auto = "disable"` in `bunfig.toml` if you want strict dependency management
- **Lockfile format**: Bun generates binary `bun.lock` by default (faster). Use `saveTextLockfile = true` for git-friendly text format
- **Node.js compatibility**: Bun aims for Node.js compatibility but not everything is implemented. Check `/runtime/nodejs-compat` for status
- **Environment variables**: Bun auto-loads `.env`, `.env.local`, `.env.production`, `.env.development`. Disable with `env = false` in `bunfig.toml`
- **Test discovery**: Only files matching `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts` are run. Subdirectories are scanned recursively
- **Workspace packages**: Use `"workspace:*"` syntax to reference other packages in a monorepo, not version numbers
- **External imports in bundles**: Mark packages as external with `external: ["lodash"]` to avoid bundling them
- **JSX without React**: Configure `jsxFactory` and `jsxFragment` in `bunfig.toml` or `tsconfig.json` for non-React JSX

## Verification checklist

Before submitting work with Bun:

- [ ] Code runs without errors: `bun run <file>` or `bun run <script>`
- [ ] Dependencies are installed: `bun install` succeeds
- [ ] Tests pass: `bun test` shows all tests passing
- [ ] No TypeScript errors: Check editor or run `bun check` (if available)
- [ ] Bundles build: `bun build` completes without errors
- [ ] Environment variables are set: `.env` file exists with required vars
- [ ] `bunfig.toml` is valid TOML (if present)
- [ ] `package.json` scripts are correct and tested
- [ ] Lockfile is committed (if using version control)
- [ ] No hardcoded paths; use relative paths or environment variables

## Resources

- **Comprehensive navigation**: https://bun.com/docs/llms.txt — Full page-by-page listing for agent navigation
- **Runtime API**: https://bun.com/docs/runtime — File I/O, HTTP, environment variables, shell, workers
- **Package Manager**: https://bun.com/docs/pm/cli/install — Install, add, remove, workspaces, registries
- **Bundler**: https://bun.com/docs/bundler — Build, splitting, plugins, minification, executables
- **Test Runner**: https://bun.com/docs/test — Writing tests, mocks, snapshots, watch mode, coverage

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt