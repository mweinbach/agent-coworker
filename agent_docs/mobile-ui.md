# Mobile UI (Expo / React Native)

Load this file when working in `apps/mobile/`.

## Key files & commands

- App config: `apps/mobile/app.json`, `eas.json`; bundler config: `metro.config.js`, `babel.config.js`
- Native projects: `apps/mobile/ios/`, `apps/mobile/android/`; native modules: `apps/mobile/modules/`
- Commands (from repo root): `bun run app:mobile:dev` (Expo dev client), `bun run app:mobile:ios` / `app:mobile:android`, `bun run app:mobile:typecheck`

## Patterns

- For iOS list reordering, do not force permanent SwiftUI edit mode just to expose move handles; it shows delete controls and reads like a broken settings screen. Use a scoped reorder mode or explicit drag gesture that preserves the intended visual hierarchy.
- Avoid card-on-card mobile layouts for grouped lists; use one grouped container with separators and inline disclosure content unless nested content truly needs a separate surface.

## Verification

- Run an explicit Metro bundle path (e.g. `expo export`) for mobile changes — `run:ios`/`run:android` success alone misses repo-root import and Babel/plugin drift.
- For navigation and accessibility changes, render real iOS and Android component/router trees; source-string assertions are not proof. Commit deterministic platform snapshots when simulators are unavailable, and never claim manual VoiceOver/TalkBack coverage that was not run.
