# Settings Port Plan (`crates/cowork-desktop/src/views/settings/`)

Thin-client Rune port of `apps/desktop/src/ui/settings/` (`SettingsShell`, `SettingsPrimitives`, `SettingsChromeContext`, `import/`, `toolAccess/`, and all `pages/`). All server business logic stays in `crates/cowork-server` behind typed JSON-RPC WebSocket calls (`crates/cowork-protocol`) and native host operations live behind the `@native` command bridge.

---

## 1. Navigation & Page Inventory

Exact parity with `apps/desktop/src/app/settingsNavigation.ts`, `settingsPageAvailability.ts`, `ui/settings/settingsPages.ts`, and `ui/settings/pages/SettingsIntentPages.tsx`:

| Group | Canonical Page ID | Label | Rendered Composition & Modals | Availability / Mode |
|---|---|---|---|---|
| **Models & tools** | `models` | Models & Providers | `ProvidersPage(surface="models")` + `WorkspacesPage(surface="models")` (`NewProviderDialog`, `ManageModelsDialog`, OAuth challenge/code inputs, API/structured credential forms, LM Studio local server card, Codex runtime & usage/rate-limits, OpenAI/ChatGPT & Gemini settings cards) | Always |
| | `subagents` | Subagents | `SubagentsPage` (`WorkflowConcurrencyRow` 1–16, Global/Workspace scope toggle, `WorkspaceTargetPicker`, profile rows, workspace override availability switches) + `ProfileDialog` | Always |
| | `toolAccess` | Tool Access | `ToolAccessPage` (`Plugins`, `Skills`, `Connectors`, optional `Apps`, `Search` tabs + top-right search bar + `WorkspaceTargetPicker`) | Tab `apps` gated on `desktopFeatureFlags.openAiNativeConnectors` |
| — tab `plugins` | | Plugins | `PluginsSection` + `AvailablePluginsSection` + `ImportDialog("plugin")` + `InstallPluginDialog` + `PluginDetailDialog` | — |
| — tab `skills` | | Skills | `SkillsSection` + `AvailableSkillsGrid` + `MarketplaceSourcesList` + `AddMarketplaceDialog` + `ImportDialog("skill")` + `InstallSkillDialog` + `SkillDetailDialog` + `MarketplaceDetailDialog` | — |
| — tab `connectors` | | Connectors | `McpServersPage` (connector rows sorted `user`/`workspace`/`plugin`/`system`, inline OAuth auth, expandable details + tool badges + API key + OAuth menu, Create/Edit `Dialog` w/ `mcpServerDraft` + collapsible Advanced + Advanced config files) | — |
| — tab `apps` | | Apps | `OpenAiNativeConnectorsPage` (status pills, search + "Enabled only" switch, connector list + external install links + enable switches) | Gated on `openAiNativeConnectors` |
| — tab `search` | | Search | `SearchSettingsCard` + `ProvidersPage(surface="tools")` (Exa Search, Parallel Search, tool providers) | — |
| **Workspace** | `defaults` | Defaults | `WorkspacesPage(surface="defaults")` (`Settings target` picker when `perWorkspaceSettings`, MCP tools switch, YOLO switch + confirm + server restart, Tool calling + `Check endpoint` probe, `Advanced actions` collapsible: per-workspace toggle, Restart server, Remove workspace) | Empty state w/ "Add workspace" when no targets |
| | `profileMemory` | Profile & Memory | `WorkspacesPage(surface="profile")` (`WorkspaceUserProfileCard`) + `MemoryPage` (Advanced memory toggle, memory generation model, collapsible Skill Improvement Beta, Workspace target picker, either `AdvancedMemoryPanel` + note modal or Remembered facts + All/Workspace/User filter + stall warning + note modal) | `AdvancedMemoryPanel` toggled by server/workspace `advancedMemoryEnabled` |
| | `remoteAccess` | Remote Access | `RemoteAccessPage` (header Start/Restart/Stop actions, relay bridge status, 2-col QR code pairing + copy key + rotate QR/cert, trusted devices list + per-device 7 permission switches + forget device/all confirms) | Gated on `desktopFeatureFlags.remoteAccess` |
| **History & Data** | `backup` | Backup | `BackupPage` (top summary + `defaultBackupsEnabled` / per-session backup switch, split inspector `BackupSidebar` tree -> `BackupDetailView` / `CheckpointDeltaView`, create checkpoint / restore / reveal / delete) | Full-viewport `overflow-hidden` split pane |
| | `chats` | Archived Chats | `ArchivedChatsPage` (Auto-delete retention select `0`/`7`/`30`/`90` days, search, Restore/Delete rows w/ confirm, `ConversationImportDialog` w/ source list -> path picker -> preview -> missing workspace mapping -> import) | Always |
| | `usage` | Usage | `UsagePage` (header "How estimates work" dialog, 4 summary stat tiles, expandable provider groups -> per-model 6-stat grid) | Client aggregation (`aggregateUsageFromRuntimes`) |
| **App** | `privacyTelemetry` | Privacy & Telemetry | `PrivacyTelemetryPage` (global kill switch banner, 5 switches: Crash reports, Anonymous product analytics, AI trace diagnostics, Full-payload AI traces w/ AlertDialog confirm, Diagnostics upload; status badges + retention info) | Always |
| | `desktop` | Desktop | `DesktopPage` (Quick chat menu bar icon switch, Global shortcut switch, `ShortcutRecorder`, Reset default, "Open quick chat") | `menuBar` flag gates shortcut rows; packaged vs dev/web notes |
| | `updates` | Updates | `UpdatesPage` (Update phase pill, Check now / Restart to update, progress bar while downloading, Markdown release notes + external release link) | Packaged-only check/install; non-packaged hint banner |
| **Advanced** | `experiments` | Feature Flags | `FeatureFlagsPage` (global toggles for `FEATURE_FLAG_IDS`; `forced-off` flags locked when `packaged`) | Hidden when `packaged` (`includeDevelopmentPages`) |
| | `diagnostics` | Developer | `DeveloperPage` (Diagnostics bundle create/reveal/open logs/copy summary/upload, `showHiddenFiles`, `developerMode`, `startOnboarding`, LibreOffice check + smoke test result, Large tool output overflow threshold w/ Chats collapsing) | Always |

Legacy page alias normalization (in shared router / `SettingsShell` navigation state):
- `providers` → `models`
- `openAiNativeConnectors`, `mcp` → `toolAccess` (preserving initial tab `apps` / `connectors`)
- `workspaces` → `defaults`
- `memory` → `profileMemory`
- `featureFlags` → `experiments`
- `developer` → `diagnostics`
- `archivedChats` → `chats`

Intent helpers (`SettingsIntentPages.tsx`): deep-links from main app can specify `(SettingsPageId, optional_tab, optional_section_id, optional_modal)` — e.g., opening `toolAccess` on tab `search` with `exa-search` or `parallel-search` expanded, or `models` with `newProviderOpen = true` or a specific provider expanded.

---

## 2. JSON-RPC & Native Interface Mapping per Page

### Server JSON-RPC Methods (`crates/cowork-protocol/src/methods.rs` & server handlers)
- **Providers / Search / Tool Providers (`models`, `toolAccess/search`)**:
  - `cowork/provider/status/refresh`, `cowork/provider/catalog/read`, `cowork/provider/authMethods/read`
  - `cowork/provider/auth/setApiKey`, `cowork/provider/auth/setConfig`, `cowork/provider/auth/copyApiKey`, `cowork/provider/auth/authorize`, `cowork/provider/auth/callback`, `cowork/provider/auth/logout`
  - `cowork/provider/customModel/add`, `cowork/provider/customModel/delete`, `cowork/provider/model/setEnabled`, `cowork/provider/model/resetEnabled`
  - `cowork/provider/codexAppServer/status`, `cowork/provider/codexAppServer/update`
  - `cowork/provider/lmstudio/local/start`
  - `cowork/provider/capabilities/check` (also used in `defaults`)
- **Workspace Defaults & Profile (`models`, `defaults`, `profileMemory`, `subagents`, `diagnostics`)**:
  - `cowork/session/defaults/apply` (`defaultProvider`, `defaultModel`, `defaultPreferredChildModel`, `defaultPreferredChildModelRef`, `defaultChildModelRoutingMode`, `defaultAllowedChildModelRefs`, `defaultEnableMcp`, `yolo`, `defaultToolCalling`, `providerOptions`, `userName`, `userProfile`, `defaultWorkflowMaxConcurrentAgents`, `defaultToolOutputOverflowChars`, `defaultBackupsEnabled`, `advancedMemoryEnabled`, memory model & skill improvement defaults)
  - `cowork/workspace/list`, workspace selection/bootstrap/switch (`WorkspaceSwitchParams`)
- **Subagents (`subagents`)**:
  - `cowork/agentProfiles/catalog/read`, `cowork/agentProfiles/upsert`, `cowork/agentProfiles/delete`, `cowork/agentProfiles/workspaceAvailability/set`, `cowork/agentProfiles/copy`
- **Tool Access — Plugins (`toolAccess/plugins`)**:
  - `cowork/plugins/catalog/read`, `cowork/plugins/read`, `cowork/plugins/enable`, `cowork/plugins/disable`, `cowork/plugins/install/preview`, `cowork/plugins/install`, `cowork/plugins/checkUpdate`, `cowork/plugins/update`, `cowork/plugins/delete`
  - `cowork/import/list`, `cowork/import/plugin`
  - `cowork/skills/installation/enable`, `cowork/skills/installation/disable` (for bundled plugin skills inside `PluginDetailDialog`)
- **Tool Access — Skills & Marketplaces (`toolAccess/skills`)**:
  - `cowork/skills/catalog/read`, `cowork/skills/list`, `cowork/skills/read`, `cowork/skills/installation/read`
  - `cowork/skills/enable`, `cowork/skills/disable`, `cowork/skills/delete`
  - `cowork/skills/installation/enable`, `cowork/skills/installation/disable`, `cowork/skills/installation/delete`, `cowork/skills/installation/copy`, `cowork/skills/installation/checkUpdate`, `cowork/skills/installation/update`
  - `cowork/skills/install/preview`, `cowork/skills/install`
  - `cowork/marketplaces/read`, `cowork/marketplaces/detail`, `cowork/marketplaces/add`, `cowork/marketplaces/remove`
  - `cowork/import/list`, `cowork/import/skill`
- **Tool Access — Connectors (`toolAccess/connectors`)**:
  - `cowork/mcp/servers/read`, `cowork/mcp/server/upsert`, `cowork/mcp/server/delete`, `cowork/mcp/server/setEnabled`, `cowork/mcp/server/validate`, `cowork/mcp/server/auth/authorize`, `cowork/mcp/server/auth/callback`, `cowork/mcp/server/auth/setApiKey`
- **Tool Access — Apps (`toolAccess/apps`)**:
  - `cowork/connectors/openai-native/list`, `cowork/connectors/openai-native/refresh`, `cowork/connectors/openai-native/setEnabled`
- **Memory & Skill Improvement (`profileMemory`)**:
  - `cowork/memory/list`, `cowork/memory/upsert`, `cowork/memory/delete`
  - `cowork/memory/advanced/list`, `cowork/memory/advanced/upsert`, `cowork/memory/advanced/delete`, `cowork/memory/advanced/generate`
  - `cowork/memory/advanced/folder/list`, `cowork/memory/advanced/folder/upsert`, `cowork/memory/advanced/folder/delete`, `cowork/memory/advanced/folder/generate`
  - `cowork/skills/improvement/status`, `cowork/skills/improvement/run`, `cowork/skills/improvement/restore`
- **Backups (`backup`)**:
  - `cowork/backups/workspace/read`, `cowork/backups/workspace/delta/read`, `cowork/backups/workspace/checkpoint`, `cowork/backups/workspace/restore`, `cowork/backups/workspace/deleteCheckpoint`, `cowork/backups/workspace/deleteEntry`, `cowork/session/config/set`
- **Archived Chats (`chats`)**:
  - `thread/archived/set`, `cowork/session/delete`
  - `cowork/conversationImport/sources/list`, `cowork/conversationImport/preview`, `cowork/conversationImport/workspaceMappings/validate`, `cowork/conversationImport/import`
- **Developer (`diagnostics`)**:
  - `cowork/runtime/libreoffice/check`

### Native Desktop Bridge (`@native`) & Client Persisted Preferences
- **Common**: `confirmAction` (native confirm or shared modal `Dialog`), `pickDirectory` / `pickWorkspaceDirectory`, `revealPath`, `openExternalUrl`, `copyText` (or `rune::Tx` clipboard), `isPackagedDesktopApp`.
- **Workspace Lifecycle (`defaults`)**: add workspace folder, remove workspace, restart/stop workspace server (`stopWorkspaceServer` + start), `perWorkspaceSettings` toggle & sync.
- **Remote Access (`remoteAccess`)**: `getMobileRelayState`, `startMobileRelay`, `stopMobileRelay`, `refreshMobileRelayTrustedPhones`, `rotateMobileRelaySession`, `forgetMobileRelayTrustedPhone`, `updateMobileRelayTrustedPhonePermissions` + push updates.
- **Privacy & Telemetry (`privacyTelemetry`)**: persisted telemetry toggles + runtime telemetry sync + `getTelemetryStatus`.
- **Desktop (`desktop`)**: `showQuickChatWindow`, menu-bar icon toggle, global shortcut register/update/clear, shortcut availability / failure status.
- **Updates (`updates`)**: `getUpdateState`, `checkForUpdates`, `quitAndInstallUpdate`, update event subscription.
- **Developer (`diagnostics`)**: `createDiagnosticsBundle`, `revealDiagnosticsBundle`, `openLogsFolder`, `uploadDiagnosticsBundle`, UI flags (`showHiddenFiles`, `developerMode`), `startOnboarding`.
- **Feature Flags (`experiments`)**: persisted feature-flag overrides + packaged enforcement.
- **Persisted UI prefs**: `lmstudio` enabled + hidden models, `archivedChatsAutoDeleteDays`, `workflowConcurrency` / settings navigation page.

---

## 3. Component & Primitive Mapping (`rune` + `rune-kit`)

| Electron / React (`apps/desktop/src/ui/settings`) | Native Rust (`rune` / `rune-kit` / `views/settings`) | Notes |
|---|---|---|
| `SettingsShell` (sidebar + mobile nav + sticky header + scrollable content) | `SplitView` / fixed 220px left nav rail (`col()` + `SidebarSection`/`SidebarRow` or custom nav items matching Electron grouping) + sticky header bar (`Toolbar` / custom row w/ `SettingsChrome` actions) + `.scroll(ScrollSpec::default()).min_h(0.0)` main column (`max_w(1160.0)`, omitted on `backup` full-height mode) | Must put `.min_h(0.0)` on scroll viewports inside `.grow(1.0)`! |
| `SettingsPage`, `SettingsSection`, `SettingsRow`, `SettingsEmptyState`, `SettingsStatTile` | Local `views/settings/primitives.rs`: rounded bordered section cards (`1px` subtle border, `0.5px` / `1px` `Divider::horizontal()` / `rune::rule` row dividers), 2-column responsive `SettingsRow`, empty state box, stat tiles | Follows Rune `examples/settings` section card aesthetic + app tokens |
| `Switch` (all binary settings) | `rune_kit::Switch::new(checked).control_size(ControlSize::Mini).on_toggle(...)` | Preserve `Switch` for settings, `Checkbox` for checklists |
| `Checkbox` (`ManageModelsDialog`, `Subagents` tool/MCP/skill lists, Skill Improvement skills, Conversation Import rows, `WorkspacesPage` child model allowlist) | `rune_kit::Checkbox::new(checked).label(..).on_toggle(...)` | Built-in indeterminate & check glyphs |
| `Select` + `SelectGroup` | `rune_kit::Select::new(key, &opts)` / `Select::grouped(...)` | App holds open key + `Dropdown` dismiss wiring |
| `Input` / masked API keys + eye toggle | `rune_kit::TextInput::new(&edit)` (+ `.secure().revealed(rev)` + inline `IconButton` eye toggle via `.trailing(...)`) | Keep local `TextEdit` drafts so server status ticks never clobber typing |
| `Textarea` (Prompts, Profiles, Memory bodies, Source URLs, Env/Headers) | `rune_kit::TextArea::new(&edit).rows(..)` | Multiline editing via `rune::TextEdit` |
| `Button` / `AccessibleIconButton` | `rune_kit::Button` / `rune_kit::IconButton` | Variants: Primary, Secondary, Outline/Ghost, Destructive, Sizes |
| `Dialog` / `AlertDialog` | `rune_kit::Dialog::new(key, title).open(..).child(..).build(&kit, layer)` | Mounts scrim + modal stack via `rune_kit::root(body, layer)` |
| `Badge` / `SettingsStatusPill` | `rune_kit::Badge` + custom `SettingsStatusPill` (subtle tinted fill + optional 6px pulse/status dot) | Used for connected/warning/danger/disabled pills |
| `Collapsible` (`ProvidersPage` cards, `McpServersPage` details, `UsagePage` providers, `WorkspacesPage` cards, `MemoryPage` Skill Improvement) | `rune_kit::Collapsible` / custom card header button + conditional body w/ smooth expand or `Accordion` | Card headers with right chevron + badge match `ProvidersPage` cards |
| `Tabs` (`ToolAccessPage`), `SourceToggle`, All/Workspace/User filter | `rune_kit::shell::TabStrip` / `rune_kit::SegmentedControl` | Supports sliding active pill indicator & keyboard nav |
| `RadioGroup` (`McpServersPage` transport/auth/location, `ManageModels` / `ConversationImport` sources) | `rune_kit::RadioGroup` / `RadioItem` | Used for mutually exclusive config choices |
| `ShortcutRecorder` (`DesktopPage`) | `rune_kit::ShortcutRecorder` + `ShortcutRecorderState` | Built specifically for physical chord capture & refusal display |
| `Tree` (`BackupSidebar` sessions -> checkpoints) | `rune_kit::Tree` (`TreeModel` + `TreeItem`) | Or structured expandable session/checkpoint list inside left split pane |
| `Table` (`CheckpointDeltaView`, structured delta tables) | `rune_kit::Table` (`TableState`, `TableColumn`) | Virtualized sortable/resizable rows |
| `Streamdown` (`UpdatesPage` release notes, `SkillDetailDialog` SKILL.md) | `rune_kit::Markdown` (with `features = ["mermaid"]`) | Pre-strip YAML front-matter with `normalize_display_content` |
| `Progress` (`UpdatesPage` download, `ProvidersPage` rate limits) | `rune_kit::Progress::new(Some(frac))` or thin rounded `el()` progress bar | Thin 4px progress bar for rate limits; standard `Progress` for downloads |
| `Spinner` / `Skeleton` / `OperationFeedback` | `rune_kit::Spinner` / `Loader` + pulsing/subtle `el()` skeleton rows + shared `OperationFeedback` / `ToastStack` | Inline operation error/pending feedback |
| `EntityIcon` | Image handle from `ImageCache` (when decoded), emoji text (<=3 chars), or hashed colored circle/rounded-square w/ 1–2 initials | Consistent fallback color hashing by entity name |
| `QRCodeSVG` (`RemoteAccessPage`) | QR matrix generator (`qrcode` crate) -> `rune::canvas(Shape)` or crisp module grid `el()` / `ImageCache::svg` | Crisp vector/quad QR rendering without browser SVG DOM |

---

## 4. Rune / `rune-kit` Gaps & Shared Core Interface Requests

### Identified Gaps & Workarounds
1. **QR Code Generation (`RemoteAccessPage`)**: Rune has no QR generator widget. Plan: depend on lightweight `qrcode` crate in `cowork-desktop` and render QR modules using `rune::canvas(Shape)` (single batched path/rect fill at integer module coordinates) or `ImageCache::svg`.
2. **Remote HTTP(S) & Data-URI `EntityIcon` Images**: Verified in `rune/src/image.rs` (`ImageCache::url` on native desktop currently handles `file://` URLs via `from_url::file_path`, not HTTP fetch or `data:` URIs). Plan: `data:` URIs (`base64` or `image/svg+xml`) decode locally into `ImageCache::load_mime`; `https://` plugin/skill/connector icons need a lightweight shared HTTP byte fetcher in `cowork-desktop` core feeding `ImageCache::load_mime`, falling back immediately to initials `EntityIcon` while loading/failing.
3. **In-App Confirm Modal (`confirmAction`)**: `rune` does not ship an OS alert sheet helper directly in `rune-kit`. Prefer either an `@native` OS confirm dialog OR an in-app `ConfirmModalState` rendered via `rune_kit::Dialog` on the root overlay `layer` (in-app `Dialog` is also directly driveable in headless `--script` / `--snap` tests).
4. **Controlled `TextInput` / `TextArea` Synchronization**: `rune-kit`'s `TextInput`/`TextArea` bind to persistent `rune::TextEdit` structs rather than React value strings. Settings forms (`ProvidersPage`, `McpServersPage`, `ProfileDialog`, `WorkspaceUserProfileCard`, `AdvancedMemoryPanel`) must store per-form `TextEdit` instances and apply the existing dirty/baseline guard so incoming server snapshots update untouched fields without overwriting active user edits.
5. **Clipboard & External Link Opening**: Copy buttons (`McpServers`, `RemoteAccess`, `Developer`) can use `Tx::copy` / `@native` clipboard; OAuth & release links route through `@native::open_external_url`.

### Early Requests for `@architect` & `@native`
1. **`Cargo.toml` deps in `crates/cowork-desktop`** (`@architect`):
   - Include `rune-kit` with `features = ["mermaid"]` (for Markdown in `UpdatesPage` + `SkillDetailDialog`).
   - Include `qrcode` crate (small, no default image dep needed) for `RemoteAccessPage` pairing QR rendering.
   - Include `base64` (likely already in workspace) for decoding `data:image/*` plugin/skill `EntityIcon` URIs.
2. **Shared Core State & Routing (`@architect`)**:
   - `AppState` fields needed by Settings: `workspaces`, `selected_workspace_id`, `per_workspace_settings`, `provider_status_by_name`, `provider_catalog`, `provider_auth_methods`, `provider_last_auth_challenge`, `provider_last_auth_result`, `provider_default_model_by_provider`, `provider_ui_state` (lmstudio), `codex_app_server_status` (+ checking/updating), per-workspace runtimes (`pluginsCatalog`, `skillsCatalog`, `marketplaces`, `mcpServers`, `openAiNativeConnectors`, `agentProfilesCatalog`, `memories`, `advancedMemories`, `skillImprovementStatus`, `backups`, `controlSessionConfig`), `threads` + `thread_runtime_by_id` (usage + archived chats), `operations_by_key`, `desktop_feature_flags`, `privacy_telemetry_settings`, `telemetry_status`, `update_state`, `mobile_relay_state`, `developer_mode`, `show_hidden_files`, `archived_chats_auto_delete_days`, and settings navigation state (`SettingsPageId`, active tab, optional section/new-provider intent).
   - Helper/action hooks in `AppCtx` / `AppAction`: dispatch JSON-RPC control requests by method/params, workspace target helpers (`resolve_workspace_display_targets`, `resolve_management_workspace_id`), HTTP icon fetcher for `ImageCache`, and overlay/confirm dialog hook (`AppState::confirm` or `@native::confirm_action`).
   - Shared `lucide` -> `rune::Icon` catalog (or core icon set + settings-local icons in `views/settings/icons.rs`).
3. **Native Desktop Bridge (`@native`)**:
   - `pick_directory` / `pick_workspace_directory`, `reveal_path`, `open_external_url`, `is_packaged_app`, `show_quick_chat_window`, `register_global_shortcut`, `get_update_state` / `check_for_updates` / `quit_and_install_update`, `create_diagnostics_bundle` / `reveal_diagnostics_bundle` / `open_logs_folder` / `upload_diagnostics_bundle`, `get_telemetry_status` / telemetry toggle sync, `start_mobile_relay` / `stop_mobile_relay` / `get_mobile_relay_state` / `rotate_mobile_relay_session` / `forget_mobile_relay_trusted_phone` / `update_mobile_relay_trusted_phone_permissions`, and `start_onboarding` trigger.

---

## 5. Implementation Slices & Verification Workflow

All commits will stay scoped to `crates/cowork-desktop/src/views/settings/`, keeping `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all -- --check` clean on every slice:

1. **Slice 1 — Shell, Navigation & Primitives**: `mod.rs`, `router.rs` (`SettingsPageId`, aliases, intents), `shell.rs` (`SettingsShell` nav + sticky header + `SettingsChrome`), `primitives.rs` (`SettingsPage`, `SettingsSection`, `SettingsRow`, `SettingsEmptyState`, `SettingsStatTile`, `EntityIcon`, `SettingsStatusPill`, `OperationFeedback`), `icons.rs`.
2. **Slice 2 — App & Diagnostics Pages**: `UpdatesPage`, `DesktopPage` (`ShortcutRecorder`), `FeatureFlagsPage`, `PrivacyTelemetryPage`, `DeveloperPage`.
3. **Slice 3 — Usage, Archived Chats & Conversation Import, Backup Split Inspector**: `UsagePage` (+ pure `aggregate_usage_from_runtimes` + "How estimates work" dialog), `ArchivedChatsPage` + `ConversationImportDialog`, `BackupPage` (`BackupSidebar` + `BackupDetailView` + `CheckpointDeltaView`).
4. **Slice 4 — Providers, Models & Workspace Defaults**: `ProvidersPage` (+ `providers_utils.rs`), `ManageModelsDialog`, `WorkspacesPage` (`defaults` / `models` / `profile`, `SearchSettingsCard`, `OpenAiCompatibleModelSettingsCard`, `GeminiApiSettingsCard`).
5. **Slice 5 — Subagents, Memory & Remote Access**: `SubagentsPage` + `ProfileDialog`, `MemoryPage` + `AdvancedMemoryPanel` + Skill Improvement, `RemoteAccessPage` (QR + trusted devices).
6. **Slice 6 — Tool Access (MCP Connectors, Apps, Plugins, Skills, Marketplaces, Import)**: `ToolAccessPage`, `McpServersPage` + `mcp_server_draft.rs` + `mcp_server_editor_state.rs`, `OpenAiNativeConnectorsPage`, `PluginsSection`, `SkillsSection`, `marketplace_catalog.rs`, `AddMarketplaceDialog`, `InstallPluginDialog`, `InstallSkillDialog`, `ImportDialog`, `PluginDetailDialog`, `SkillDetailDialog`, `MarketplaceDetailDialog`.

**Verification on each slice**:
- Unit tests for pure logic (`providers_utils`, `mcp_server_draft`, `aggregate_usage_from_runtimes`, workspace target resolution, routing aliases/availability).
- Headless Rune renders (`--snap` PNGs + `--tree` accessibility/layout JSON at 1280×800 and 860×700 in both light & dark themes) for every page and major modal, visually compared against `apps/desktop` (`bun run desktop:web` / Electron captures).
- Run `cargo test -p cowork-desktop`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check` before posting `@architect merge rune-settings`.
