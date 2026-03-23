# Desktop Settings UI/UX Audit

Date: 2026-03-13

## Scope

This audit reviews the Electron desktop app settings UI based on direct use of the live app, not just code inspection.

Reviewed areas:

- Providers
- Usage
- Workspaces
- Backup
- MCP Servers
- Memory
- Updates
- Developer

## Method

The desktop app was launched in dev mode and exercised live against the real UI:

- `COWORK_ELECTRON_REMOTE_DEBUG=1 bun run desktop:dev`

The review combines:

- live interaction with the settings screens
- empty, expanded, and edit-state inspection
- supporting code review in:
  - `apps/desktop/src/ui/settings/SettingsShell.tsx`
  - `apps/desktop/src/ui/settings/pages/ProvidersPage.tsx`
  - `apps/desktop/src/ui/settings/pages/UsagePage.tsx`
  - `apps/desktop/src/ui/settings/pages/WorkspacesPage.tsx`
  - `apps/desktop/src/ui/settings/pages/BackupPage.tsx`
  - `apps/desktop/src/ui/settings/pages/McpServersPage.tsx`
  - `apps/desktop/src/ui/settings/pages/MemoryPage.tsx`
  - `apps/desktop/src/ui/settings/pages/UpdatesPage.tsx`
  - `apps/desktop/src/ui/settings/pages/DeveloperPage.tsx`

## Executive Summary

The settings UI is functional and internally coherent, but it is not yet especially user-friendly. The main problems are structural rather than purely visual:

- the navigation is too flat
- the app exposes implementation details too early
- pages depend on hidden external state without enough explanation
- save behavior is often implicit and under-signaled
- empty and disabled states are frequently accurate but not helpful

The current UI feels like a thin interface over internal runtime/config systems. That is useful for expert users, but it makes many workflows feel more brittle, more technical, and less trustworthy than they need to.

## Highest-Impact Recommendations

### 1. Rework the Settings Information Architecture

The left navigation gives every page the same weight:

- Providers
- Usage
- Workspaces
- Backup
- MCP Servers
- Memory
- Updates
- Developer

This makes the settings area feel like a loose list of technical surfaces rather than a structured product area.

Recommended change:

- Group settings into sections such as:
  - Account & Models
  - Workspace
  - Recovery & Data
  - Advanced
- Add search or quick filtering.
- Show current workspace context in the shell header.
- Consider a top summary strip showing:
  - active workspace
  - selected thread
  - provider health count
  - update status

Why this helps:

- reduces hunting
- gives users a mental model
- lowers the cost of discovering advanced features

Relevant implementation surface:

- `apps/desktop/src/ui/settings/SettingsShell.tsx`

### 2. Replace Implementation-First Copy With User-Intent Copy

Several pages explain the system internals before they explain the user benefit.

Examples:

- "Manage layered MCP servers via control socket messages."
- "The hot cache is injected into the system prompt."
- "spill oversized text tool results into .ModelScratchpad"

This copy is technically correct, but it assumes the user already understands the system.

Recommended change:

- Lead with what the feature does for the user.
- Move internal implementation details into:
  - secondary help text
  - expandable details
  - advanced sections

Examples:

- `MCP servers`
  - current: "Manage layered MCP servers via control socket messages."
  - better: "Connect external tools and services Cowork can use in this workspace."

- `Memory`
  - current: "The hot cache is injected into the system prompt..."
  - better: "Choose what Cowork should always remember in this workspace."

- `Developer`
  - current: "spill oversized text tool results into .ModelScratchpad"
  - better: "Save very large tool output to scratch files instead of keeping all of it inline."

Why this helps:

- lowers cognitive load
- makes advanced features feel intentional instead of incidental
- improves first-run comprehension

### 3. Standardize Save, Dirty, and Success Feedback

The settings surfaces currently use several save patterns:

- blur-to-save textareas
- instant toggles
- inline button-based save states
- disabled actions without enough explanation

This inconsistency makes the UI feel more fragile than it is.

Recommended change:

- Standardize around a small set of save behaviors:
  - instant save for low-risk toggles
  - explicit save for multi-field forms
  - autosave only when there is strong save feedback
- Add shared inline state messaging:
  - Saving...
  - Saved
  - Failed to save
- Add toasts for important changes.
- Show unsaved state in forms before blur/navigation.

Why this helps:

- reduces ambiguity
- improves trust
- makes settings feel durable

### 4. Improve Empty, Disabled, and Missing-Context States

A recurring issue across the settings area is that the UI often tells the truth, but not enough of the truth.

Examples:

- Usage depends on the selected thread but does not foreground that dependency strongly enough.
- Backup with no entries feels mostly blank.
- Updates in dev mode shows disabled controls with "Unavailable" but does not guide the user.
- Memory can read as "Loading..." and then quickly become a minimal empty state without much explanation.

Recommended change:

- Every empty state should answer:
  - why is this empty?
  - what should I do next?
  - what happens after I do it?

Why this helps:

- removes dead-end feeling
- improves discoverability
- reduces support questions

### 5. Reduce Form Density and Repeated Card Chrome

Most settings pages use stacked cards with very similar visual weight. That creates long, low-signal screens where everything looks equally important.

Recommended change:

- reduce unnecessary card nesting
- introduce stronger section hierarchy
- reserve heavier card treatment for:
  - destructive actions
  - alerts
  - state summaries
- tighten or simplify sections that are mostly plain forms

Why this helps:

- faster scanning
- clearer priorities
- less "wall of settings" feeling

## Cross-Cutting UX Issues

### Navigation and Context

Problems:

- no grouping in the nav
- no search
- no current workspace indicator in the shell
- hidden dependency on selected thread or selected backup

What to change:

- group pages
- add global context summary
- allow direct thread/workspace switching inside pages that depend on them

### Copy and Labeling

Problems:

- too much jargon
- several labels sound like internal terminology
- some controls are accurate but not explanatory

What to change:

- favor plain language
- use "what this changes" copy, not "what subsystem this maps to"
- reserve system terms for advanced disclosure

### Feedback and Trust

Problems:

- silent saves
- weak "saved" confirmation
- controls disabled without strong explanation
- editing states can contradict saved-state messaging

What to change:

- add save status
- add success/failure toasts
- avoid showing "saved" messaging while the user is actively replacing a value

### Visual Hierarchy

Problems:

- too many equal-weight sections
- insufficient emphasis on primary actions
- destructive sections do not stand out enough until the button itself

What to change:

- use summary banners and stronger section headers
- isolate destructive actions
- reduce repeated neutral card treatment

### Accessibility and Comprehension

Problems:

- dense technical helper text
- low-value labels repeated frequently
- status badges often carry too much meaning on their own

What to change:

- make status descriptions more explicit
- improve explanatory text near controls
- add clearer keyboard/focus-visible treatment where needed

## Page-by-Page Findings

## Providers

### What works

- provider list is easy to scan
- expanded cards are a reasonable pattern
- auth methods are generally exposed in a compact way

### Problems

- The page needs a top-level status summary, not just a list of cards.
- `Refresh status` is embedded in paragraph copy and feels secondary.
- "Connected" is too coarse for many real provider states.
- Editing an API key creates a confusing state where the UI can still say `API key saved.` while the user is looking at an empty replacement field.
- Exa is conceptually awkward because it appears as a standalone section while being implemented as a Google auth method.
- Model chips are useful but not tied to actual workspace defaults or recommended choices.

### Recommended changes

- Add a provider summary toolbar:
  - connected count
  - issues count
  - pending auth count
  - refresh action
- Sort providers by urgency:
  - workspace default provider first
  - then disconnected/problem providers
  - then healthy providers
- Replace generic labels with more helpful states:
  - Connected
  - Needs key
  - Needs browser sign-in
  - Rate limited
  - Failed check
- Change API key actions:
  - `View` -> `Reveal`
  - `Edit` -> `Replace key`
- Hide or revise saved-state messaging while editing.
- Add `Test connection` and `Last checked`.
- Move Exa into:
  - a `Web search` section
  - or a sub-surface of Google/search configuration

### Copy suggestions

- page intro:
  - current: "Connect your AI providers to start chatting."
  - better: "Manage the providers Cowork can use in this app and check whether each one is ready."

- Exa helper text:
  - current: "Configure the Exa API key used for web search without nesting it under the Google provider."
  - better: "Use Exa for better web search results when Cowork searches the web."

## Usage

### What works

- strong data density
- useful overview cards
- budget status is conceptually clear
- the estimate notice is a good idea

### Problems

- The page depends entirely on the selected thread from elsewhere in the app.
- That dependency is present, but not prominent enough.
- `Estimate notice` reads like a warning more than an explanation.
- The page is analytical but not very task-oriented.

### Recommended changes

- Add an in-page thread picker or recent-thread picker.
- Add a stronger page context banner:
  - `Viewing usage for: <thread title>`
- Rename `Estimate notice` to `How estimates work`.
- Add small explanatory summaries:
  - "Most recent expensive turn"
  - "Budget status at a glance"
- Consider a compact chart or trend summary for recent turns.

### Copy suggestions

- `Estimate notice` -> `How estimates work`
- `Inactive` budget status -> `No budget set`

## Workspaces

### What works

- all major workspace controls are present
- destructive actions are confirmed
- model/provider defaults are easy to find

### Problems

- This page is overloaded.
- It combines:
  - workspace selection
  - provider/model defaults
  - execution policy
  - user profile prompt context
  - OpenAI-compatible tuning
  - advanced actions
- The `User Profile Context` section sounds technical rather than useful.
- Blur-save profile editing is too subtle.
- `Auto-approve commands` is under-explained for a high-risk setting.
- The end-of-page badges are low-value compared to the rest of the screen.

### Recommended changes

- Split the page into tabs or accordions:
  - General
  - Models
  - Profile
  - Safety
  - Advanced
- Reframe `User Profile Context` around how Cowork should understand the user.
- Replace blur-save with:
  - explicit Save
  - or autosave plus visible save state
- Expand the warning around auto-approve:
  - explain what confirmation is being skipped
  - explain that shell commands can run without review
  - explain restart implications if relevant
- Demote or remove the summary badges at the bottom unless they become actionable.

### Copy suggestions

- `User Profile Context` -> `How Cowork should understand you in this workspace`
- `Details Agent Should Know` -> `Background details`
- `Work / Job` -> `Role or work context`
- `Auto-approve commands` -> `Run shell commands without asking`

## Backup

### What works

- Once populated, the split-pane structure is a strong foundation.
- Checkpoint and restore actions are grouped logically.
- The detail views are more product-like than most of the settings pages.

### Problems

- The empty state is weak.
- With no backups present, the page feels mostly blank.
- `Session backups` can be disabled without enough explanation about what controls it.
- There is not enough guidance about:
  - how backup entries appear
  - how workspace defaults and session-level settings relate
  - what recovery workflows are safest

### Recommended changes

- Add a guided empty state:
  - explain how backups are created
  - explain how checkpoints differ from original restore
  - explain what toggling session backups does
- If backups are disabled by workspace default, link back to Workspaces settings.
- Add a small "How this works" disclosure.
- Improve the no-selection panel with next-step guidance instead of only "Select a backup..."

### Copy suggestions

- `Session backups` -> `Keep recovery snapshots for this session`
- empty state:
  - "No backups yet. Backups appear after Cowork creates recovery snapshots for a session in this workspace."

## MCP Servers

### What works

- functionality coverage is solid
- layered config visibility is valuable for advanced users
- add/edit/validate flows exist

### Problems

- The page is implementation-first.
- The first sentence mentions control socket messages, which is not a user goal.
- The add-server form is dense and technical.
- Layer/config-file detail is front-and-center before the user has even connected one server.
- Labels like `stdio`, `sse`, `auth: api_key`, and `Refresh snapshot` are technically precise but not especially humane.

### Recommended changes

- Make the default view goal-oriented:
  - connect a new server
  - check if it works
  - fix auth
- Move layer/config-file detail into an advanced disclosure.
- Add presets or examples for common server setups.
- Add helper descriptions beside transport/auth choices.
- Rename `Refresh snapshot` to `Reload server list`.
- Convert server cards into clearer summaries:
  - connection type
  - auth state
  - last validation result
  - available tools count

### Copy suggestions

- page intro:
  - current: "Manage layered MCP servers via control socket messages."
  - better: "Connect external tools and services Cowork can use in this workspace."

- `Required server`:
  - add helper text explaining failure behavior

## Memory

### What works

- core create/edit/delete flow exists
- scope filtering is simple
- the page is compact

### Problems

- The page depends too heavily on internal memory architecture language.
- `hot cache` and ``hot`/`AGENT.md`` are not beginner-friendly.
- Scope values `workspace` and `user` are accurate but not natural language.
- The loading state can degrade too quickly into a minimal empty state.
- The distinction between always-injected memory and searchable named memory is important, but the current wording is still too implementation-shaped.

### Recommended changes

- Replace mental model language:
  - `hot cache` -> `Always include in context`
  - `workspace` -> `This workspace`
  - `user` -> `All workspaces`
- Add two obvious memory types:
  - Always include
  - Saved for lookup
- Explain the consequence of each memory type in plain terms.
- Improve loading states:
  - loading
  - stalled loading
  - empty
- Add usage examples beneath the form.

### Copy suggestions

- page intro:
  - current: "Manage persistent agent memories for this workspace..."
  - better: "Choose what Cowork should remember in this workspace and what it should keep available for later lookup."

- helper text:
  - current: "Named memories like `people/sarah` stay searchable..."
  - better: "Named memories are not always loaded into context, but Cowork can still find them later."

## Updates

### What works

- packaged-build update information is clearly structured
- status, current version, and release details are well separated

### Problems

- In dev mode, the page feels inert.
- Disabled controls plus `Unavailable` do not tell the user what to do next.
- The screen is technically accurate, but not helpful for the actual environment.

### Recommended changes

- Detect dev mode and switch to a dedicated dev-state experience.
- Show a clear message:
  - "Updates only work in packaged builds."
- Replace dead controls with useful alternatives:
  - open latest release page
  - explain how update testing works

### Copy suggestions

- `Unavailable` -> `Not available in dev mode`
- status body:
  - current: "Updates are only available in packaged builds."
  - better: "This is a development build, so in-app update checks are disabled."

## Developer

### What works

- low-level controls are exposed cleanly
- spill-file threshold controls are present

### Problems

- It mixes simple user-facing preferences with highly technical runtime behavior.
- `.ModelScratchpad` and spill semantics are too implementation-heavy in the primary copy.
- `Show hidden files` and `Developer mode` are accessible enough, but the spill-file section is expert-only and should feel like it.

### Recommended changes

- Split into:
  - Interface debugging
  - Runtime internals
- Rewrite spill-file language around behavior rather than file-path internals.
- Move path details into expandable advanced text.
- Rename the section more clearly:
  - `Large tool output handling`

### Copy suggestions

- `Workspace Tool Output Spill Files` -> `Large Tool Output Handling`
- `Enable spill files` -> `Save oversized tool output to scratch files`
- `Character threshold` -> `Spill after this many characters`

## Recommended Implementation Order

### Phase 1: Fastest High-Value UX Wins

- Rework settings shell grouping and labeling
- Improve page intros and helper copy
- Rename technical controls and helper text
- Improve empty/disabled states for Backup, Memory, and Updates

### Phase 2: Trust and Interaction Improvements

- Add save/success/error feedback patterns
- Standardize explicit save behavior for text-heavy forms
- Improve provider edit states
- Add stronger high-risk warnings for auto-approve behavior

### Phase 3: Structural Improvements

- Split Workspaces into clearer sub-sections
- Simplify MCP Servers default view
- Rework Memory around user-facing memory types
- Add in-page thread/workspace selectors where external context is currently hidden

## Verification

The review was based on live app interaction plus code inspection.

Verification run during the audit:

- `bun test`
- `bun run typecheck`
- `bun run build:server-binary`
- `bun run build:desktop-resources`
- `bun run desktop:build`

Results at audit time:

- `bun test`: pass (`2249 pass, 2 skip, 0 fail`)
- `bun run typecheck`: pass
- `bun run build:server-binary`: pass
- `bun run build:desktop-resources`: pass
- `bun run desktop:build`: pass

## Implementation Details (2026-03-13)

The following changes were implemented to address the audit findings:

1. **Information Architecture & Navigation (Phase 1 & 3)**
   - Grouped `SettingsShell.tsx` pages into `Account & Models`, `Workspace`, `Recovery & Data`, and `Advanced`.
   - Added current workspace context summary to the navigation sidebar to help users orient themselves.
   - *Improvement*: Reduces hunting and gives users a clear mental model of settings categories instead of a flat technical list.

2. **Copy and Intros (Phase 1)**
   - Rewrote page intros for `ProvidersPage`, `UsagePage`, `McpServersPage`, `MemoryPage`, `UpdatesPage`, and `DeveloperPage`.
   - Translated technical jargon (e.g., "hot cache", ".ModelScratchpad", "layered control socket messages") into plain language based on user intent (e.g., "Choose what Cowork should remember", "Save oversized tool output to scratch files", "Connect external tools").
   - *Improvement*: Lowers cognitive load, improves first-run comprehension, and makes the system feel less intimidating.

3. **Context Selectors (Phase 3)**
   - Added an in-page thread picker to `UsagePage.tsx` along with a stronger "Viewing usage for" context banner.
   - *Improvement*: Fixes the hidden dependency where Usage was tied to whatever thread was active in the main app window, avoiding the "empty page" trap.

6. **Component Grouping & Cleanup**
   - Split `WorkspacesPage.tsx` into a clean tabbed UI (`General`, `Models`, `Profile`, `Advanced`).
   - Grouped OpenAI-compatible options into side-by-side grid cards instead of a stack.
   - Transformed `ProvidersPage` to use a tab switcher instead of a flat list, moving Model Providers and Tool Providers into separate tabs.
   - Refined `McpServersPage` to use an inline "Add server" button that opens a dialog modal.
   - Redesigned the server list to use a clean accordion-style UI that expands to show server details, tools, and validation state.
   - Fixed unmounted background tabs in `WorkspacesPage` and `ProvidersPage` to prevent scroll height bloat and ghost elements when tabs were hidden via opacity, allowing `framer-motion` to cleanly swap nodes.
   - Extracted `Exa Search` into the "Tool Providers" tab explicitly.
   - Made default models & tools intelligent to only display when they are configured/available.

## Bottom Line

The settings UI is already functional enough for expert users, but it still behaves more like an interface to internal systems than a polished product surface. The biggest opportunity is not adding more settings. It is making the existing settings easier to understand, safer to change, and more obviously organized around user intent.
