# Unused code audit

Audit baseline: `5ba8f6f8ab36e8b5bda3f79500b9747c8ecec41d` (2026-08-27).
This records every finding in the cleanup slice, not a promise that later changes
produce identical scanner counts. The [complexity tracker](complexity-tracker.md)
records integration and platform verification.

Fresh `bun run knip --reporter json` reported 227 unused value exports and 133
unused type exports across 133 files, with no unused files. All 360 names were
reviewed through source/test/fixture searches, module consumers, local uses,
compatibility contracts and tests. Removing an unused task-schema test hook
exposed one additional candidate, `TASK_STATUSES`; it remains a public task enum.

| Disposition | Value exports | Types | Names |
| --- | ---: | ---: | ---: |
| Deleted unreachable declarations | 10 | 2 | 12 |
| Made internal declarations private | 112 | 1 | 113 |
| Retained source contracts and dynamic test API | 106 | 130 | 236 |
| Total reviewed, including the newly exposed enum | 228 | 133 | 361 |

The cleanup removed 103 net product lines across 75 files. No Knip suppression,
allowlist, ignore entry or dependency was added. Knip still exits nonzero for the
236 retained findings; that is an advisory result, not a clean scanner result.

## Deleted declarations

These names had no consumers. The live entrypoints and wire/persistence contracts
were preserved; the linked tests ran before and after deletion.

| Source file | Declarations | Reason and checks |
| --- | --- | --- |
| [apps/desktop/electron/services/productAnalytics.ts](../apps/desktop/electron/services/productAnalytics.ts) | `resolveDesktopProductAnalyticsConfig` | Unused config wrapper; the live service still builds renderer configuration. [product-analytics-apply.test.ts](../apps/desktop/test/product-analytics-apply.test.ts). |
| [apps/mobile/src/features/cowork/threadStore.ts](../apps/mobile/src/features/cowork/threadStore.ts) | `MobileThreadFeedEntry` | Unused alias; live store shapes use the canonical SessionFeedItem. [mobile.thread-store.test.ts](../test/mobile.thread-store.test.ts). |
| [apps/mobile/src/features/pairing/pairingTypes.ts](../apps/mobile/src/features/pairing/pairingTypes.ts) | `TrustedDesktopSummary` | Unreferenced legacy relay-shaped interface; current pairing contracts stay. [mobile.pairing-scan-handler.test.ts](../test/mobile.pairing-scan-handler.test.ts). |
| [apps/mobile/src/features/relay/connectionState.ts](../apps/mobile/src/features/relay/connectionState.ts) | `isLiveTransportStatus` | Unused duplicate of the live workspace-readiness predicate. [mobile.connection-state.test.ts](../test/mobile.connection-state.test.ts). |
| [src/providers/minimaxShared.ts](../src/providers/minimaxShared.ts) | `MINIMAX_DEFAULT_MODEL` | Unused default constant; provider registry and model resolution stay. [minimax.test.ts](../test/providers/minimax.test.ts). |
| [src/runtime/googleInteractionsModel.ts](../src/runtime/googleInteractionsModel.ts) | `__internal` | Unused object exposing the private model table; live model resolution stays. [runtime.google-interactions.test.ts](../test/runtime.google-interactions.test.ts). |
| [src/server/jsonrpc/routes/outcomes.ts](../src/server/jsonrpc/routes/outcomes.ts) | `captureBindingCorrelatedOutcome` | Unwired capture wrapper; active route outcome helpers stay. [jsonrpc.routes.review-fixes.test.ts](../test/jsonrpc.routes.review-fixes.test.ts). |
| [src/server/jsonrpc/schema.tasks.ts](../src/server/jsonrpc/schema.tasks.ts) | `__taskSchemaInternals` | Unused test-only enum schema; no request/result/notification registry uses it. [jsonrpc.control-schemas.test.ts](../test/jsonrpc.control-schemas.test.ts). |
| [src/server/tasks/taskReviewPolicy.ts](../src/server/tasks/taskReviewPolicy.ts) | `getPendingTaskReview` | Unused activity-only wrapper; context-based lookup still handles legacy activity. [taskReview.test.ts](../test/tools/taskReview.test.ts). |
| [src/sync/types.ts](../src/sync/types.ts) | `DEFAULT_CLOUD_SYNC_SETTINGS` | Unused defaults object; live settings normalization keeps the same defaults. [sync.cloud-sync.test.ts](../test/sync.cloud-sync.test.ts). |
| [src/telemetry/productAnalytics.ts](../src/telemetry/productAnalytics.ts) | `identifyAnonymous` | Unused identity mutation wrapper; initialization still normalizes identity. [productAnalytics.test.ts](../test/productAnalytics.test.ts). |
| [src/tools/taskReview.ts](../src/tools/taskReview.ts) | `__internal` | Unused helper-export object; tests exercise the real review tool. [taskReview.test.ts](../test/tools/taskReview.test.ts). |

## Made private

These declarations are used inside their defining modules, with no named or
namespace consumer of their exports. Their implementations remain in place.
Existing test hooks still expose the functions they need through their existing
objects. `XlsxRelationship` is the only type in this table; it describes data used
solely by the now-private OOXML readers.

| Source file | Declarations | Checks |
| --- | --- | --- |
| [apps/desktop/electron/services/crashReporting.ts](../apps/desktop/electron/services/crashReporting.ts) | `resolveDesktopMainCrashReportingConfig`, `applyCrashReportingProcessEnv`, `registerMainCrashReportingHandlers` | [telemetry-status.test.ts](../apps/desktop/test/telemetry-status.test.ts) |
| [apps/desktop/electron/services/productAnalytics.ts](../apps/desktop/electron/services/productAnalytics.ts) | `applyProductAnalyticsProcessEnv` | [product-analytics-apply.test.ts](../apps/desktop/test/product-analytics-apply.test.ts) |
| [apps/desktop/electron/services/windowsSandboxReadiness.ts](../apps/desktop/electron/services/windowsSandboxReadiness.ts) | `WINDOWS_SANDBOX_READINESS_FILE` | [Typecheck](../apps/desktop/tsconfig.json) |
| [apps/desktop/src/app/composerDrafts.ts](../apps/desktop/src/app/composerDrafts.ts) | `EMPTY_COMPOSER_DRAFT` | [bootstrap-cache.test.ts](../apps/desktop/test/bootstrap-cache.test.ts) |
| [apps/desktop/src/app/interactionQueue.ts](../apps/desktop/src/app/interactionQueue.ts) | `isInteractionOutstanding`, `orderedInteractionThreadIds` | [interaction-card.test.tsx](../apps/desktop/test/interaction-card.test.tsx) |
| [apps/desktop/src/app/store.actions/workspaceMemoryDefaults.ts](../apps/desktop/src/app/store.actions/workspaceMemoryDefaults.ts) | `normalizeMemoryGenerationModel` | [workspace-memory-defaults.test.ts](../apps/desktop/test/workspace-memory-defaults.test.ts) |
| [apps/desktop/src/app/store.helpers/paintScheduling.ts](../apps/desktop/src/app/store.helpers/paintScheduling.ts) | `runAfterNextPaintOrTimeout` | [Typecheck](../apps/desktop/tsconfig.json) |
| [apps/desktop/src/app/store.helpers/runtimeState.ts](../apps/desktop/src/app/store.helpers/runtimeState.ts) | `clearWorkspaceServerRestartBackoffState` | [runtimeState.test.ts](../apps/desktop/test/runtimeState.test.ts) |
| [apps/desktop/src/lib/adaptiveLayout.ts](../apps/desktop/src/lib/adaptiveLayout.ts) | `resolveDesktopLayoutTier` | [adaptive-layout.test.ts](../apps/desktop/test/adaptive-layout.test.ts) |
| [apps/desktop/src/lib/indexedDbReliableBatchStore.ts](../apps/desktop/src/lib/indexedDbReliableBatchStore.ts) | `RELIABLE_BATCH_DB_NAME` | [web-transcript-delivery.test.ts](../apps/desktop/test/web-transcript-delivery.test.ts) |
| [apps/desktop/src/lib/modelChoices.ts](../apps/desktop/src/lib/modelChoices.ts) | `UI_DISABLED_PROVIDERS`, `hasConfiguredProviderStatus` | [manage-models-dialog.test.tsx](../apps/desktop/test/manage-models-dialog.test.tsx) |
| [apps/desktop/src/lib/themeBootstrap.ts](../apps/desktop/src/lib/themeBootstrap.ts) | `parseThemeSource` | [canvas-theme.test.ts](../apps/desktop/test/canvas-theme.test.ts) |
| [apps/desktop/src/lib/webTranscriptDelivery.ts](../apps/desktop/src/lib/webTranscriptDelivery.ts) | `WEB_TRANSCRIPT_LIMITS` | [web-transcript-delivery.test.ts](../apps/desktop/test/web-transcript-delivery.test.ts) |
| [apps/desktop/src/ui/chat/InteractionCard.tsx](../apps/desktop/src/ui/chat/InteractionCard.tsx) | `approvalRiskLabel` | [interaction-card.test.tsx](../apps/desktop/test/interaction-card.test.tsx) |
| [apps/desktop/src/ui/chat/activityGroups.ts](../apps/desktop/src/ui/chat/activityGroups.ts) | `mergeTurnActivity`, `confirmedRecoveredToolIds` | [accessibility-review-fixes.test.ts](../apps/desktop/test/accessibility-review-fixes.test.ts) |
| [apps/desktop/src/ui/chat/feedMessageParsing.ts](../apps/desktop/src/ui/chat/feedMessageParsing.ts) | `parseUserMessageAttachments` | [feed-message-parsing.test.ts](../apps/desktop/test/feed-message-parsing.test.ts) |
| [apps/desktop/src/ui/chat/scrollOwnership.ts](../apps/desktop/src/ui/chat/scrollOwnership.ts) | `FOLLOW_TAIL_THRESHOLD_PX` | [chat-feed-scroller.test.tsx](../apps/desktop/test/chat-feed-scroller.test.tsx) |
| [apps/desktop/src/ui/chat/toolCards/toolCardFormatting.ts](../apps/desktop/src/ui/chat/toolCards/toolCardFormatting.ts) | `formatDisplayPath` | [tool-card-formatting.test.ts](../apps/desktop/test/tool-card-formatting.test.ts) |
| [apps/mobile/src/components/composerShared.tsx](../apps/mobile/src/components/composerShared.tsx) | `DEFAULT_SUBMIT_LABEL`, `COMPOSER_PLACEHOLDER` | [mobile.composer-components.test.ts](../test/mobile.composer-components.test.ts) |
| [apps/mobile/src/components/pairing/pairing-ios-ui.tsx](../apps/mobile/src/components/pairing/pairing-ios-ui.tsx) | `primaryActionButtonModifiers` | [Typecheck](../apps/mobile/tsconfig.json) |
| [apps/mobile/src/features/cowork/activityGroups.ts](../apps/mobile/src/features/cowork/activityGroups.ts) | `confirmedRecoveredToolIds` | [mobile.activity-groups.test.ts](../test/mobile.activity-groups.test.ts) |
| [apps/mobile/src/features/cowork/mobilePerformanceContracts.ts](../apps/mobile/src/features/cowork/mobilePerformanceContracts.ts) | `MOBILE_PROFILED_ROW_WINDOW` | [mobile.list-performance.test.ts](../test/mobile.list-performance.test.ts) |
| [apps/mobile/src/features/cowork/sessionBootstrap.ts](../apps/mobile/src/features/cowork/sessionBootstrap.ts) | `SESSION_RETRY_DELAY_MS` | [mobile.session-bootstrap.test.ts](../test/mobile.session-bootstrap.test.ts) |
| [apps/mobile/src/features/cowork/threadHomeModel.ts](../apps/mobile/src/features/cowork/threadHomeModel.ts) | `HOME_SECTION_KEYS`, `INITIAL_VISIBLE_CHAT_COUNT`, `INITIAL_VISIBLE_PROJECT_THREAD_COUNT` | [mobile.list-performance.test.ts](../test/mobile.list-performance.test.ts) |
| [apps/mobile/src/features/cowork/threadListModel.ts](../apps/mobile/src/features/cowork/threadListModel.ts) | `chatRenderItemKey` | [mobile.list-performance.test.ts](../test/mobile.list-performance.test.ts) |
| [apps/mobile/src/features/cowork/threadOfflineCache.ts](../apps/mobile/src/features/cowork/threadOfflineCache.ts) | `THREAD_OFFLINE_CACHE_KEY` | [mobile.thread-store.test.ts](../test/mobile.thread-store.test.ts) |
| [apps/mobile/src/features/relay/secureTransportClient.ts](../apps/mobile/src/features/relay/secureTransportClient.ts) | `DESKTOP_IDENTITY_CHANGED_ERROR` | [mobile.app-provider.test.tsx](../test/mobile.app-provider.test.tsx) |
| [src/coworkRuntime/download.ts](../src/coworkRuntime/download.ts) | `githubReleaseAssetUrl` | [coworkRuntimeDownload.test.ts](../test/coworkRuntimeDownload.test.ts) |
| [src/coworkRuntime/ensureReady.ts](../src/coworkRuntime/ensureReady.ts) | `DEFAULT_COWORK_RUNTIME_REPOSITORY`, `DEFAULT_COWORK_RUNTIME_VERSION` | [coworkRuntime.test.ts](../test/coworkRuntime.test.ts) |
| [src/coworkRuntime/install.ts](../src/coworkRuntime/install.ts) | `CURRENT_RUNTIME_FILE` | [coworkRuntime.test.ts](../test/coworkRuntime.test.ts) |
| [src/coworkRuntime/integrity.ts](../src/coworkRuntime/integrity.ts) | `assertTrustedRuntimeManifest` | [coworkRuntime.test.ts](../test/coworkRuntime.test.ts) |
| [src/coworkRuntime/manifest.ts](../src/coworkRuntime/manifest.ts) | `parseRuntimeManifest` | [coworkRuntime.test.ts](../test/coworkRuntime.test.ts) |
| [src/coworkRuntime/platform.ts](../src/coworkRuntime/platform.ts) | `compatibleHostsForAsset` | [coworkRuntime.test.ts](../test/coworkRuntime.test.ts) |
| [src/coworkRuntime/runtime.ts](../src/coworkRuntime/runtime.ts) | `resolveManifestPath` | [coworkRuntime.test.ts](../test/coworkRuntime.test.ts) |
| [src/import/conversations/normalize.ts](../src/import/conversations/normalize.ts) | `stableHash`, `titleFromText`, `makeConversationFingerprint` | [import-conversations.test.ts](../test/import-conversations.test.ts) |
| [src/import/conversations/snapshot.ts](../src/import/conversations/snapshot.ts) | `buildImportBanner` | [import-conversations.test.ts](../test/import-conversations.test.ts) |
| [src/models/childModelRouting.ts](../src/models/childModelRouting.ts) | `childModelRef` | [childModelRouting.test.ts](../test/childModelRouting.test.ts) |
| [src/platform/sandbox/bwrap.ts](../src/platform/sandbox/bwrap.ts) | `BWRAP_PROGRAM` | [sandbox.test.ts](../test/platform/sandbox.test.ts) |
| [src/providers/customModels.ts](../src/providers/customModels.ts) | `writeCustomModelStore` | [childModelRouting.test.ts](../test/childModelRouting.test.ts) |
| [src/providers/minimaxShared.ts](../src/providers/minimaxShared.ts) | `MINIMAX_API_KEY_ENV` | [minimax.test.ts](../test/providers/minimax.test.ts) |
| [src/providers/modelDiscoveryAdapters.ts](../src/providers/modelDiscoveryAdapters.ts) | `codexAppServerModelToCachedModel`, `discoverCodexAppServerModels`, `discoverLmStudioModels`, `discoverGoogleModels`, `discoverAnthropicModels` | [model-discovery-cache.test.ts](../test/providers/model-discovery-cache.test.ts) |
| [src/providers/modelDiscoveryCache.ts](../src/providers/modelDiscoveryCache.ts) | `MODEL_DISCOVERY_CACHE_VERSION`, `DEFAULT_MODEL_DISCOVERY_CACHE_TTL_MS`, `modelDiscoveryCacheDir`, `normalizeDiscoveredModel`, `normalizeModelDiscoveryModels` | [models.customModelResolution.test.ts](../test/models.customModelResolution.test.ts) |
| [src/runtime/codexAppServer/config.ts](../src/runtime/codexAppServer/config.ts) | `normalizeSummary` | [config.test.ts](../test/runtime/codex-app-server/config.test.ts) |
| [src/runtime/pi/rateLimitRetry.ts](../src/runtime/pi/rateLimitRetry.ts) | `RATE_LIMIT_RETRY_BASE_DELAY_MS` | [runtime.pi-rate-limit-retry.test.ts](../test/runtime.pi-rate-limit-retry.test.ts) |
| [src/server/artifacts/diffUtils.ts](../src/server/artifacts/diffUtils.ts) | `MAX_TEXT_DIFF_LINE_CHARS`, `MAX_TEXT_DIFF_DETAIL_CHARS`, `MAX_UNIFIED_DIFF_CHARS`, `sequenceDiff` | [artifactComparisonService.test.ts](../test/artifactComparisonService.test.ts) |
| [src/server/artifacts/ooxml.ts](../src/server/artifacts/ooxml.ts) | `MAX_OOXML_COMPRESSED_BYTES`, `MAX_OOXML_UNCOMPRESSED_BYTES`, `MAX_OOXML_ENTRY_BYTES`, `extensionForFilename`, `looksLikeUtf8Text`, `hasZipSignature`, `hasPdfSignature`, `readBoundedBinaryPart`, `normalizeZipPath` | [artifactComparisonService.test.ts](../test/artifactComparisonService.test.ts) |
| [src/server/jsonrpc/routes/tasks.ts](../src/server/jsonrpc/routes/tasks.ts) | `resolveTaskWorkspacePath` | [jsonrpc.tasks-route.test.ts](../test/jsonrpc.tasks-route.test.ts) |
| [src/server/jsonrpc/serverRequestReceipts.ts](../src/server/jsonrpc/serverRequestReceipts.ts) | `SERVER_REQUEST_RECEIPT_HORIZON_MS`, `MAX_SERVER_REQUEST_RECEIPTS` | [serverRequestReceipts.test.ts](../test/server/serverRequestReceipts.test.ts) |
| [src/server/projection/conversationProjectionReasoning.ts](../src/server/projection/conversationProjectionReasoning.ts) | `resolveReasoningText` | [feed-message-parsing.test.ts](../apps/desktop/test/feed-message-parsing.test.ts) |
| [src/server/session/taskLocks.ts](../src/server/session/taskLocks.ts) | `terminalTaskLock`, `activeSourceChatLock`, `getTaskThreadLock`, `getActiveSourceChatLock` | [flow.task-terminal-locks.test.ts](../test/jsonrpc/flow.task-terminal-locks.test.ts) |
| [src/server/spreadsheetOoxml.ts](../src/server/spreadsheetOoxml.ts) | `readRelationships`, `readXmlPart`, `resolveRelationshipTarget`, `normalizeZipPath`, `arrayOfRecords`, `readInteger`, `XlsxRelationship` | [spreadsheetPreview.test.ts](../test/spreadsheetPreview.test.ts) |
| [src/server/tasks/TaskCoordinator.ts](../src/server/tasks/TaskCoordinator.ts) | `buildTaskQuestionContinuationPrompt`, `buildTaskRetryPrompt` | [jsonrpc.tasks-route.test.ts](../test/jsonrpc.tasks-route.test.ts) |
| [src/server/tasks/taskReviewPolicy.ts](../src/server/tasks/taskReviewPolicy.ts) | `getTaskReviewRounds` | [taskReview.test.ts](../test/tools/taskReview.test.ts) |
| [src/server/transport/httpJsonRpcConnection.ts](../src/server/transport/httpJsonRpcConnection.ts) | `HTTP_RPC_RESPONSE_TIMEOUT_MS` | [jsonrpc.router.test.ts](../test/jsonrpc.router.test.ts) |
| [src/shared/agentProfiles.ts](../src/shared/agentProfiles.ts) | `dedupeStrings` | [agentProfiles.test.ts](../test/agentProfiles.test.ts) |
| [src/shared/attachments.ts](../src/shared/attachments.ts) | `formatAttachmentDisplayText` | [composer-attachments.test.ts](../apps/desktop/test/composer-attachments.test.ts) |
| [src/shared/reliableBatchQueue.ts](../src/shared/reliableBatchQueue.ts) | `isReliableBatchEnvelope` | [reliableBatchQueue.test.ts](../test/reliableBatchQueue.test.ts) |
| [src/shared/toolRetry.ts](../src/shared/toolRetry.ts) | `isFailedToolItem`, `isSuccessfulToolItem` | [tool-retry-lineage.test.ts](../test/tool-retry-lineage.test.ts) |
| [src/shared/transcriptBatchProtocol.ts](../src/shared/transcriptBatchProtocol.ts) | `TRANSCRIPT_REQUEST_ENVELOPE_RESERVE_BYTES`, `measureTranscriptRequestBytes` | [webDesktopRoutes.test.ts](../test/webDesktopRoutes.test.ts) |
| [src/skills/defaultGlobalSkills.ts](../src/skills/defaultGlobalSkills.ts) | `DEFAULT_GLOBAL_SKILLS`, `isDefaultPluginRemoved` | [default-global-skills.test.ts](../test/default-global-skills.test.ts) |
| [src/skills/loadSkillBody.ts](../src/skills/loadSkillBody.ts) | `SKILL_POLICY_OVERLAYS` | [skills.feature-gates.test.ts](../test/skills.feature-gates.test.ts) |
| [src/telemetry/config.ts](../src/telemetry/config.ts) | `NETWORK_TELEMETRY_KILL_SWITCH_ENV` | [telemetry.config.test.ts](../test/telemetry.config.test.ts) |
| [src/telemetry/crashReporting.ts](../src/telemetry/crashReporting.ts) | `buildSentryOptions`, `scrubSentryEvent`, `scrubSentryBreadcrumb` | [crashReporting.test.ts](../test/crashReporting.test.ts) |
| [src/utils/permissions.ts](../src/utils/permissions.ts) | `resolveAgentTargetPathRoots` | [permissions.test.ts](../test/permissions.test.ts) |
| [src/workflows/inputSpill.ts](../src/workflows/inputSpill.ts) | `normalizeWorkflowInputFormat` | [inputSpill.test.ts](../test/workflows/inputSpill.test.ts) |
| [src/workflows/registry.ts](../src/workflows/registry.ts) | `WORKFLOW_DEFINITION_SCOPES`, `workflowDefinitionRoots` | [registry.test.ts](../test/workflows/registry.test.ts) |

## Retained contracts

Each row is a deliberate retention, not a claim that every name has a current
in-repository caller. Named schema pieces, public input/result types, canonical
facades, explicit compatibility aliases and installed component-library APIs
remain available to consumers. The file-size cap also has a proven dynamic test
consumer that Knip misses. No external-consumer census was performed. The source
links show the declarations and their owning contracts.

| Source file | Category | Declarations | Reason |
| --- | --- | --- | --- |
| [apps/desktop/electron/ipc/files.ts](../apps/desktop/electron/ipc/files.ts) | Dynamic test API | `MAX_READ_FILE_BYTES` | [ipc-files.test.ts](../apps/desktop/test/ipc-files.test.ts) loads the module with a query suffix, then destructures the real cap for its oversized-file regression. |
| [apps/desktop/electron/services/filePreviewRead.ts](../apps/desktop/electron/services/filePreviewRead.ts) | Preview facade | `CappedFilePreview` | Electron re-export of the shared capped-file-preview result. |
| [apps/desktop/electron/services/publicTelemetryEnv.ts](../apps/desktop/electron/services/publicTelemetryEnv.ts) | Public type | `PublicTelemetryEnvKey` | Key type of the public telemetry environment map. |
| [apps/desktop/src/app/composerDrafts.ts](../apps/desktop/src/app/composerDrafts.ts) | Public type | `PersistedComposerDraftAttachment` | Attachment shape of persisted composer drafts. |
| [apps/desktop/src/app/composerSubmission.ts](../apps/desktop/src/app/composerSubmission.ts) | Public type | `ComposerSubmissionPhase`, `ComposerSubmissionDelivery` | Named phase and delivery fields of a composer submission. |
| [apps/desktop/src/app/store.helpers.ts](../apps/desktop/src/app/store.helpers.ts) | State facade | `operationError`, `TaskLifecycleRequest`, `BootstrapPhase` | Named shared store, task, interaction, import or telemetry contracts. |
| [apps/desktop/src/app/types.ts](../apps/desktop/src/app/types.ts) | State facade | `DEFAULT_PRIVACY_TELEMETRY_SETTINGS`, `TaskArtifact`, `TaskArtifactRevision`, `TaskArtifactVersion`, `TaskQuestion`, `SkillImprovementStatus`, `ImportRuntimeState`, `InteractionStatus`, `AskInteraction`, `ApprovalInteraction`, `OperationErrorCode` | Named shared store, task, interaction, import or telemetry contracts. |
| [apps/desktop/src/components/ui/alert-dialog.tsx](../apps/desktop/src/components/ui/alert-dialog.tsx) | Component library | `AlertDialogMedia`, `AlertDialogOverlay`, `AlertDialogPortal` | Installed component-family composition API; [registry rules](../agent_docs/desktop-ui.md). |
| [apps/desktop/src/components/ui/alert.tsx](../apps/desktop/src/components/ui/alert.tsx) | Component library | `AlertAction` | Installed component-family composition API; [registry rules](../agent_docs/desktop-ui.md). |
| [apps/desktop/src/components/ui/attachment.tsx](../apps/desktop/src/components/ui/attachment.tsx) | Component library | `AttachmentTrigger` | Installed component-family composition API; [registry rules](../agent_docs/desktop-ui.md). |
| [apps/desktop/src/components/ui/bubble.tsx](../apps/desktop/src/components/ui/bubble.tsx) | Component library | `BubbleGroup`, `BubbleReactions` | Installed component-family composition API; [registry rules](../agent_docs/desktop-ui.md). |
| [apps/desktop/src/components/ui/command.tsx](../apps/desktop/src/components/ui/command.tsx) | Component library | `CommandShortcut` | Installed component-family composition API; [registry rules](../agent_docs/desktop-ui.md). |
| [apps/desktop/src/components/ui/empty.tsx](../apps/desktop/src/components/ui/empty.tsx) | Component library | `EmptyContent` | Installed component-family composition API; [registry rules](../agent_docs/desktop-ui.md). |
| [apps/desktop/src/components/ui/marker.tsx](../apps/desktop/src/components/ui/marker.tsx) | Component library | `MarkerIcon`, `markerVariants` | Installed component-family composition API; [registry rules](../agent_docs/desktop-ui.md). |
| [apps/desktop/src/components/ui/message.tsx](../apps/desktop/src/components/ui/message.tsx) | Component library | `MessageAvatar`, `MessageFooter`, `MessageGroup`, `MessageHeader` | Installed component-family composition API; [registry rules](../agent_docs/desktop-ui.md). |
| [apps/desktop/src/lib/adaptiveLayout.ts](../apps/desktop/src/lib/adaptiveLayout.ts) | Public type | `DesktopLayoutTier` | Layout-tier field of the public layout result. |
| [apps/desktop/src/lib/canvasDocumentController.ts](../apps/desktop/src/lib/canvasDocumentController.ts) | Public type | `CanvasDocumentSaveStatus`, `CanvasDocumentProblem` | Save status and problem fields of the public document state. |
| [apps/desktop/src/lib/desktopApi.ts](../apps/desktop/src/lib/desktopApi.ts) | Public type | `WorkspaceServerStatusReason`, `TelemetryStatusLabel` | Typed server-status and telemetry-label fields of the preload API. |
| [apps/desktop/src/lib/desktopCommands.ts](../apps/desktop/src/lib/desktopCommands.ts) | IPC facade | `invalidateWorkspaceFileChange`, `readFile`, `writeFile` | Complete typed file API across [types](../apps/desktop/src/lib/desktopApi.ts) and [preload](../apps/desktop/electron/preload.ts). |
| [apps/desktop/src/lib/modelChoices.ts](../apps/desktop/src/lib/modelChoices.ts) | Model facade | `CUSTOM_MODEL_PROVIDER_NAMES` | Re-export of the live canonical custom-model provider list. |
| [apps/desktop/src/ui/chat/CitationSourcesCarousel.tsx](../apps/desktop/src/ui/chat/CitationSourcesCarousel.tsx) | Public type | `SourceItem` | Source shape accepted by the exported carousel component. |
| [apps/mobile/src/components/thread/markdown-text.tsx](../apps/mobile/src/components/thread/markdown-text.tsx) | Parser facade | `parseRichBlocks`, `RichBlock` | Existing component-module re-export of the canonical markdown parser/type. |
| [apps/mobile/src/components/thread/markdownParser.ts](../apps/mobile/src/components/thread/markdownParser.ts) | Public type | `CodeBlockData` | Code-block member of the exported rich-block union. |
| [apps/mobile/src/cowork-shared/googleThinking.ts](../apps/mobile/src/cowork-shared/googleThinking.ts) | Mobile shared facade | `GOOGLE_REASONING_EFFORT_VALUES`, `isGoogleReasoningEffort`, `listGoogleThinkingLevelsForModel` | Compatibility surface over canonical modules; [identity checks](../test/mobile-shared-control-contract.test.ts). |
| [apps/mobile/src/cowork-shared/jsonrpcControlSchemas.ts](../apps/mobile/src/cowork-shared/jsonrpcControlSchemas.ts) | Mobile shared facade | `JsonRpcControlResultMethod`, `McpServerValidation`, `PluginCatalogSnapshot`, `WorkspaceControlStateEvents` | Compatibility surface over canonical modules; [identity checks](../test/mobile-shared-control-contract.test.ts). |
| [apps/mobile/src/cowork-shared/openaiCompatibleOptions.ts](../apps/mobile/src/cowork-shared/openaiCompatibleOptions.ts) | Mobile shared facade | `isCodexWebSearchMode`, `isCodexWebSearchBackend`, `isLocalWebSearchProvider`, `isCodexWebSearchContextSize`, `EditableProviderOptionsProviderName`, `CodexWebSearchContextSize`, `CodexWebSearchLocation`, `CodexWebSearchOptions`, `OpenAiProviderOptions`, `LmStudioProviderOptions`, `GoogleThinkingConfig` | Compatibility surface over canonical modules; [identity checks](../test/mobile-shared-control-contract.test.ts). |
| [apps/mobile/src/cowork-shared/openaiNativeConnectors.ts](../apps/mobile/src/cowork-shared/openaiNativeConnectors.ts) | Mobile shared facade | `openAiNativeConnectorSchema`, `OpenAiNativeConnectorConfigEntry` | Compatibility surface over canonical modules; [identity checks](../test/mobile-shared-control-contract.test.ts). |
| [apps/mobile/src/cowork-shared/types.ts](../apps/mobile/src/cowork-shared/types.ts) | Mobile shared facade | `RUNTIME_NAMES`, `ModelRuntimeSettings`, `UserProfile`, `InstalledPluginSkillSummary`, `PluginSourceInputKind`, `SkillInstallState`, `SkillInstallOriginKind`, `SkillInstallationDiagnosticSeverity`, `ObservabilityHealthStatus`, `HarnessConfig`, `HarnessContextMetadata`, `AgentMessages` | Compatibility surface over canonical modules; [identity checks](../test/mobile-shared-control-contract.test.ts). |
| [apps/mobile/src/features/accessibility/mobile-accessibility-policy.ts](../apps/mobile/src/features/accessibility/mobile-accessibility-policy.ts) | Accessibility facade | `resolveMobilePlatform` | Public platform/target-size policy surface; [platform checks](../test/mobile.accessibility-contract.test.ts). |
| [apps/mobile/src/features/accessibility/mobile-accessibility.ts](../apps/mobile/src/features/accessibility/mobile-accessibility.ts) | Accessibility facade | `ANDROID_MINIMUM_TOUCH_TARGET`, `IOS_MINIMUM_TOUCH_TARGET`, `resolveMobilePlatform`, `MobilePlatform` | Public platform/target-size policy surface; [platform checks](../test/mobile.accessibility-contract.test.ts). |
| [apps/mobile/src/features/cowork/activityGroups.ts](../apps/mobile/src/features/cowork/activityGroups.ts) | Public type | `ToolTraceItem`, `ActivityTraceEntry`, `ActivityGroupStatus` | Tool, entry and status shapes used by the exported activity group. |
| [apps/mobile/src/features/cowork/model-capability-availability.ts](../apps/mobile/src/features/cowork/model-capability-availability.ts) | Public type | `CapabilityAvailability` | Availability field of the exported capability result. |
| [apps/mobile/src/features/cowork/threadScrollState.ts](../apps/mobile/src/features/cowork/threadScrollState.ts) | Public type | `ThreadTailPosition` | Position field of the exported thread-tail state. |
| [src/coworkRuntime/integrity.ts](../src/coworkRuntime/integrity.ts) | Public type | `RuntimeKeyMaterial` | Value type of the trusted-runtime-key map. |
| [src/import/conversations/adapters/index.ts](../src/import/conversations/adapters/index.ts) | Import registry | `listConversationSourceAdapters` | Explicit enumeration API beside source lookup; current callers use lookup. |
| [src/import/conversations/index.ts](../src/import/conversations/index.ts) | Import facade | `conversationToSessionFeed` | Canonical import entrypoint; implementations remain used in defining modules. |
| [src/import/conversations/types.ts](../src/import/conversations/types.ts) | Import contract | `CONVERSATION_IMPORT_SOURCES`, `ConversationImportWarningCode` | Supported import sources and diagnostic warning-code contracts. |
| [src/import/discovery.ts](../src/import/discovery.ts) | Public type | `ImportDiagnostic` | Diagnostic entries in the public discovery result. |
| [src/import/index.ts](../src/import/index.ts) | Import facade | `listImportablePlugins`, `listImportableSkills`, `ImportDiagnostic`, `ExternalHome`, `ListImportableResult` | Canonical import entrypoint; implementations remain used in defining modules. |
| [src/platform/approval.ts](../src/platform/approval.ts) | Public type | `CommandRisk` | Risk field of the public command assessment. |
| [src/platform/fs.ts](../src/platform/fs.ts) | Public type | `RetryTuning`, `PrivatePathCommandResult` | Public filesystem dependency-injection and command-result shapes. |
| [src/platform/host.ts](../src/platform/host.ts) | Public type | `PlatformId` | Platform identifier re-exported by the canonical platform entrypoint. |
| [src/platform/index.ts](../src/platform/index.ts) | Platform facade | `hostArch`, `toDesktopPlatform`, `DesktopPlatform`, `PlatformId` | Canonical platform/sandbox API; [platform boundary rules](../agent_docs/repo-contracts.md). |
| [src/platform/sandbox/bwrap.ts](../src/platform/sandbox/bwrap.ts) | Compatibility alias | `collectExistingProtectedMetadataPaths`, `collectExistingProtectedMetadataDirs` | Explicit deprecated sandbox wrapper and legacy alias. |
| [src/platform/sandbox/index.ts](../src/platform/sandbox/index.ts) | Platform facade | `resetSandboxProbeCachesForTests`, `deriveWritableRoots`, `protectedMetadataPaths`, `windowsSandboxHome`, `SandboxDeniedInput`, `SandboxDeniedOptions`, `SandboxConfig`, `SandboxMode`, `SandboxCommand` | Canonical platform/sandbox API; [platform boundary rules](../agent_docs/repo-contracts.md). |
| [src/platform/sandbox/policy.ts](../src/platform/sandbox/policy.ts) | Platform facade | `deriveWritableRoots` | Canonical platform/sandbox API; [platform boundary rules](../agent_docs/repo-contracts.md). |
| [src/platform/sandbox/policy.ts](../src/platform/sandbox/policy.ts) | Public type | `WritableRootKind` | Writable-root classification in public sandbox policy inputs. |
| [src/providers/modelDiscoveryCache.ts](../src/providers/modelDiscoveryCache.ts) | Public type | `ModelDiscoveryReason`, `CachedModelReasoning` | Discovery-reason and cached-reasoning fields of public model results. |
| [src/server/agents/AgentControl.ts](../src/server/agents/AgentControl.ts) | Compatibility alias | `AgentControlTaskLockError` | Preserved TaskLockedError source-compatibility alias. |
| [src/server/artifacts/index.ts](../src/server/artifacts/index.ts) | Artifact facade | `ArtifactComparisonRequest` | Comparison request type from [ArtifactComparisonService](../src/server/artifacts/ArtifactComparisonService.ts). |
| [src/server/artifacts/types.ts](../src/server/artifacts/types.ts) | Shared schema | `artifactBinaryMetadataSchema`, `artifactDiffSummarySchema`, `textLineChangeSchema`, `docxParagraphSchema`, `docxHeadingSchema`, `docxTableSchema`, `docxSectionTextSchema`, `docxTrackedChangeSchema`, `ooxmlMediaSchema`, `docxSnapshotSchema`, `docxChangeSchema`, `pptxShapeSchema`, `pptxSlideSchema`, `pptxSnapshotSchema`, `pptxChangeSchema`, `spreadsheetCellStyleSchema`, `spreadsheetTableSummarySchema`, `spreadsheetChartSummarySchema`, `xlsxCellSchema`, `xlsxColumnWidthSchema`, `xlsxSheetSchema`, `xlsxSnapshotSchema`, `xlsxChangeSchema` | Independent validators composed into artifact preview/diff schemas. |
| [src/server/artifacts/types.ts](../src/server/artifacts/types.ts) | Shared type | `BinaryArtifactChange` | Named binary-change member of the artifact-diff contract. |
| [src/server/jsonrpc/schema.ts](../src/server/jsonrpc/schema.ts) | Shared schema | `jsonRpcResultSchemas` | Result registry composed into the generated JSON-RPC protocol schema. |
| [src/server/runtime/ServerRuntime.ts](../src/server/runtime/ServerRuntime.ts) | Public type | `HealthSnapshot`, `RuntimeStartupReadiness` | Return types of getHealthSnapshot and getStartupReadiness. |
| [src/server/session/turnExecution/runUserMessageTurn.ts](../src/server/session/turnExecution/runUserMessageTurn.ts) | Public type | `UserMessageTurnOptions`, `UserMessageTurnFinalizerCheckpoint` | Turn input and finalizer test-hook contracts. |
| [src/server/session/turnExecution/userMessageAttachments.ts](../src/server/session/turnExecution/userMessageAttachments.ts) | Public type | `UserContentMaterializationCheckpoint` | Materialization checkpoint shape accepted by the existing test hook. |
| [src/server/threads/types.ts](../src/server/threads/types.ts) | Public type | `ThreadRuntimeStatus`, `ThreadWorktreeStartingState`, `CreateThreadTarget`, `UnsupportedThreadOperationResult`, `ForkThreadEnvironment` | Thread status, creation/fork inputs and handoff result contracts. |
| [src/shared/agentProfiles.ts](../src/shared/agentProfiles.ts) | Shared schema | `AGENT_PROFILE_SCOPE_VALUES`, `agentProfileStringListSchema`, `agentProfileDefinitionSchema`, `agentProfileCatalogEntrySchema`, `agentProfileDiagnosticSchema`, `agentProfileWorkspaceAvailabilityInputSchema` | Profile, catalog, diagnostic and availability validation contracts. |
| [src/shared/agentProfiles.ts](../src/shared/agentProfiles.ts) | Shared type | `AgentProfileWorkspaceAvailabilityInput`, `AgentProfilePromptSummary` | Named profile availability input and prompt-summary contracts. |
| [src/shared/agents.ts](../src/shared/agents.ts) | Shared schema | `agentReportStatusSchema` | Canonical agent-report status validator. |
| [src/shared/canvasDocument.ts](../src/shared/canvasDocument.ts) | Shared type | `CanvasDocumentSessionRef`, `CanvasDocumentSaveSuccess` | Session-reference and save-success contracts. |
| [src/shared/creationReadiness.ts](../src/shared/creationReadiness.ts) | Shared schema | `creationKindSchema`, `creationRepairActionSchema`, `creationReadinessCheckSchema` | Creation/readiness checks and repair-action validators. |
| [src/shared/creationReadiness.ts](../src/shared/creationReadiness.ts) | Shared type | `CreationKind` | Named chat/task creation-kind contract. |
| [src/shared/displayCitationMarkers.ts](../src/shared/displayCitationMarkers.ts) | Citation facade | `extractReferencedCitationSourcesFromToolResult` | Shared citation-source re-export, also used for source selection. |
| [src/shared/idempotencyLedger.ts](../src/shared/idempotencyLedger.ts) | Shared type | `IdempotencyOutcome` | Resolved outcome of an idempotency replay claim. |
| [src/shared/reliableBatchQueue.ts](../src/shared/reliableBatchQueue.ts) | Shared type | `ReliableBatchStatus`, `ReliableBatchFailureReason`, `ReliableBatchDeliveryContext` | Queue status, failure and delivery callback contracts. |
| [src/shared/spreadsheetPreview.ts](../src/shared/spreadsheetPreview.ts) | Shared type | `SpreadsheetChartAnchor`, `SpreadsheetCellEditRequest`, `SpreadsheetCellEditResult`, `SpreadsheetRangeFormatRequest`, `SpreadsheetRangeFormatResult`, `SpreadsheetBatchPatchCellOperation`, `SpreadsheetBatchPatchFormatOperation`, `SpreadsheetBatchPatchMergeOperation`, `SpreadsheetBatchPatchColumnWidthOperation` | Spreadsheet edit/result/patch-operation and chart-anchor contracts. |
| [src/shared/tasks.ts](../src/shared/tasks.ts) | Shared schema | `TASK_CREATION_ORIGINS`, `TASK_QUESTION_STATUSES`, `TASK_ACTIVITY_KINDS`, `TASK_ARTIFACT_VERSION_REVIEW_STATUSES`, `TASK_ARTIFACT_REVISION_STATUSES`, `taskCreationRequirementInputSchema`, `taskCreationWorkItemInputSchema`, `taskCreationDecisionInputSchema`, `taskRequirementSchema`, `taskThreadSchema`, `workItemSchema`, `taskDecisionSchema`, `taskQuestionOptionSchema`, `taskQuestionSchema`, `taskArtifactSchema`, `taskArtifactVersionSchema`, `taskBlockerSchema`, `TASK_STATUSES` | Task enums and independent validators used by aggregate task contracts. |
| [src/shared/tasks.ts](../src/shared/tasks.ts) | Shared type | `TaskQuestionUrgency`, `TaskQuestionStatus`, `TaskArtifactVersionReviewStatus`, `TaskQuestionOption`, `TaskDirectiveResultTask`, `TaskCreationRequirementInput`, `TaskCreationWorkItemInput`, `TaskCreationDecisionInput` | Named task question, revision and creation-input contracts. |
| [src/shared/toolRetry.ts](../src/shared/toolRetry.ts) | Shared type | `ToolRetryTarget` | Named retry target returned by shared retry resolution. |
| [src/shared/toolRetryRawEvents.ts](../src/shared/toolRetryRawEvents.ts) | Shared type | `RawToolCallMetadata` | Tool-call metadata accepted by raw-event retry resolution. |
| [src/shared/workflows.ts](../src/shared/workflows.ts) | Shared schema | `WORKFLOW_AGENT_STATES`, `WORKFLOW_RUN_OUTCOMES`, `workflowProgressAgentSchema` | Workflow progress states and result validators. |
| [src/shared/workflows.ts](../src/shared/workflows.ts) | Shared type | `WorkflowAgentState` | Named state member of the workflow progress contract. |
| [src/sync/types.ts](../src/sync/types.ts) | Public type | `CloudSyncWorkspaceMetadataPayload`, `CloudSyncThreadPayload` | Workspace/thread members of the public cloud-sync payload union. |
| [src/telemetry/crashReporting.ts](../src/telemetry/crashReporting.ts) | Public type | `CrashReportingComponent`, `CrashReportingTags`, `CrashReportingExtras`, `CrashReportingSdkLoader` | Component/event metadata and initialization SDK-injection contracts. |
| [src/telemetry/productAnalytics.ts](../src/telemetry/productAnalytics.ts) | Public type | `ProductAnalyticsEventSource`, `ProductAnalyticsPropertyName`, `ProductAnalyticsEventMap`, `ProductAnalyticsEnv`, `ProductAnalyticsSdkLoader` | Event properties, environment and initialization SDK-injection contracts. |
| [src/types.ts](../src/types.ts) | Public type | `SkillMarketplaceMetadata`, `ObservabilityConfig` | Marketplace and observability fields in canonical configuration/catalog types. |
| [src/workflows/registry.ts](../src/workflows/registry.ts) | Public type | `WorkflowDefinitionScope` | Scope field of workflow definition inputs and registry entries. |

## Verification

The cleanup ran 92 consumer/feature test files before editing, plus 10 additional
baseline files and two task-schema baseline files. A separate 15-file run passed
after deletion, before export visibility changed.

The first full integration run caught the missed dynamic import of
`MAX_READ_FILE_BYTES` in [ipc-files.test.ts](../apps/desktop/test/ipc-files.test.ts).
The isolated file reproduced the failure. Restoring the unchanged export made
all 19 tests pass without changing the cap or weakening the regression. A fresh
audit checked all 113 original visibility candidates: 101 had no other source
token occurrence, and 12 cross-source cases were traced individually. The cap
was the only additional export consumer; the others used existing test-hook
properties, comments, or separate same-named declarations. Query-suffixed and
template module paths were included in that audit.

The corrected post-cleanup run passed 1,834 tests across 104 files, with 10
existing platform skips and no failures (7,870 assertions). Root, harness,
desktop and mobile typechecks passed. Biome rechecked all 75 changed source files
and the restored cap file; `git diff --check` passed. A fresh Knip run matched all
236 retained findings in the classification exactly.

Deletion and visibility changes were kept in separate patches. Applying both to
an isolated Git index at the baseline reproduced all 75 owned source changes
exactly, excluding the separate quality-check constant export in adaptiveLayout.
The restored cap file matches the baseline. Full-suite integration and native
platform results belong in the
[complexity tracker](complexity-tracker.md); these targeted results do not imply
Windows, Linux screenshot, or mobile device coverage.
