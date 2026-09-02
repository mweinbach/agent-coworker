# UI foundation migration

## Recommendation

Use TanStack Router for the shared desktop/web renderer and evaluate Vite+ as the
consolidated frontend toolchain. This is a migration plan, not an implemented migration.
The objective is to replace custom navigation and overlapping tooling, not add another
framework alongside them. TanStack Start, SSR, and a new server are not needed.

## Current foundation

- The renderer already uses React 19 and Vite 8. Electron-vite owns main, preload,
  and renderer builds; a separate Vite config serves the browser client.
- `apps/desktop/src/App.tsx` mixes window shells, lifecycle wiring, and navigation.
  `PrimaryContent` switches chat/task views, while `SettingsShell` imports settings
  pages eagerly and resolves navigation through a page registry.
- Zustand owns `view`, `lastNonSettingsView`, `settingsPage`, and selected entities
  alongside live WebSocket state. Navigation also participates in restoration,
  stale-intent cancellation, native menu commands, and quick-chat windows.
- Biome already checks the repository quickly: one local check of 1,948 files took
  418 ms. This is an observation, not a comparative benchmark against Oxlint.
- Tests use Bun APIs and the repository's per-file isolation runner. Mobile uses
  Expo/Metro and has its own navigation. Neither should be replaced by this migration.

## Ownership after migration

| Concern | Owner |
| --- | --- |
| Current screen, route parameters, back/forward, settings location | TanStack Router |
| Live messages, reconnect state, optimistic IDs, drafts, interaction queues | Existing WebSocket/Zustand state |
| Agent behavior, permissions, persistence, task lifecycle | Existing Bun harness/server |
| Native windows, privileged operations, preload bridge | Existing Electron main/preload |
| Shared renderer dev/build and static checks | Vite+, after compatibility and rule-parity checks |
| Native mobile bundling/navigation | Existing Expo/Metro stack |

Do not duplicate live transcripts in router loaders or add TanStack Query by default.
Route changes must not reconnect transports, cancel active turns, or discard drafts.
Use opaque entity IDs in locations, never workspace filesystem paths or credentials.

## Incremental delivery

1. **Record comparable baselines.** Measure cold/warm builds, renderer entry bytes,
   first usable paint, settings/task navigation, and streaming responsiveness using
   the same build mode and fixtures. Quality builds are not production bundle-size
   measurements. Existing native first-paint and Electron/CDP gates remain authoritative.
2. **Introduce typed routing on the existing Vite build.** Start with settings, then
   chat/task locations. Use thin file routes with automatic component splitting.
   Remove the old page switch and redundant navigation state as each area moves;
   any temporary compatibility adapter needs a defined removal point. Migrate saved
   navigation once, preserving settings aliases, feature availability, return location,
   stale-navigation protection, and selected-thread restoration.
3. **Preserve window and history contracts.** Use hash history for the packaged
   renderer unless URL-independent memory history is required by a utility window.
   Preserve existing outer query parameters for window mode and thread bootstrap.
   Browser history requires explicit dev and production index fallbacks; hash history
   is a viable initial shared default. Test reload, back/forward, native menu navigation,
   quick-chat popout, canvas windows, and direct links independently.
4. **Adopt Vite+ through a bounded compatibility trial.** Pin compatible versions and
   prove the electron-vite integration before replacing scripts. Keep main/preload
   lifecycle management, relative renderer assets, sandboxed CJS preload output,
   public-only environment injection, and WebSocket proxy behavior intact. Official
   Vite+ guidance does not establish compatibility with this exact Electron setup.
5. **Replace static tooling with equivalent enforcement.** Map Biome rules, exclusions,
   import organization, Tailwind parsing, and formatting to Oxlint/Oxfmt. Verify the
   type-aware checker covers the same root/harness/desktop graphs before retiring
   existing typecheck commands. Keep one authoritative formatter/linter per scope;
   temporary comparison is not a permanent dual-tool setup.
6. **Remove replaced machinery and compare results.** Delete obsolete navigation
   switches, adapters, configs, and scripts. Require smaller initial route payloads,
   no material streaming/startup regression, preserved behavior, and fewer permanent
   ownership layers before calling the migration an improvement.

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
