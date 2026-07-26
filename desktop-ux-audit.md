# Desktop UI/UX audit

Findings from a sweep of `apps/desktop/src/ui/**`, ranked by severity. Every item
cites the code it was found in. No code changed in this pass.

Scope note: this is about *product surfaces* — how state is communicated, how
failures reach the person, how consistent the vocabulary is. It deliberately
excludes visual polish and animation.

---

## P1 — Systemic, affects many surfaces

### 1. Every foreground failure is reported twice, at the same time

**Surface:** all 72 acknowledged operations (settings, providers, workspaces, skills, plugins, backups, memory, connectors, research, tasks)

`runAcknowledgedOperation` does two things in its failure path
(`src/app/store.helpers/operations.ts`): it writes the error into
`operationsByKey`, and it pushes a notification.

- `operationsByKey[key].error` → rendered as a **destructive `Alert`** by
  `OperationFeedback` (`src/ui/OperationFeedback.tsx:33-47`)
- the notification → rendered as a **toast** by `InAppToasts`
  (`src/ui/InAppToasts.tsx:38-51`)

Both render the same `message` and `repairAction`. The person sees one sentence
printed twice, in two places, for one action they took.

**Why it matters:** duplication reads as two separate problems. It also spends
the toast channel — the only surface that can reach someone looking elsewhere —
on information already visible on screen.

**Direction:** a failure belongs where the action happened. If a control is on
screen, report inline next to it; reserve toasts for outcomes the person cannot
currently see.

---

### 2. Task creation has no readiness preflight — and the protocol cannot express one

**Surface:** `src/ui/tasks/NewTaskLanding.tsx`

Chat and research both preflight before starting work (`useCreationReadiness` +
`CreationReadinessNotice`). `NewTaskLanding.tsx` imports neither. Its only submit
gate is local form validity and `submitting` (`:190-196`).

This is not just a missing call — the protocol has no task kind:

```ts
// src/shared/creationReadiness.ts:7
export const creationKindSchema = z.enum(["chat", "research"]);
```

**Why it matters:** a task is the longest-running and most autonomous thing the
product can start. It is the worst place to discover a disconnected provider or
an unavailable model, because the failure surfaces after the person has invested
in composing a work graph — and it surfaces as a downstream error rather than as
a fixable precondition with a repair action.

**Direction:** extend `creationKindSchema` with `"task"` and reuse the existing
preflight + repair-action machinery. The server-side checks (`project_access`,
`provider_connected`, `credentials`, `model_available`, `runtime_ready`) already
apply unchanged.

---

### 3. Toasts never expire, and silently drop the ones you never saw

**Surface:** `src/ui/InAppToasts.tsx`

- There is **no timer anywhere in the file**. Every toast — success or failure —
  persists until manually dismissed via the ✕.
- `MAX_VISIBLE_TOASTS = 3` (`:7`) with `.slice(-MAX_VISIBLE_TOASTS)` (`:19`)
  shows only the newest three. Older ones vanish from view while remaining in
  state, never seen and never dismissible.

The result is a stack that is stale and lossy at once: "Provider connected" sits
on screen indefinitely next to an unrelated settings error, while a notification
you never read has already scrolled out of existence.

- Errors and successes are also near-identical in shape, position and
  permanence — separated only by a tint and text colour (`:45-50`).

**Direction:** successes auto-dismiss; errors persist. Overflow should queue
rather than discard. Give the two kinds different weight, not just different
colour.

---

## P2 — Real, narrower

### 4. The routing taxonomy exists but nothing reads it

**Surface:** `src/app/store.helpers/operations.ts`, `src/ui/InAppToasts.tsx`

Notifications already carry an `audience` field, and `runAcknowledgedOperation`
sets `audience: "foreground"`. `InAppToasts` selects with
`notifications.filter((n) => !dismissedIds.has(n.id))` (`:18`) — it never reads
`audience`.

The concept needed to fix finding #1 is already modelled; it is simply not
wired to anything. Worth noting because it makes #1 much cheaper than it looks.

---

### 5. The composer status live region is created and destroyed with its content

**Surface:** `src/ui/composer/MessageComposer.tsx:297`

```ts
if (!children) return null;
```

Callers mark this element `aria-live="polite"`. Because the element only exists
while it has text, the live region is inserted at the same moment its content
appears — the case screen readers are least reliable at announcing. A live region
should be present and empty, then filled.

This is also what made `research-view-layout` order-dependent: the assertion for
the region only passed when readiness happened to be mid-flight.

---

### 6. Red is used for a protective state on the privacy page

**Surface:** `src/ui/settings/pages/PrivacyTelemetryPage.tsx:130`

```tsx
control={<Badge variant="destructive">Disabled</Badge>}
```

This is the **Global kill switch** row: `COWORK_DISABLE_NETWORK_TELEMETRY` is
active, so network telemetry is off. That is the privacy-protective outcome and
almost certainly deliberate on the part of whoever set it — but it is rendered in
the same red the product uses for failures.

On a page whose stated premise is "Cowork is local-first… off by default", the
strongest visual alarm marks the safest state.

---

## P3 — Consistency

### 7. Two loading vocabularies, and mixed ellipsis inside one file

- `Skeleton` is used in 5 files (`ResearchView`, `marketplaceCatalog`,
  `MarketplaceDetailDialog`, `PluginsSection`, `SkillsSection`)
- 10 other sites use ad-hoc text

The text itself disagrees on typography, twice within the same file:

| Location | Copy |
|---|---|
| `settings/pages/MemoryPage.tsx:1054` | `"Loading..."` |
| `settings/pages/MemoryPage.tsx:1074` | `"Loading…"` |
| `settings/pages/AdvancedMemoryPanel.tsx:298` | `"Loading..."` |
| `FilePreviewModal.tsx:543` | `"Loading preview…"` |
| `tasks/TaskView.tsx:50` | `"Loading task…"` |

### 8. Most empty states are dead ends

Of ~14 empty states, only two tell you what to do next:

- `"No providers connected yet. Connect one to start chatting."` ✅
- `"No memories yet. They are written automatically as you work."` ✅

The rest state absence and stop: `"No backups yet"`, `"No connectors yet"`,
`"No messages yet"`, `"No models used yet"`, `"No bundle created yet."`,
`"No MCP servers configured."` Trailing periods are also inconsistent across the
set.

An empty state is the highest-intent moment in a view — the person is looking
directly at the thing they want and it is not there.

---

## Checked and found fine

Recorded so the next pass does not re-litigate them:

- **`aria-live="assertive"` usage** (5 sites) — all on genuine error surfaces
  (`FeedRow.tsx:123`, `Canvas.tsx:1035`, `OperationFeedback.tsx:36`,
  `CreationReadinessNotice.tsx:78`, `NewResearchComposer.tsx:227`). Appropriate.
- **Destructive `Button`/`Badge` variants** (17 sites) — all but
  `PrivacyTelemetryPage.tsx:130` mark genuinely destructive actions
  (delete/revoke/cancel) or real error states.

---

## Suggested order

1. **#1 + #3 + #4 together.** They are one change: route by `audience`, inline
   for foreground, toast for background, auto-dismiss successes. One shared
   helper plus `InAppToasts` — every one of the 72 operations improves at once.
2. **#2.** Independent, and the largest gap in product behaviour rather than
   presentation.
3. **#5.** Small, self-contained, removes a class of flaky a11y tests.
4. **#6, #7, #8.** Cheap consistency work, batchable.
