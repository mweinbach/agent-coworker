import {
  type ComposerDraftsByKey,
  composerDraftKeyForNewChatTarget,
  MAX_PERSISTED_COMPOSER_DRAFT_ATTACHMENT_BYTES,
  type PersistedComposerDraft,
  type PersistedComposerDrafts,
  sanitizePersistedComposerDrafts,
} from "./composerDrafts";
import type { WorkspaceRecord } from "./types";

const MAX_TASK_WORK_ITEMS = 100;
const MAX_DRAFT_STRING_LENGTH = 200_000;

export type CreationDraftError = {
  revision: number;
  message: string;
};

export type TaskCreationDraftWorkItem = {
  id: string;
  key: string;
  title: string;
  description: string;
  dependencies: string;
  expectedOutputs: string;
};

export type TaskCreationDraft = {
  revision: number;
  updatedAt: string;
  idempotencyKey: string;
  workspaceId: string;
  title: string;
  objective: string;
  context: string;
  requirements: string;
  constraints: string;
  acceptanceCriteria: string;
  decisions: string;
  reviewRequired: boolean;
  workItems: TaskCreationDraftWorkItem[];
  workGraphCustomized: boolean;
  showAdvancedWorkGraph: boolean;
};

export type PersistedCreationDrafts = {
  research?: PersistedComposerDraft;
  task?: TaskCreationDraft;
  taskError?: CreationDraftError;
};

export type HydratedCreationDrafts = {
  taskCreationDraft: TaskCreationDraft;
  taskCreationError: CreationDraftError | null;
};

function makeDraftId(): string {
  return crypto.randomUUID();
}

export function createEmptyTaskCreationDraft(revision = 0, workspaceId = ""): TaskCreationDraft {
  const now = new Date().toISOString();
  return {
    revision,
    updatedAt: now,
    idempotencyKey: makeDraftId(),
    workspaceId,
    title: "",
    objective: "",
    context: "",
    requirements: "",
    constraints: "",
    acceptanceCriteria: "",
    decisions: "",
    reviewRequired: true,
    workItems: [
      {
        id: makeDraftId(),
        key: "step-1",
        title: "",
        description: "",
        dependencies: "",
        expectedOutputs: "",
      },
    ],
    workGraphCustomized: false,
    showAdvancedWorkGraph: false,
  };
}

export function createEmptyCreationDrafts(): HydratedCreationDrafts {
  return {
    taskCreationDraft: createEmptyTaskCreationDraft(),
    taskCreationError: null,
  };
}

export function serializeCreationDrafts(
  state: Partial<HydratedCreationDrafts>,
): PersistedCreationDrafts {
  const taskDraft = state.taskCreationDraft ?? createEmptyTaskCreationDraft();
  const taskError =
    state.taskCreationError?.revision === taskDraft.revision ? state.taskCreationError : null;
  return {
    task: taskDraft,
    ...(taskError ? { taskError } : {}),
  };
}

export function hydrateCreationDrafts(value: unknown): HydratedCreationDrafts {
  const record = isRecord(value) ? value : {};
  const taskCreationDraft = sanitizeTaskCreationDraft(record.task);
  const taskCreationError = sanitizeCreationDraftError(
    record.taskError,
    taskCreationDraft.revision,
  );
  return {
    taskCreationDraft,
    taskCreationError,
  };
}

export function migrateLegacyResearchCreationDraft(
  composerDrafts: unknown,
  creationDrafts: unknown,
  ownership: {
    selectedWorkspaceId: string | null;
    workspaces: Pick<WorkspaceRecord, "id" | "workspaceKind">[];
    existingComposerDrafts?: ComposerDraftsByKey;
  },
): PersistedComposerDrafts {
  const drafts = sanitizePersistedComposerDrafts(composerDrafts);
  const legacyDraft = sanitizeLegacyResearchCreationDraft(
    isRecord(creationDrafts) ? creationDrafts.research : undefined,
  );
  if (!legacyDraft || !ownership.selectedWorkspaceId) return drafts;

  const workspace = ownership.workspaces.find(
    (candidate) => candidate.id === ownership.selectedWorkspaceId,
  );
  if (!workspace) return drafts;

  const destinationKey = composerDraftKeyForNewChatTarget(
    workspace.workspaceKind === "oneOffChat"
      ? { kind: "oneOff" }
      : { kind: "project", workspaceId: workspace.id },
  );
  for (const existingDraft of [
    drafts[destinationKey],
    ownership.existingComposerDrafts?.[destinationKey],
  ]) {
    if (
      existingDraft &&
      !(
        existingDraft.attachments.length === 0 &&
        JSON.stringify({ ...existingDraft, attachments: [] }) ===
          JSON.stringify({ ...legacyDraft, attachments: [] })
      ) &&
      (hasPersistedComposerDraftState(existingDraft) ||
        existingDraft.generation > legacyDraft.generation ||
        (existingDraft.generation === legacyDraft.generation &&
          existingDraft.revision >= legacyDraft.revision) ||
        Date.parse(existingDraft.updatedAt) >= Date.parse(legacyDraft.updatedAt))
    ) {
      return drafts;
    }
  }

  const persistedAttachmentBytes = Object.entries(drafts).reduce((total, [key, draft]) => {
    const persistedBytes = draft.attachments.reduce(
      (bytes, attachment) => bytes + attachment.size,
      0,
    );
    const inMemoryBytes =
      ownership.existingComposerDrafts?.[key]?.attachments.reduce(
        (bytes, attachment) => bytes + attachment.size,
        0,
      ) ?? 0;
    return total + Math.max(persistedBytes, inMemoryBytes);
  }, 0);
  const additionalInMemoryBytes = Object.entries(ownership.existingComposerDrafts ?? {}).reduce(
    (total, [key, draft]) =>
      key in drafts
        ? total
        : total + draft.attachments.reduce((bytes, attachment) => bytes + attachment.size, 0),
    0,
  );
  const legacyAttachmentBytes = legacyDraft.attachments.reduce(
    (total, attachment) => total + attachment.size,
    0,
  );
  if (
    persistedAttachmentBytes + additionalInMemoryBytes + legacyAttachmentBytes >
    MAX_PERSISTED_COMPOSER_DRAFT_ATTACHMENT_BYTES
  ) {
    return drafts;
  }

  return sanitizePersistedComposerDrafts({ ...drafts, [destinationKey]: legacyDraft });
}

export function sanitizePersistedCreationDrafts(value: unknown): PersistedCreationDrafts {
  const record = isRecord(value) ? value : {};
  const research = sanitizeLegacyResearchCreationDraft(record.research);
  const task = sanitizeTaskCreationDraft(record.task);
  const taskError = sanitizeCreationDraftError(record.taskError, task.revision);

  return {
    ...(research ? { research } : {}),
    task,
    ...(taskError ? { taskError } : {}),
  };
}

export function mergeCreationDraftsByRevision(
  persistedDrafts: HydratedCreationDrafts,
  inMemoryDrafts: HydratedCreationDrafts,
): HydratedCreationDrafts {
  const taskCreationDraft =
    inMemoryDrafts.taskCreationDraft.revision > persistedDrafts.taskCreationDraft.revision
      ? inMemoryDrafts.taskCreationDraft
      : persistedDrafts.taskCreationDraft;
  const taskCreationError =
    taskCreationDraft === inMemoryDrafts.taskCreationDraft
      ? inMemoryDrafts.taskCreationError
      : persistedDrafts.taskCreationError;
  return {
    taskCreationDraft,
    taskCreationError:
      taskCreationError?.revision === taskCreationDraft.revision ? taskCreationError : null,
  };
}

function sanitizeTaskCreationDraft(value: unknown): TaskCreationDraft {
  const fallback = createEmptyTaskCreationDraft();
  if (!isRecord(value)) return fallback;
  const revision = nonnegativeInteger(value.revision) ?? fallback.revision;
  const workItems = Array.isArray(value.workItems)
    ? value.workItems
        .slice(0, MAX_TASK_WORK_ITEMS)
        .map(sanitizeTaskCreationDraftWorkItem)
        .filter((item): item is TaskCreationDraftWorkItem => item !== null)
    : [];
  return {
    revision,
    updatedAt: validIso(value.updatedAt) ?? fallback.updatedAt,
    idempotencyKey: nonemptyString(value.idempotencyKey) ?? fallback.idempotencyKey,
    workspaceId: draftString(value.workspaceId),
    title: draftString(value.title),
    objective: draftString(value.objective),
    context: draftString(value.context),
    requirements: draftString(value.requirements),
    constraints: draftString(value.constraints),
    acceptanceCriteria: draftString(value.acceptanceCriteria),
    decisions: draftString(value.decisions),
    reviewRequired: typeof value.reviewRequired === "boolean" ? value.reviewRequired : true,
    workItems: workItems.length > 0 ? workItems : fallback.workItems,
    workGraphCustomized:
      typeof value.workGraphCustomized === "boolean" ? value.workGraphCustomized : false,
    showAdvancedWorkGraph:
      typeof value.showAdvancedWorkGraph === "boolean" ? value.showAdvancedWorkGraph : false,
  };
}

function sanitizeTaskCreationDraftWorkItem(value: unknown): TaskCreationDraftWorkItem | null {
  if (!isRecord(value)) return null;
  const id = nonemptyString(value.id);
  const key = nonemptyString(value.key);
  if (!id || !key) return null;
  return {
    id,
    key,
    title: draftString(value.title),
    description: draftString(value.description),
    dependencies: draftString(value.dependencies),
    expectedOutputs: draftString(value.expectedOutputs),
  };
}

function sanitizeCreationDraftError(
  value: unknown,
  currentRevision: number,
): CreationDraftError | null {
  if (!isRecord(value)) return null;
  const revision = nonnegativeInteger(value.revision);
  const message = nonemptyString(value.message);
  if (revision !== currentRevision || !message) return null;
  return { revision, message };
}

function sanitizeLegacyResearchCreationDraft(value: unknown): PersistedComposerDraft | null {
  const key = composerDraftKeyForNewChatTarget({ kind: "oneOff" });
  const draft = sanitizePersistedComposerDrafts({ [key]: value })[key];
  return draft && hasPersistedComposerDraftState(draft) ? draft : null;
}

function hasPersistedComposerDraftState(draft: PersistedComposerDraft): boolean {
  return Boolean(
    draft.text ||
      draft.attachments.length > 0 ||
      draft.references.length > 0 ||
      draft.provider ||
      draft.model ||
      draft.reasoningEffort,
  );
}

function draftString(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_DRAFT_STRING_LENGTH) : "";
}

function nonemptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_DRAFT_STRING_LENGTH) : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function validIso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
