# Cowork UI Audit — Everything We Can Fix, Improve, and Make Feel Real

**Date:** 2026-07-08  
**Scope:** Desktop (`apps/desktop`), Mobile (`apps/mobile`), design system, glitch root causes, a11y, product IA  
**Method:** Static code analysis across ~200 UI files plus 10 parallel deep-dives (chat feed, composer, sidebar, settings, design tokens, glitch architecture, a11y, tasks/research/canvas, mobile, competitive product audit)

---

## Diagnosis (why it feels glitchy / unfinished)

The bones are closer to Cursor/Claude than most AI wrappers — workspace shell, activity-grouped tools, approvals, cost tracking, quick chat. The quality gap is not “missing features.” It’s:

1. **Streaming thrash** — every token rewrites Zustand → re-renders shell/sidebar → re-parses markdown → fights scroll
2. **Competing layout owners** — scroller remount + auto-scroll + `content-visibility` height lies + composer spacer
3. **Dual/overlapping chrome** — two titles, two usage UIs, hover-only actions, modes without hierarchy
4. **Power surfaces that feel like admin panels** — Tasks form tax, Settings mega-pages, Research incomplete lifecycle
5. **Mobile is a capable companion scaffold**, not a finished chat app yet

---

## P0 — Fix these first (broken / trust-breaking / glitchy)

### Glitches & performance

| # | Issue | Where | Fix |
|---|--------|--------|-----|
| 1 | **Every token re-renders shell + sidebar** | `App.tsx`, `Sidebar.tsx` subscribe to whole `threadRuntimeById`; deltas also touch `threads[].lastMessageAt` | Narrow selectors; stop updating thread list on intermediate tokens; rAF-coalesce feed patches (1 commit/frame) |
| 2 | **Full Streamdown reparse every token** | `FeedRow` → `DesktopMarkdown` (~1.6k LOC) on each delta | Stream plain text / lightweight MD while live; full Streamdown on complete; debounce 50–100ms |
| 3 | **Scroll jumps** | `message-scroller.tsx`: `content-visibility:auto` + fixed `10rem` intrinsic size | Drop CV until real virtualization, or measure real heights |
| 4 | **Scroller remount on hydrate** | `ChatFeed`: `key={threadId:hydrating\|ready}` | Key only on `threadId`; soft-reset scroll |
| 5 | **Multiple scroll owners fight** | `InitialTurnRestore` + autoScroll + working placeholder + composer `ResizeObserver` spacer | One-shot restore on thread open; stable placeholder height; padding-bottom instead of spacer item; only stick-to-bottom when near end |
| 6 | **Activity timeline hijacks internal scroll** | `ActivityGroupCard` sets `scrollTop = scrollHeight` every delta | Stick only if already near bottom |
| 7 | **Activity chrome swaps compact ↔ card mid-turn** | Approval flips structure | One shell; only badge/status changes |
| 8 | **Source-task lock double-reserves bottom space** | In-flow lock bar + 140px overlay reservation | Measure all bottom chrome through one overlay |
| 9 | **Theme flash on launch** | Light CSS default; theme applied in React effect | Blocking theme script in `index.html`; match Electron `backgroundColor` |

### Composer / control safety

| # | Issue | Where | Fix |
|---|--------|--------|-----|
| 10 | **Draft text leaks across threads** | Single global `composerText` | Per-thread draft map; save/restore on switch |
| 11 | **Stop disappears when typing a steer** | Busy + any text → Send only | Always show Stop while busy |
| 12 | **Mention highlight overlay desyncs caret** | Chips use `font-medium` + padding that change advance width | Overlay metrics must match textarea 1:1 |
| 13 | **Esc cancels in-flight turn aggressively** | `App.tsx` global Escape | Layer-aware Esc; confirm for long runs; never cancel when a menu/dialog is open |
| 14 | **No in-app toasts** | Store `notifications` → OS only | In-app toast stack; OS toast optional |

### Security / trust

| # | Issue | Where | Fix |
|---|--------|--------|-----|
| 15 | **Forget trusted phone = no confirm** | `RemoteAccessPage` | Confirm dialog; stronger for “forget all” |
| 16 | **`--muted` token collision** | `theme-bridge.css` sets `--muted` to text; bubble hover mixes text into bg | Align `--muted` to surface fill |

### Mobile P0

| # | Issue | Fix |
|---|--------|-----|
| 17 | **No stop during streaming** (only with pending approval) | Always-available stop |
| 18 | **No pin-to-bottom / jump-to-latest on stream** | Follow-tail when near bottom |
| 19 | **Nested ScrollView inside FlatList activity cards** | Kill nested scroll; expand or sheet |
| 20 | **Primary destinations buried in `⋯` menus** | Real bottom tabs |
| 21 | **Almost zero a11y labels** | Labels on rows, approvals, send, expand state |

---

## P1 — High-impact “feels cheap / unfinished”

### Chat feed & daily driver

1. **Expandable tool details** — tools fold into activity groups; `ToolCard` detail path is effectively dead in normal streams. Expand rows for args/output.
2. **Don’t auto-slam activity shut on complete** — loses context when people want the audit trail.
3. **Working → activity handoff flicker** — single persistent live header that morphs.
4. **Copy copies raw storage** (attachments/canvas XML), not rendered text.
5. **Attachment-only turns unanchored** — always wrap in user bubble; image thumbnails.
6. **Hover-only message actions** eating footer space — overlay toolbar; regenerate/edit where protocol allows.
7. **Reading column mismatch** — `max-w-[56rem]` scroller vs `max-w-3xl` rows → empty right gutter.
8. **No streaming caret / incomplete-markdown mode** on live assistant bubble.
9. **Composer typing re-renders whole feed** — isolate `composerText` into a child.
10. **Todos invisible mid-chat** unless context sidebar open — compact in-feed plan card.
11. **Sandbox approval double-submit** — disable after first answer.
12. **Recovered tool-error filtering too aggressive** — only suppress superseded same-tool retries.
13. **Timestamps / day separators** missing.
14. **“N new messages”** chip when not pinned (not just arrow).

### Composer

15. **IME composition** — ignore Enter while `isComposing`.
16. **Paste screenshots / clipboard files**.
17. **Attachment hard-fail (chat) vs soft-skip (landing)** — unify.
18. **Submit race** — ref lock before async attach prep.
19. **@mentions are skills/plugins only** — add files or teach placeholder honestly.
20. **Steer lifecycle clarity** — pending chip / undo; free the draft.
21. **Attachment errors as walls of text** — compact dismissible banner.
22. **Cmd+Enter inserts newline** (anti-pattern) — document or map to send.
23. **Mention menu not caret-anchored**; incomplete combobox ARIA.
24. **Dense footer** (model + reasoning + paperclip + send) wraps badly — overflow menu for secondary.

### Sidebar / navigation

25. **No sidebar search** for threads.
26. **Hover-only ⋯ / +** — always show on selected; `@media (hover:hover)` for pure hover.
27. **Busy threads hide overflow menu** entirely.
28. **RMB menu ≠ overflow menu** (archive/rename missing from context).
29. **Archive feels like delete** — undo toast; optional Archived section.
30. **Project “New chat” skips landing** (violates product rule).
31. **Inconsistent show-more** (5 vs 10; projects unlimited; tasks silent truncate).
32. **No list keyboard model** (arrows/typeahead).
33. **Context sidebar crowded** — tabs: Plan / Agents / Files / Preview (canvas shouldn’t erase todos).

### Settings

34. **IA overload** — rename Defaults → Behavior; split Models stack; demote Skill Improvement beta.
35. **Search settings card-on-card-on-card**.
36. **Silent auto-saves** — error feedback; dirty+Save for multi-field text.
37. **AI full-payload traces switch** needs confirm.
38. **Missing diagnostics upload toggle on Privacy**.
39. **Archived chats + backups** need search.
40. **Distinct icons** for Models vs Subagents.

### Design system / chrome

41. **No type/spacing/elevation/radius scale** — ad hoc `text-[9px]`–`text-[11.5px]` everywhere.
42. **Microtype + opacity** fails contrast (`/48`, `/65` on 9–10px).
43. **High-contrast mode is a stub** (2 tokens only).
44. **Reduced motion incomplete** — global kill-switch for animate-in, sidebars, Framer onboarding.
45. **Z-index wars** — document scale; portal everything floating.
46. **Three focus-ring recipes**.
47. **Dual color systems** (semantic vars vs `dark:` forks).
48. **win32/linux CSS nearly duplicated**.

### First impression / product trust

49. **Branded boot** instead of bare `Starting...`.
50. **Error title “Recovered”** is wrong — “Couldn’t start”.
51. **Onboarding Esc dismisses into half-broken app**.
52. **Starter chips on NewChatLanding** (today only in onboarding).
53. **Ambient connection banner** (not only in-feed disconnected card).
54. **Jargon pass**: thread→chat, hard cap→spending limit, transcript only→read-only archive, etc.
55. **Single title + single usage chip** (kill dual top-bar / floating header density).
56. **Default-collapse completed tools** with human summary (“Edited 3 files · Ran tests”).

### Tasks / Research / Canvas / secondary

57. **Task layout inverted** (form center, conversation side) — match chat: conversation primary.
58. **New Task form tax** — one field → agent drafts plan; advanced expands.
59. **Empty projects = dead form** with no explainer.
60. **Cancel task no confirm**.
61. **Blocking questions buried** — sticky banner + top-bar badge.
62. **Artifacts show raw JSON** — human provenance; reuse FilePreview.
63. **Research: no empty state, ignore loading flag, no delete/archive**.
64. **New research = bare composer**, no hero/examples.
65. **Canvas MD uses `document.execCommand`** + silent autosave — real editor + Saved/Error chip.
66. **PPTX/Slide previews** decorative/inconsistent with Canvas chrome.
67. **Command palette missing** Tasks/Research/Stop/model/sidebars.
68. **ConnectPage** still pre-design-system inline CSS.

### A11y (desktop)

69. **Live timer spams `role="status"` every second** — announce phase changes only.
70. **No live region strategy for assistant stream**.
71. **Thread details “dialog” has no focus trap**.
72. **Composer focus ring killed** — soft ring on focus-within shell.
73. **Cmd+K not in app menu** / no shortcut legend.
74. **File explorer ⋯ hover-only without focus-within**.

### Mobile P1

75. **Real NativeTabs** (not stack pretending to be tabs).
76. **Settings as grouped lists**, not desktop marketing cards.
77. **System font for chrome**; Plex only for message content.
78. **Composer offline/empty states conflated**.
79. **iOS composer ignores `disabled` for editing**.
80. **Thread load/send failures only `console.error`**.
81. **Virtualize home + memo markdown**; tune FlatList.
82. **Android pairing quality** lags iOS SwiftUI path hard.
83. **Model indicator** in thread header; mount or delete dead `SubagentBar`.

---

## P2 — Polish that makes it feel premium

### Chat & composer

- Soft virtualization for long threads (true windowing)
- Reasoning section stable keys (no remount flicker)
- Clipboard failure feedback
- Clear copy timeouts on unmount
- Full-pane file drop overlay
- Raise default composer max height (~160–200)
- Resizer rename: “max message height” (not min)
- Attachment overflow: +N more after 2 rows
- Friendlier steer copy (“Add guidance…”)
- Esc-to-stop / Cmd+U attach shortcuts

### Sidebar & explorer

- Draft badge; empty chats CTA match projects
- Archive confirm; fix stale “hover date” copy
- File explorer roving tabindex + filter
- Cap expanded project lists like chats
- Skeleton while explorer loading
- Prefer transform for collapse (less reflow)

### Settings & secondary

- Defaults Behavior → `SettingsRow` + Switch
- MCP load skeleton; Remote error banner + retry
- Subagent/memory/skill-improvement list search
- Plain-English first sentences; jargon secondary
- Plan refine uses shared Textarea
- Keep research reasoning after complete (collapsed)
- Follow-up inline under report, not only FAB
- Shared Empty/Loading primitives across modes
- Status badge vocabulary unified
- Prompt modal: match sandbox visual language; Y/N shortcuts
- Onboarding: step labels; top-3 providers first
- Menu bar: title fallback “New chat”
- Spreadsheet filename in titlebar

### Design

- Motion tokens (`--motion-fast/base/slow`)
- Density mode (`compact|comfortable`)
- Narrow window layout for dual sidebars
- Opaque modals; acrylic only for menus on Win/Linux
- Tooltip delay 300–400ms (not 0)
- Hit targets ≥ 28–32px for chrome
- Fix thinking shimmer under reduced-motion (transparent fill)
- Selection/scrollbar token unify
- Design system doc (`docs/desktop-design-system.md`)

### Product delight

- Subtle message enter (opacity + 4px, respect reduced motion)
- Optional completion chime when unfocused (off by default)
- Projects-vs-Chats one-time coachmark
- Plugins → Settings/palette; sidebar less crowded
- Skills in palette insert `@skill`, not only open browser

---

## P3 — Nice-to-have / later

- In-app light/dark override (not only system)
- i18n string extraction
- Multi-select / export thread
- Canvas request “open file” action
- Density of 9px micro-headers
- Theme FOUC edge cases on slow disks
- Mobile: swipe archive, Dynamic Type full pass, reduce-motion for LayoutAnimation
- Research settings file rename (Popover → Dialog)
- Dead `DraftThreadModelSelector` consolidation

---

## What to remove or simplify (complexity debt)

| Cut | Why |
|-----|-----|
| Floating dual title / overlapping usage UIs | Two centers of gravity |
| Message-bar resizer for normal users | Auto-grow is enough |
| Sidebar section drag-reorder as default | Accidental reordering |
| New Task multi-field form as default path | Highest friction surface |
| Empty three-panel context sidebar | Wastes half the window |
| Nested cards in Search settings | Visual noise |
| Card-stack mobile settings hubs | Web-in-a-shell |
| Engineer jargon in primary chrome | Trust & brand |

**Keep** (presentation only): workspaces, approvals, activity groups, canvas, quick chat, cost tracking.

---

## Architecture: glitch root causes (technical)

```
token delta
  → full threadRuntimeById replace (unbatched)
  → ChatShell + Sidebar re-render
  → buildChatRenderItems + citation Maps
  → Streamdown full reparse
  → message height changes
  → content-visibility 10rem lies
  → autoScroll + InitialTurnRestore + composer spacer fight
  → user feels jank
```

### Severity summary (glitch investigation)

| ID | Issue | Sev |
|----|--------|-----|
| A | Full-map store subscriptions (ChatShell/Sidebar) + lastMessageAt on deltas | **P0** |
| B | Unbatched per-token store updates | **P0** |
| C | Full Streamdown reparse every token | **P0** |
| D | Scroll owner fights (remount + restore + autoScroll + CV + spacer) | **P0** |
| E | No real virtualization | **P1** |
| F | Theme FOUC on launch | **P1** |
| G | Optimistic/steer residual races | **P1** |
| H | Activity collapse / CSS height animations | **P2** |
| I | ResizeObserver feedback with composer/scroller | **P2** |
| J | Dialog focus steal / restore | **P2** |
| K | Quick-chat cold start + blur cost | **P2** |

### Highest-leverage engineering sequence

1. rAF-coalesce feed patches
2. Narrow store selectors (never whole runtime map)
3. Stop `touchLastMessageAt` on stream deltas
4. Plain text while streaming; full MD on complete
5. Stop remounting MessageScroller; fix CV
6. Per-thread drafts + always-visible Stop
7. Blocking theme bootstrap

### Key files (glitch path)

| Concern | Files |
|---------|--------|
| Store / stream | `apps/desktop/src/app/store.ts`, `store.helpers/threadEventReducer/feedProjection.ts`, `store.feedMapping.ts` |
| Shell subscriptions | `apps/desktop/src/App.tsx`, `ui/Sidebar.tsx` |
| Feed / scroll | `ui/chat/ChatFeed.tsx`, `components/ui/message-scroller.tsx`, `ui/ChatView.tsx` |
| Markdown | `ui/markdown/DesktopMarkdown.tsx`, `ui/chat/FeedRow.tsx` |
| Activity | `ui/chat/ActivityGroupCard.tsx`, `ui/chat/activityGroups.ts` |
| Paint scheduling | `app/store.helpers/paintScheduling.ts` (used for select, not stream) |

### Test coverage notes

- **Good:** `chat-feed-scroller.test.tsx`, optimistic cmid coverage, window appearance paint, window-mode tests
- **Missing:** token-rate re-render assertions; scroll stability under streaming height growth; composer RO + spacer; FOUC/theme bootstrap; selector subscription breadth; steer optimistic UI

---

## Chat feed audit (detail)

### P0

1. `content-visibility:auto` + fixed intrinsic height → scroll jumps (`message-scroller.tsx`)
2. Hydration remount resets scroller (`ChatFeed` provider key)
3. Source-task lock double-reserves bottom space (`ChatView`)
4. Activity approval state swaps compact ↔ card chrome
5. Live activity timeline hijacks internal scroll
6. Tool error recovery hides earlier failures indiscriminately (`filterRecoveredToolErrors`)

### P1

7. Tool detail UI effectively dead in main feed
8. Auto-collapse on turn complete
9. Reasoning section keys remount during stream
10. “Working” handoff flicker
11. Copy copies storage text, not rendered text
12. Attachment-only user turns unanchored
13. No image/video attachment previews
14. Message footer always consumes vertical space
15. Asymmetric column widths
16. `ChatThreadHeader` unused in live shell
17. No streaming caret / incomplete-markdown mode
18. Full feed re-render on composer keystrokes
19. Per-delta Zustand feed rewrites without UI coalescing
20. Citation carousel controls hover-only
21. Sandbox approval can double-submit
22. Empty/hydrating states weak (no skeleton)

### P2–P3 highlights

- No timestamps / day separators
- No regenerate / edit / branch actions
- Feed not a proper message list for SR
- Elapsed timer 1s interval re-renders live card
- `InitialTurnRestore` races on every new user turn
- Todos never appear in chat feed
- No “N new messages” badge
- Favicon carousel external Google dependency
- Soft virtualization gap (full DOM up to `MAX_FEED_ITEMS`)

---

## Composer audit (detail)

### P0

1. Global draft text leaks across threads
2. Stop control disappears while composing a steer
3. Mention chip styling desyncs caret vs highlight overlay

### P1

4. No IME composition guard on Enter-to-send
5. No paste-to-attach
6. Hard fail on any attachment skip (chat) vs soft note (new chat)
7. Double-submit race while preparing attachments
8. Mentions are skills/plugins only — not files/paths
9. Steer text not cleared until `steer_accepted`
10. Attachment errors dominate composer with no dismiss

### P2–P3 highlights

- Enter ignores submit disabled state
- Cmd/Ctrl+Enter inserts newline
- Mention menu not caret-anchored
- Incomplete combobox ARIA
- Blur closes menu immediately
- Highlight scroll sync misses value-driven layout
- Thin placeholders; dense toolbar wrap
- Resizer mislabeled as minimum height
- Landing vs thread validation diverge
- `MAX_TURN_REFERENCES = 32` silently truncates
- Status row height jump
- Default `messageBarHeight` 96 often too tight

---

## Sidebar & navigation audit (detail)

### P1 themes

- Archive recovery only in Settings; no undo
- Hover-only touch path for ⋯ / +
- Busy hides overflow
- Context menu ≠ overflow menu
- No sidebar search
- Project context “New chat” skips landing
- No list keyboard model
- No virtualization for large histories

### P2 themes

- Drafts mixed without badge
- Tasks nested only under projects
- Density constants 5 vs 10 vs unlimited projects
- Context packs todos + subagents + files in one narrow column
- Canvas hijacks right width without messaging
- File explorer: every row `tabIndex={0}`; custom double-click; no filter
- macOS collapsed title offset hard-coded `10rem`

### What’s already solid

- Projects vs Chats collapse matches product contract
- Width clamps + persistence + RAF-throttled drag resize
- Overflow menu design direction (undercut by hover/busy gates)
- Reduced-motion paths for thread region
- Skip-to-content link in chat shell

---

## Settings audit (detail)

### Nav inventory (packaged, remote on)

~12–14 items: Models, Subagents, Tool Access, Defaults, Profile & Memory, Remote access, Backups, Chats, Usage, Privacy, Desktop, Updates, Experiments, Diagnostics

### Highest-priority fix pack

1. **P0:** Confirm before forget / forget-all trusted devices
2. **P1:** Flatten Search nested cards; fix copy paths
3. **P1:** Privacy: diagnostics upload Switch + confirm AI payload traces
4. **P1:** IA: rename Defaults; split/anchor Models; demote Skill Improvement beta
5. **P1:** Archived chats + backups list search
6. **P2:** Normalize Defaults Behavior to `SettingsRow`; unify empty/loading
7. **P2:** Distinct Subagents icon; merge Apps shell search

### What’s already strong

- Intent-based nav + legacy aliases
- Switch-for-binary guidance largely followed
- Packaged gating for experiments
- Escape closes settings only when no open dialog
- Manage Models, MCP progressive disclosure, profile dirty/save, YOLO confirms

### Files most touched by fixes

- `ui/settings/SettingsShell.tsx`
- `ui/settings/pages/SettingsIntentPages.tsx`
- `ui/settings/pages/WorkspacesPage.tsx`
- `ui/settings/pages/ToolAccessPage.tsx`
- `ui/settings/pages/MemoryPage.tsx`
- `ui/settings/pages/RemoteAccessPage.tsx`
- `ui/settings/pages/PrivacyTelemetryPage.tsx`
- `ui/settings/pages/ArchivedChatsPage.tsx`
- `ui/settings/pages/BackupPage.tsx`
- `ui/settings/pages/DeveloperPage.tsx`

---

## Design system audit (detail)

### Architecture snapshot

| Layer | Location | Role |
|---|---|---|
| Palette primitives | `styles/tokens/base.css` | Sage light/dark hexes |
| Platform glass | `tokens/platform.css` | Vibrancy/acrylic + reduced transparency |
| Semantic bridge | `theme-bridge.css` | Surfaces → Tailwind/`@theme` + shadcn vars |
| Utility classes | `token-utilities.css` | `app-surface-*`, `app-text-*`, `app-shadow-*` |
| Platform chrome | `platform/{shared,darwin,win32,linux}.css` | Titlebar, drag, card L-cut |
| Global chrome | `styles.css` | Focus, scrollbars, selection, shell, motion |
| Primitives | `components/ui/*` | shadcn/radix-vega |

### Priority roadmap

| Priority | Work |
|---|---|
| **P0** | Fix `--muted` / bubble hover; define single focus + portal z-index contract |
| **P1** | Global reduced-motion kill-switch; finish high-contrast pack; type floor + kill microtype/opacity abuse; token type/space/elevation/radius |
| **P2** | Consolidate win32/linux CSS; opaque modal policy; density; chat narrow layouts; purge `text-white`/`bg-black/50`; motion tokens |
| **P3** | Scrollbar/selection unify; font weight normalize; design doc; optional theme override |

### What’s already in good shape

- Local IBM Plex with `font-display: swap` and variable Sans
- Three-tier token story: base → platform glass → semantic bridge → utilities
- Reduced transparency attribute solidifies glass
- Portal container → `document.body`
- `--desktop-portal-layer` override for data-slot overlays
- Composer focus-ring opt-out (avoids double frame)
- Platform chrome CSS variables from contract

### Suggested package (1–2 PRs)

1. **Token hygiene PR:** fix muted collision; add type/radius/elevation/motion tokens; global `prefers-reduced-motion`; HC pack; scrim/destructive foreground
2. **Chrome polish PR:** merge win32/linux overlay CSS; modal opaque + acrylic menus only; z-index scale; density attribute; chat narrow layout; kill 9–11px whisper labels

---

## Tasks / Research / Canvas / secondary surfaces

### Tasks mode

| Sev | Finding | Fix |
|-----|---------|-----|
| P1 | Layout inverted vs main chat | Conversation primary; brief/plan in right rail |
| P1 | New Task is high-friction admin form | One field → agent drafts plan |
| P1 | Empty projects = dead select | Empty state + CTA to add project |
| P1 | Cancel task no confirm | Confirm dialog |
| P1 | Questions card easy to miss | Sticky alert + top-bar badge |
| P1 | Artifact review developer-facing (JSON) | Human provenance; reuse FilePreview |
| P2 | Loading bare text; review actions no pending; flat work plan; multi-thread chrome cramped | Skeleton, spinners, status chips, thread switcher |

### Research

| Sev | Finding | Fix |
|-----|---------|-----|
| P1 | Empty list blank; loading flag never rendered | Empty state + skeletons |
| P1 | New research no hero/copy | H1 + value prop + example chips |
| P1 | No delete/archive | Lifecycle actions |
| P2 | Follow-up FAB only; reasoning disappears when done; sources default closed | Inline composer; collapsed reasoning; auto-open sources |
| P2 | Not in Command Palette / menu bar | Feature-flagged actions |

### Canvas & previews

| Sev | Finding | Fix |
|-----|---------|-----|
| P1 | MD editing via `document.execCommand` | TipTap/CodeMirror or source-primary |
| P1 | Autosave every 500ms, no status | Dirty/Saving/Saved/Error chip |
| P1 | PPTX/Slide feel separate product | Compact chrome matching Canvas |
| P2 | Agent prompt always visible without thread clarity; selection toolbar can clip | Disable with CTA; clamp to viewport |
| P2 | Canvas vs modal dual paths confuse users | Explicit “Open in Canvas” vs “Quick preview” |

### Other secondary

- **Command palette:** missing Tasks/Research/Stop; skills items only open browser
- **Prompt modal:** ask richer than approval; document Esc-skip
- **Onboarding:** dots only; dense provider list; “Not now” re-entry
- **Quick chat / menu bar:** solid base; empty titles; chat-only
- **ConnectPage:** offline from design system (inline styles)
- **PrimaryContent error:** title “Recovered” is contradictory

### What already works well

- `WorkspaceRuntimeProgress` — clear phases, a11y
- QuickChatShell / MenuBarUtilityShell popup chrome
- Research detail streaming skeleton, sources panel, export, plan approval
- Artifact restore confirm; terminal locks
- Canvas truncation banner preventing partial overwrite
- Prompt ask modal option chips + skip semantics

---

## Mobile audit (detail)

### Native feel

- Tabs route group is **not** tabs (Stack only) — use NativeTabs
- Settings/workspace hubs are desktop marketing cards — use grouped lists
- Brand font on chrome vs system — Plex for messages only
- SFSymbol component is never SF Symbols on iOS
- Liquid glass iOS-only; Android solid bar is fine if intentional

### Control loop (P0/P1)

- Stop only with pending request — not during stream
- No auto-follow stream / jump-to-latest
- Nested ScrollView in activity cards steals scroll
- Composer disabled conflates empty vs offline
- iOS composer ignores `disabled` for editing
- Thread load/send failures only log
- Almost no a11y labels / expanded state

### Parity vs desktop (that matters on phone)

| Sev | Gap | Fix |
|-----|-----|-----|
| P0 | Interrupt during turn | Always-available stop |
| P0 | Approvals/asks | Present — polish a11y |
| P1 | Model/provider context | Header subtitle |
| P1 | Attachments | Wire or honest “desktop only” |
| P2 | SubagentBar exists but unmounted | Wire or delete |
| P2 | Task/research/canvas | OK to defer for companion v1 |

### What’s already good

- Token parity with desktop olive palette
- iOS pairing (SwiftUI list, swipe-delete, camera empty state)
- Thread home grouped chats/projects, search, pull-to-refresh, disconnect banner
- Offline cache + read-only composer helper
- Activity timeline + markdown + sources ambition
- Pending approval/ask cards mirror desktop tone

---

## Accessibility / keyboard / interaction (desktop)

### P0

1. Escape cancels in-flight turn with no confirm and weak ownership
2. In-app notifications missing — OS-toast-only

### P1

3. Command palette shortcut undiscoverable / off app menu
4. Thread details is a fake dialog (no focus trap)
5. Mention combobox incomplete ARIA
6. Composer has no visible focus ring
7. Sidebar/explorer actions hover-primary
8. Escape hierarchy overloaded
9. Live activity timer spams SR every second
10. Assistant stream has no dedicated live region
11. Composer status / attachment errors weak for AT
12. Clipboard failures silent
13. Enter-to-send accidental; shortcuts unlabeled
14. Native context menus vs Radix overflow diverge
15. Drag-drop ring only — no SR messaging

### P2

- Tooltip delay 0ms
- Hit targets below 24–44px common
- Thinking shimmer vanishes under reduced-motion
- Focus ring contrast
- Error recovery inconsistent
- Global `user-select: none` easy to regress
- Copy affordance hover-revealed
- Command palette focus return to composer

### What’s already in good shape

- Skip link; main landmarks
- Widespread `aria-label` on icon buttons
- Resizers keyboard + valuetext
- File tree roles
- Reduced motion (partial) + high contrast hooks
- Composer submit states
- Thread overflow as keyboard alternative to hover archive
- Working / upload some `aria-live`

---

## Product design competitive audit

### Verdict

The bones are closer to Cursor/Claude than most AI wrappers. The gap to “premium daily driver” is **cognitive load, incomplete first-run story, thin power-user surface, and dual/overlapping chrome** — not missing backend capability.

### A) First impressions

| # | Priority | Impact | Effort | Recommendation |
|---|----------|--------|--------|----------------|
| A1 | P0 | High | M | Collapse onboarding to 3 beats ending in live chat |
| A2 | P0 | High | S | Never Esc-dismiss setup into half-broken app |
| A3 | P0 | High | M | Branded boot (match WorkspaceRuntimeProgress quality) |
| A4 | P1 | High | S | Fix “Recovered” error headline |
| A5 | P1 | High | S | Starter prompts on NewChatLanding |
| A6 | P1 | Med | S | Guided empty after skip |
| A7 | P2 | Med | M | One-time Projects vs Chats coachmark |
| A8 | P2 | Low | S | Warmer welcome outcome copy |

### B) Daily driver loop

| # | Priority | Impact | Effort | Recommendation |
|---|----------|--------|--------|----------------|
| B1 | P0 | High | M | Kill dual title chrome |
| B2 | P0 | High | M | One progressive usage chip |
| B3 | P0 | High | M | Tool activity: summary first, expand for raw |
| B4 | P1 | High | S | Protect composer — don’t pile more footer controls |
| B5 | P1 | High | M | Inline command approvals; Y/N keyboard |
| B6 | P1 | Med | S | Working microcopy from live activity |
| B7 | P1 | Med | M | Consistent model control + “default vs this chat” |
| B8 | P2 | Med | S | Hide message-bar resizer for most users |
| B9 | P2 | Med | M | Context sidebar: collapse empty; files-first for projects |
| B10 | P2 | Low | S | Weak empty thread state |

### C) Power user loop

| # | Priority | Impact | Effort | Recommendation |
|---|----------|--------|--------|----------------|
| C1 | P0 | High | M | Cmd+K as real command palette |
| C2 | P0 | High | M | In-app keyboard map |
| C3 | P1 | High | L | Task mode: one field, not Jira form |
| C4 | P1 | Med | M | Palette + sidebar parity for Tasks/Research |
| C5 | P1 | Med | S | Quick chat intentional identity |
| C6 | P2 | Med | S | Quieter multi-workspace defaults |
| C7 | P2 | Low | S | Skills in palette insert mention |

### D) Trust & clarity

| # | Priority | Impact | Effort | Recommendation |
|---|----------|--------|--------|----------------|
| D1 | P0 | High | M | Ambient connection status banner |
| D2 | P0 | High | S | Rename engineer jargon in UI |
| D3 | P1 | High | M | Approvals as permanent subtle brand state |
| D4 | P1 | Med | S | Cost chip: dollars first, breakdown one click |
| D5 | P1 | Med | S | Runtime-progress pattern for OAuth/reconnects |
| D6 | P2 | Med | S | Cross-thread approval focus management |
| D7 | P2 | Low | S | Branded crash boundary + report path |

### E) Delight

| # | Priority | Impact | Effort | Recommendation |
|---|----------|--------|--------|----------------|
| E1 | P1 | Med | S | Lean into olive brand; less generic-shadcn gray |
| E2 | P1 | Med | S | Subtle message entrance motion |
| E3 | P2 | Low | S | Optional completion sound when unfocused |
| E4 | P2 | Med | S | Microcopy pass (Plugins vs Skills, etc.) |
| E5 | P2 | Low | M | Cowork mark on empty/landing |
| E6 | P3 | Low | S | No fake haptics |

### F) What to remove or simplify

See [What to remove or simplify](#what-to-remove-or-simplify-complexity-debt) above.

### G) Information architecture redesign

#### Current IA

```
Shell
├── Left: New Chat / New Task? / Research? / Plugins | Projects* | Chats* | Settings
├── Center: Chat | Task | Research | (Settings replaces shell)
└── Right: Context (todos/agents/files) OR Canvas OR Task conversation
+ Overlays: Onboarding, PromptModal, CommandPalette, QuickChat, Menu bar utility
```

#### Problems

1. Primary actions and destinations mixed
2. Chat / Task / Research as three products without clear mode hierarchy
3. Projects vs Chats under-explained
4. Context vs Canvas hard-swap loses todos
5. Settings full-shell is good but too many peer pages for day-1

#### Recommended IA

```
Left rail (stable)
├── Search / ⌘K
├── New chat
├── Recents (smart mix)
├── Projects (expand → chats + tasks)
└── Settings · (optional Research if enabled)

Center
└── Conversation OR Task OR Research (mode chip in top bar)

Right (tabs, not hard swap)
└── [Plan/Todos] [Agents] [Files] [Preview]

Overlays
└── Approvals inline · Ask modal · Palette · Quick chat
```

### H) 30-day polish sprint

#### Week 1 — First impression + glitch kill

| Order | Item | Impact | Effort |
|------:|------|--------|--------|
| 1 | Branded boot + fix “Recovered” | High | S |
| 2 | Onboarding Esc guard + sticky finish-setup | High | S |
| 3 | Starter chips on NewChatLanding | High | S |
| 4 | Ambient connection banner | High | M |
| 5 | Jargon pass | High | S |
| 6 | Collapse onboarding steps | High | M |
| — | Stream batching + narrow selectors + MD strategy | High | M |
| — | Scroller remount + content-visibility | High | M |
| — | Per-thread drafts + Stop while busy | High | M |
| — | Theme FOUC; forget-device confirm | High | S |

**Exit criteria:** Cold install → folder → one provider → landing with starters → first message, without confusion or Escape trap. Streaming feels stable.

#### Week 2 — Daily chat calm

| Order | Item | Impact | Effort |
|------:|------|--------|--------|
| 7 | Remove dual title; single usage chip | High | M |
| 8 | Default-collapse tool groups + live status copy | High | M |
| 9 | Inline command approvals + Y/N | High | M |
| 10 | Context sidebar: hide empty; files-first | Med | S |
| 11 | Kill message-bar resizer for normal mode | Med | S |
| 12 | Plugins vs Skills microcopy consistency | Med | S |
| — | Activity scroll hijack + auto-collapse policy | High | M |
| — | Message chrome (copy, attachments, overlay actions) | High | M |
| — | Mention overlay metrics + IME + paste images | High | M |
| — | Hover→focus-visible chrome in sidebar | High | S |

**Exit criteria:** Mid-turn chat feels quiet; approvals feel designed; no double headers.

#### Week 3 — Power user + secondary products

| Order | Item | Impact | Effort |
|------:|------|--------|--------|
| 13 | Command palette v2 | High | M |
| 14 | In-app keyboard reference | Med | S |
| 15 | Task create: one-field brief | High | L |
| 16 | Quick chat polish | Med | S |
| 17 | Sidebar: active-project-only expand default | Med | S |
| — | Research empty/loading/delete | High | M |
| — | Canvas save status + honest MD edit path | High | M |
| — | Settings IA + Search flatten + Privacy confirms | High | M |
| — | In-app toasts | High | M |

**Exit criteria:** Can drive core app without mouse; task start &lt; 30 seconds.

#### Week 4 — Design system + mobile shell

| Order | Item | Impact | Effort |
|------:|------|--------|--------|
| 18 | Right pane tabs (Plan / Agents / Files / Preview) | High | M |
| 19 | Settings nav simplify (Advanced collapse) | Med | S |
| 20 | Motion + reduced-motion | Med | S |
| 21 | Optional done-chime when unfocused | Low | S |
| 22 | Brand pass on empty states | Med | S |
| 23 | Remove section-reorder from default UX | Low | S |
| — | Token type/space/elevation + HC pack | High | M |
| — | Mobile: tabs, stop, auto-follow, nested-scroll, a11y | High | M |

**Exit criteria:** App feels intentional in screenshots; power features remain; defaults are quiet.

### Opinionated product principles

1. **`NewChatLanding` is the hero** — route every first-run and empty path through it
2. **Approvals and cost are brand, not debug panels** — keep them, calm the presentation
3. **Activity groups are the right transcript model** — default UI should summarize, not stream logs
4. **Tasks must not look like a Jira form** or they’ll lose to plain chat forever
5. **Cmd+K is unfinished** — with only navigation crumbs, the app fails the Raycast/Linear power-user test despite deep backend capability
6. **Distinctive sage chrome is an asset** — polish consistency beats adding modes
7. **Complexity debt is mostly dual chrome + multi-mode without hierarchy**, not lack of features

### Competitive bar

| Competitor | Steal this |
|------------|------------|
| **Cursor** | Quiet tool summaries, instrumental feel, solid palette |
| **Claude Desktop** | Calm mid-turn chrome, approval trust |
| **ChatGPT** | Day separators, jump-to-latest, empty calm |
| **Linear/Raycast** | Cmd+K as real OS for the app |
| **You already win on** | Workspace-first model, sandbox approval cards, cost awareness, olive brand, activity-group abstraction |

---

## Top 15 if you only do these

1. Stream coalesce + narrow selectors + stream plain MD
2. Scroll stability (no remount, fix CV, one scroll owner)
3. Per-thread drafts + Stop always while busy
4. Mention overlay 1:1 metrics
5. Branded boot / fix Recovered / ambient connection
6. Single chrome title + usage chip
7. Collapsed tool activity + expandable details
8. In-app toasts + forget-device confirm
9. Landing starters + onboarding Esc guard
10. Sidebar search + unify menus + show actions on selected
11. Command palette v2 + shortcut legend
12. Task create progressive disclosure
13. Context tabs (don’t kill todos for canvas)
14. Token/type/motion foundations + reduced-motion
15. Mobile: stop, auto-follow, tabs, nested-scroll, a11y

---

## Key file map

| Area | Paths |
|------|--------|
| Shell | `apps/desktop/src/App.tsx`, `ui/layout/*` |
| Chat | `ui/ChatView.tsx`, `ui/chat/*` |
| Composer | `ui/chat/ChatComposer.tsx`, `ui/composer/MessageComposer.tsx`, `ui/chat/ComposerMention*.tsx` |
| Sidebar | `ui/Sidebar.tsx`, `ui/sidebar/*`, `ui/sidebarHelpers.ts` |
| Context / files | `ui/ContextSidebar.tsx`, `ui/file-explorer/WorkspaceFileExplorer.tsx` |
| Settings | `ui/settings/**` |
| Tasks | `ui/tasks/**` |
| Research | `ui/ResearchView.tsx`, `ui/research/**` |
| Canvas / previews | `ui/Canvas.tsx`, `ui/FilePreviewModal.tsx`, `ui/*Preview*.tsx` |
| Markdown | `ui/markdown/DesktopMarkdown.tsx` |
| Store / stream | `app/store.ts`, `app/store.helpers/**`, `app/store.feedMapping.ts` |
| Design | `styles/**`, `components/ui/**` |
| Mobile shell | `apps/mobile/src/app/**`, `components/thread/**`, `ComposerBar*` |
| Mobile home | `components/thread-home/**` |
| Mobile pairing | `components/pairing/**` |
| Mobile theme | `theme/**`, `global.css` |

---

## Scope note

- **Desktop** is the main “glitchy / sucks” surface and has the deepest product surface area.
- **Mobile** is a second product: remote companion — fix the control loop (stop, stream follow, tabs, a11y) before parity features.
- Findings are from **static code analysis**; live Playwright/CDP is still recommended for residual motion/scroll repros before declaring Week 1–2 done.

---

## Next steps

1. Sequence into PR-sized slices from the 30-day sprint
2. Ship **Week 1 glitch-kill** first (stream + scroll + drafts + Stop + boot/theme)
3. Re-verify with `bun test --max-concurrency 1`, typecheck, and desktop CDP for chat streaming
