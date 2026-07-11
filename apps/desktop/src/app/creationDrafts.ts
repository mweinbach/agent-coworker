import {
  type ComposerDraft,
  createEmptyComposerDraft,
  hydrateComposerDrafts,
  type PersistedComposerDraft,
  serializeComposerDrafts,
} from "./composerDrafts";

const RESEARCH_DRAFT_KEY = "research:new";
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
  researchError?: CreationDraftError;
  task?: TaskCreationDraft;
  taskError?: CreationDraftError;
};

export type HydratedCreationDrafts = {
  researchCreationDraft: ComposerDraft;
  researchCreationError: CreationDraftError | null;
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
    researchCreationDraft: createEmptyComposerDraft(),
    researchCreationError: null,
    taskCreationDraft: createEmptyTaskCreationDraft(),
    taskCreationError: null,
  };
}

export function serializeCreationDrafts(
  state: Partial<HydratedCreationDrafts>,
): PersistedCreationDrafts {
  const researchDraft = state.researchCreationDraft ?? createEmptyComposerDraft();
  const taskDraft = state.taskCreationDraft ?? createEmptyTaskCreationDraft();
  const research = serializeComposerDrafts({
    [RESEARCH_DRAFT_KEY]: researchDraft,
  })[RESEARCH_DRAFT_KEY];
  const researchError =
    state.researchCreationError?.revision === researchDraft.revision
      ? state.researchCreationError
      : null;
  const taskError =
    state.taskCreationError?.revision === taskDraft.revision ? state.taskCreationError : null;
  return {
    ...(research ? { research } : {}),
    ...(researchError ? { researchError } : {}),
    task: taskDraft,
    ...(taskError ? { taskError } : {}),
  };
}

export function hydrateCreationDrafts(value: unknown): HydratedCreationDrafts {
  const record = isRecord(value) ? value : {};
  const researchCreationDraft =
    hydrateComposerDrafts({ [RESEARCH_DRAFT_KEY]: record.research })[RESEARCH_DRAFT_KEY] ??
    createEmptyComposerDraft();
  const taskCreationDraft = sanitizeTaskCreationDraft(record.task);
  const researchCreationError = sanitizeCreationDraftError(
    record.researchError,
    researchCreationDraft.revision,
  );
  const taskCreationError = sanitizeCreationDraftError(
    record.taskError,
    taskCreationDraft.revision,
  );
  return {
    researchCreationDraft,
    researchCreationError,
    taskCreationDraft,
    taskCreationError,
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
