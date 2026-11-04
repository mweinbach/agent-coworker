//! Durable Project Task Mode orchestration (`TaskCoordinator`), lock enforcement,
//! system-prompt context rendering, and artifact preview/comparison services.

pub mod context_section;
pub mod coordinator;
pub mod locks;
pub mod policy;
pub mod preview_diff;

pub use context_section::render_task_context_section;
pub use coordinator::{
    AcceptArtifactVersionRequest, BriefRequirementInput, CaptureArtifactVersionRequest,
    ReadArtifactVersionOutput, RegisterArtifactRequest, ReplacementWorkItemInput,
    RestoreArtifactVersionRequest, RevisionOutcomeResult, StartArtifactRevisionRequest,
    TaskContinuationDispatcher, TaskCoordinator, TaskCoordinatorOptions, TaskNotification,
    TaskNotificationSink, TaskQuestionAnswerInput, TaskQuestionResumeStatus, TaskThreadFactory,
    TaskThreadFactoryInput, TaskThreadQuiescer, UpdateBriefRequest,
};
pub use locks::{
    PendingTerminalLockGuard, SettlingSessionLockGuard, TaskLockError, TaskLockErrorData,
    TaskLockKind, get_pending_terminal_task_lock, get_session_task_lock, is_terminal_task_status,
    register_pending_terminal_task_locks, register_settling_terminal_session_lock,
};
pub use policy::{
    DEFAULT_ARTIFACT_SETTLEMENT_RETRY_DELAYS_MS, TaskCoordinatorError, TaskReviewMaterial,
    build_artifact_revision_prompt, build_task_question_continuation_prompt,
    build_task_retry_prompt, canonicalize_workspace_str, is_terminal_task,
    is_valid_task_transition, media_type_for_artifact, same_workspace_path, validate_work_graph,
};
pub use preview_diff::{
    ArtifactBlobInput, ArtifactComparisonService, ArtifactDiffSummary, ArtifactKind,
    ArtifactPreviewService, MAX_ARTIFACT_DIFF_CHANGES, MAX_INLINE_PREVIEW_BYTES,
    MAX_PREVIEW_TEXT_CHARS,
};
