# UI foundation migration

## Implemented foundation

The shared desktop/web renderer now uses TanStack Router **1.170.32** and
Vite+ **0.3.0**. This replaces screen switches and eager settings-page imports;
it does not introduce TanStack Start, SSR, a second server, or TanStack Query.
Electron-vite still orchestrates native builds against the pinned Vite+ core.
Bun remains the harness runtime and test runner; mobile stays on Expo/Metro.

## Ownership

| Concern | Owner |
| --- | --- |
| Current screen, back/forward, settings location | TanStack Router and its history |
| Selected entities, live messages, reconnect state, optimistic IDs, drafts | Existing WebSocket/Zustand state |
| Agent behavior, permissions, persistence, task lifecycle | Existing Bun harness/server |
| Native windows, privileged operations, preload bridge | Existing Electron main/preload |
| Shared renderer dev/build | Vite+ core with electron-vite for native builds |
| Lint/format | Disjoint Vite+ and Biome scopes listed below |
| Native mobile bundling/navigation | Existing Expo/Metro stack |

### Routing and restoration

- Code-based routes live in `apps/desktop/src/app/router.tsx`: `/chat`, `/task`,
  and fourteen canonical `/settings/<page>` locations. Explicit lazy components
  split task/settings screens without a route generator or plugin. Chat remains
  shared with utility windows. Five intent-oriented settings pages share one chunk.
- `App.tsx` keeps process-wide lifecycle, overlays, and native window dispatch.
  `ChatScreen` and `SettingsScreen` own their existing layouts around router outlets.
  Settings metadata is separate from page implementations, so the command palette
  no longer eagerly imports the entire settings tree.
- `navigation.ts` is the command/subscription boundary over the router's history.
  Its snapshot derives from that history, not a second navigation store. Zustand
  no longer contains `view`, `settingsPage`, or `lastNonSettingsView`; semantic
  actions submit explicit navigation commands while data updates remain in Zustand.
- Main windows use hash history, preserving outer query parameters and packaged
  `file:` loading. Utility windows retain their independent dispatch and memory
  navigation. No workspace paths or credentials are added to route locations.
- History entries preserve the settings return screen and last settings preference.
  The Settings Back button returns to chat/task; browser back/forward traverses pages.
  User history changes invalidate stale creation intents; creation-result navigation
  does not invalidate itself.
- Cache writes use one nested `ui.navigation` snapshot. Legacy fields and aliases
  are decoded at startup only. Explicit incoming locations beat saved navigation,
  and late bootstrap does not overwrite a newer route.
- Feature availability and packaged-development restrictions apply to direct links
  and changes after bootstrap. Settings error boundaries follow the resolved route,
  so navigating away from a crashed page cannot attribute its error to the next page.
- Route changes do not own transports, reconnect sockets, cancel turns, or reset drafts.
- The keyboard skip control focuses the main region directly without changing the
  route hash or adding history entries.

## Verification and measurement

The migration adds controller tests for aliases, restoration, settings return,
history intent, no-op updates, outer queries, and the absence of navigation fields
in Zustand. Native Electron/CDP navigation tests exercise streaming/draft preservation,
unchanged socket/interrupt counts, back/forward, reload, task return, direct-link
feature gates, and keyboard skip focus. Existing
startup, utility-window, lifecycle, cache, and reconciliation tests remain required.

Run the repository test/type/lint/docs lane, `bun run check`,
`bun run desktop:quality:build`, `bun run web:build`, and native first-paint/navigation
gates before changing this foundation. Bun DOM tests must mount the router before
waiting for route completion; its transition callback belongs to the mounted provider.

A local warm quality build before migration took 1.085 seconds. Its unminified main
renderer entry was 6,950.13 kB; one migrated quality build emitted a 3,332.75 kB entry.
Shared chunks also changed, so this is **not** a total startup payload reduction or
a production speedup claim. Comparable production payload/startup benchmarks remain
necessary before claiming performance gains. A prior Biome-only check of 1,948 files
took 418 ms; that is not a comparative Oxlint benchmark.

The implementation passes the full isolated suite (**737 test files**), root/desktop/
tooling type checks, both scoped linters/formatters, documentation checks, and the
unchanged platform-boundary ratchet. Frozen-lockfile installation, browser production
build, and Electron main/preload/renderer build also pass. Native macOS Electron/CDP
verification passes three first-paint and four navigation tests, plus three local
streaming/interaction/reconnect smoke scenarios; routed chat and settings captures
were inspected. This does not claim signed packaging, Linux visual-baseline coverage,
or a production performance benchmark. The browser build still emits telemetry
dependency Node-externalization warnings; those are not lint failures.

## Complexity controls

Oxlint provides `complexity`, `no-restricted-imports`, and `import/no-cycle` rules.
Use scoped import restrictions to keep renderer code away from server implementations
and privileged Node APIs while permitting approved shared contracts. Add fixture tests
for aliases and relative imports; lint is an architecture guard, not a security boundary.

Enable strict rules on migrated modules and ratchet existing violations downward.
Do not lower a score by splitting coherent logic into forwarding helpers. Cyclomatic
complexity from Oxlint is not directly comparable to the existing Biome cognitive
complexity metric. Preserve a comparable baseline when changing measurement tools.

## Toolchain cautions

### Implemented tooling boundary

- Manually pinned `vite-plus` and the `vite` alias to
  `@voidzero-dev/vite-plus-core` at **0.3.0**, with the bundled Vitest pinned to
  **4.1.11**. Installed tools report Vite **8.2.2**, Rolldown **1.2.5**, Oxlint
  **1.79.0**, Oxfmt **0.64.0**, and oxlint-tsgolint **7.0.2001**.
- Retained electron-vite **6.0.0-beta.1** because it supports Vite 8; the registry's
  stable electron-vite 5 release does not. React's Vite plugin is pinned to **6.1.1**
  and Tailwind's Vite plugin to **4.3.3**. Electron still owns main/preload/renderer,
  including bundled CJS preload output, relative renderer assets, aliases, and
  public telemetry injection. The browser config retains its entry rewrite,
  intentional server URL/access-token injection, and HTTP/WebSocket proxies.
- Bun **1.4.0** remains the declared package manager and runtime. Scripts invoke
  the project-local Vite+ CLI through Bun, without shell hooks, global installation,
  runtime downloads, or automatic migration. `bun run web:build` builds the browser
  client; desktop build/dev/quality commands remain electron-vite commands.
- Oxlint/Oxfmt own root `vite.config.ts`, desktop `electron.vite.config.ts`,
  desktop `vite.config.web.ts`, and quality-gates `electron.vite.config.ts`.
  Their renderer scope is **only** `src/app/navigation.ts`,
  `src/app/settingsNavigation.ts`, `src/app/router.tsx`, and
  `src/ui/layout/ScreenLoading.tsx` within `apps/desktop`.
  The exact same eight files are excluded from Biome. Other renderer and Electron
  source, tests, server, mobile, JSON, and Tailwind CSS retain their existing Biome rules,
  exclusions, import organization, and formatting. This is not a full-repo or
  full-renderer static-tooling replacement.
- The migrated scope enables correctness/suspicious categories, zero
  warnings, type-only imports, explicit-any/non-null bans, banned TypeScript type
  equivalents, assignment/empty-block/useless-catch checks, import cycles, and a
  cyclomatic ceiling of 15. Oxfmt owns import sorting and preserves two spaces,
  100 columns, LF, double quotes, semicolons, and trailing commas. No rule is
  disabled to accommodate existing code; no renderer suppressions are introduced.
  The four new renderer modules additionally enable React and accessibility rules,
  exhaustive hook dependencies, stable keys, and native/harness import restrictions.
  React-in-JSX-scope is disabled because this project uses the automatic JSX runtime,
  not because of existing violations. Import restrictions cover Node/Bun/Electron,
  harness aliases, relative implementation paths, and literal dynamic imports;
  approved shared contracts and typed desktop bridge imports remain allowed.
  `test/ci.workflow.test.ts` exercises those boundaries and disjoint tool ownership.
- `bun run check:tooling` combines Vite+ lint/format with a strict TypeScript check
  of all four configs. New renderer modules belong to the existing desktop graph.
  Existing root/harness/desktop TypeScript graphs remain in
  `bun run typecheck`; bundled type-aware checking is not yet a proven replacement.

### Remaining static-tooling migration

A non-mutating renderer trial of Oxlint correctness plus hook/key rules (with the
automatic JSX runtime accounted for) reported 183 diagnostics, including React
compiler-style ref/effect rules and accessibility differences. These are migration
work, not permission for blanket suppressions. Map the complete Biome recommended
set and existing per-file exceptions, verify accessibility/hook parity with fixtures,
and review formatter/import changes before moving the remaining renderer source.
Keep Tailwind parsing under Biome until separately verified. The new-module boundary
rules do not cover existing renderer modules or computed dynamic imports and are
architecture guards, not a security boundary. Expand both tools' scope lists
together so no file has two authorities.

### Operational cautions

- Vite+ supports Bun as a package manager, but `vp test` runs Vitest. Preserve
  `bun run test` and its isolation wrapper; `vp run test` may invoke that script.
- `vp migrate` targets the monorepo root and can rewrite dependencies, scripts,
  formatting, hooks, and agent/editor configuration. Do not treat it as an isolated
  desktop-package conversion or run it across unrelated uncommitted work.
- Vite+ manages a Node environment by default. Runtime management is a separate
  choice from adopting frontend tooling; Bun remains the harness runtime.
- Vite+ cannot itself eliminate unnecessary renders or speed up model generation.
  Expected UI gains come from smaller eager imports and narrower state subscriptions;
  expected developer gains come from measured checks, caching, and simpler commands.

## Sources

- [Vite+ migration and Bun/test command distinctions](https://viteplus.dev/guide/migrate.md)
- [Vite+ combined static checks](https://viteplus.dev/guide/check.md)
- [TanStack Router automatic code splitting](https://tanstack.com/router/latest/docs/framework/react/guide/automatic-code-splitting)
- [TanStack Router history types](https://tanstack.com/router/latest/docs/framework/react/guide/history-types)
- [Oxlint complexity](https://oxc.rs/docs/guide/usage/linter/rules/eslint/complexity.md)
- [Oxlint import restrictions](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports.md)
- [Oxlint dependency cycles](https://oxc.rs/docs/guide/usage/linter/rules/import/no-cycle.md)
