# Chat View Rune Port Plan (`crates/cowork-desktop/src/views/chat/`)

Port target for `apps/desktop/src/ui/` chat surfaces (`ChatView`, `chat/*`, `composer/*`, `markdown/*`, `attachments/*`, `AgentRunViewer`, `TranscriptDeliveryRecovery`).

## Module Layout

All files live inside `crates/cowork-desktop/src/views/chat/` and consume shared `AppState`, actions, protocol types, and theme tokens from `cowork-desktop` core:

| File | Responsibility |
| --- | --- |
| `mod.rs` | `ChatView` root, locked-task / read-only bars, keybindings, overlays, dispatch to `NewChatLanding` |
| `landing.rs` | `NewChatLanding`: centered title, readiness notice, landing composer, project/workspace picker, starter prompt chips |
| `feed.rs` | `ChatFeed`: virtualized `.growth` transcript scroll viewport, follow/detach scroll state, jump-to-latest pill, older-message expansion, day separators, working placeholder, empty/hydrating/reconnecting states |
| `feed_row.rs` | `FeedRow`: user bubble (`MentionText`, attachments, hover copy), assistant (`DesktopMarkdown` + citation carousel fallback), error card, dev-only system/log rows |
| `markdown.rs` | `DesktopMarkdown` over `rune_kit::Markdown`: streaming word reveals, code-block copy frame, local file `code_link` / confirmation links, inline image zoom, citation chips + carousel |
| `activity.rs` | `ActivityGroupCard` & `ToolClusterNode`: grouped live/completed activity timeline, live timer, collapsible parsed `ReasoningSectionNode` items, tool clustering, structured tool details, `DiffView` |
| `interaction.rs` | `InteractionCard`: `ask` prompts (choices, freeform input, skip, off-thread attribution) and `approval` prompts (sandbox blocked vs approval needed, command preview, retry error) |
| `composer.rs` | `ChatComposer`: `22px`-radius card, file drop/paste, attachment strip, submission/retry banner, `text_input` with `@`-mention spans, `PopupList` menu, attach button, model/reasoning pickers, stop/send/steer |
| `attachments.rs` | `FileAttachment` cards (thumbnail or category badge, middle/end-preserving extension truncation, type subtitle, remove button) |
| `agent_run_viewer.rs` | Read-only right slide-over drawer (`448px`) rendering subagent runs with `<workflow_result>` / `<agent_report>` markdown formatting |
| `dialogs.rs` | `CancelSubagentsDialog`, `LmStudioStartDialog`, `TranscriptDeliveryRecovery` floating card, external-link confirmation |
| `model.rs` | Pure presentation logic ported from `activityGroups.ts`, `chatLogic.ts`, `composerMentions.ts`, `feedMessageParsing.ts`, `feedWindow.ts`, `toolCardFormatting.ts`, `agentRunTranscript.ts` |

## React -> Rune / `rune-kit` Mapping

| React / Electron Surface | Rune / `rune-kit` Mapping | Notes |
| --- | --- | --- |
| `ChatFeed` + `MessageScroller` + `useFeedDerivationWindow` | `El::scroll(ScrollSpec { stick_bottom })` + `.growth(GrowthSpec)` + `.virtualize(..)` + `rune_kit::ScrollBar` + `.scroll_anchor()` | Transcript stack is the first child of the scroll viewport; rows carry own padding instead of stack gaps so virtualization height estimates hold. |
| `Streamdown` + `DesktopMarkdown` | `rune_kit::Markdown` (`.streaming(live).reveal(0.18).selectable(true)`) | Uses `parse_cached`, `.code_frame` for hover Copy, `.diagram_frame` for Mermaid, `.code_link` for inline file paths, `.images` / `.image_frame` for local media + zoom, `.on_link_tx` for safe routing. |
| Tool file edits / diff blocks | `rune_kit::diff::{DiffState, DiffView, FileDiff}` | `Write`/`Edit` tool details and unified diffs render with split/unified Myers word diffs instead of raw JSON `<pre>`. |
| `ComposerMentionInput` + `ComposerHighlightOverlay` | `rune::text_input(&TextEdit, style)` + `.decorations(spans)` + `.on_input_paste` + `.on_drop_files` | Eliminates hidden DOM mirror + `ResizeObserver` scroll sync; handles clipboard PNG images directly via `ClipboardContent::image()`. |
| `ComposerMentionMenu` | `rune_kit::PopupList` + `PopupItem` | Anchored to the composer container (`Side::Top`) without stealing keyboard focus from `TextEdit`. |
| `ComposerModelSelector` | `rune_kit::Combobox` (or `Popover` + searchable `PopupList`) | Grouped by provider, filtering hidden/unavailable local models, marking custom IDs. |
| `ComposerReasoningSelector` | `rune_kit::Select` | Canonical `Off` -> `Max` ordering with thread-owned persistence. |
| `ActivityGroupCard` / `Collapsible` | `rune_kit::Collapsible` + `Badge` + `Spinner` | Live header timer via `Tx::wake_after`; compact `Worked for X` / `Couldn't finish after X` separator trigger on completion. |
| `CancelSubagentsDialog` / `LmStudioStartDialog` | `rune_kit::Dialog` | Standard modal focus trap + Esc dismissal (locked while LM Studio is starting). |
| `DesktopCitationChip` / `MentionChip` | `rune_kit::Popover` + `Badge` + `Button` | Clickable chips open source/skill overview popovers; external URLs require explicit confirmation. |

## Native Improvements

- **IME-safe mention highlighting**: `TextEdit::decorations` styles `@skill` / `@plugin` byte ranges directly in the glyph run instead of maintaining a synced transparent `<textarea>` over a styled `<div>`.
- **Zero-copy incremental streaming**: `rune_kit::Markdown::streaming(true)` re-parses only the active trailing block while `.reveal(...)` smoothly fades newly streamed words on GPU.
- **Large-thread frame rate & scroll stability**: `.growth` + `.virtualize` + `.scroll_anchor()` + `Live`-driven `ScrollBar` avoid DOM tree-walker range restoration and RAF follow-tail loops.
- **Native diff & diagram tooling**: `DiffView` provides real split/unified Myers word diffs and hunk expansion for tool runs; `Markdown` renders Mermaid progressively as lines stream in.
- **Direct clipboard image paste & native file drop**: `on_input_paste` and `on_drop_files` bypass Electron file-path IPC shims.

## Rune Gaps & Workarounds

1. **LaTeX math blocks (`$...$` / `$$...$$`)**: `rune_kit::markdown::parser` enables strikethrough, tables, and tasklists on `pulldown-cmark`, not math extension rendering. Math expressions display as literal text/code spans initially.
2. **Inline mid-paragraph `<cite>` widget with favicon badge**: `Markdown` supports custom link appearance via `link_style` (`Span::bg`), `link_ring`, `LinkPaint`, and `link_help`, rather than embedding arbitrary multi-child `El` buttons mid-paragraph. Workaround: format inline citations as styled pill links (`cowork-citation:...`) whose `on_link_tx` opens an anchored citation `Popover` carousel, paired with the expandable `CitationSourcesCarousel` below the message.
3. **Developer-mode composer height drag grip (`MessageBarResizer`)**: `rune_kit::TextArea` does not ship a vertical resize grip; we wrap the bare `text_input` scroll container and bind `El::on_drag` on a subtle top edge handle when `developer_mode` is enabled.
4. **Hover-panning marquee on long citation titles**: `DesktopCitationChip` uses CSS/WAAPI translation; initial Rune port displays two-line wrapped/truncated titles in the `Popover` with a tooltip/copy fallback (or `rolling_text` if single-line).

## Shared Core Interfaces Needed from `@architect`

- **Theme tokens**: mapped palette, surface, border, typography, radius, and spacing constants compatible with `rune_kit::Kit` (light, dark, and high-contrast variants matching `apps/desktop/src/styles/tokens.css`).
- **AppState & Actions**: active/selected thread feed, live streaming deltas, `pendingTurnStart` / `pendingSteer` / `composerSubmission`, `attachmentIngestionPending`, `ThreadAgentSummary` subagent runs, `interactions` queue (`ask`/`approval`), `workspaceRuntimeById` (skills + plugins + reconnecting), `providerCatalog` + `lmStudioStartModal`, `transcriptDeliveryFailure`, `developerMode`, `sourceTask` lock metadata, and typed dispatch actions (`start_turn`, `steer_turn`, `cancel_turn`, `resolve_interaction`, `update_thread_model`, `ingest_files`, `confirm_open_external_url`, `open_file_preview`, `create_thread_from_landing`, `pick_attachments`).
