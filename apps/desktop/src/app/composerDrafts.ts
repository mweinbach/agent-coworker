import { type NewChatLandingTarget, resolveNewChatLandingTarget } from "../lib/newChatLanding";
import type { TurnReference } from "../lib/wsProtocol";
import { PROVIDER_NAMES, type ProviderName } from "../lib/wsProtocol";
import type { ReasoningEffortValue } from "./openaiCompatibleProviderOptions";
import type { WorkspaceRecord } from "./types";

const BASE64_BINARY_CHUNK_SIZE = 0x8000;
const COMPOSER_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const REASONING_EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "dynamic",
]);

export const MAX_COMPOSER_DRAFTS = 50;

export type ComposerDraftAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  lastModified: number;
  file: File;
  previewUrl?: string;
  signature: string;
  contentBase64: string;
};

export type ComposerDraft = {
  revision: number;
  generation: number;
  updatedAt: string;
  text: string;
  attachments: ComposerDraftAttachment[];
  references: TurnReference[];
  provider: ProviderName | null;
  model: string | null;
  reasoningEffort: ReasoningEffortValue | null;
};

export type ComposerDraftsByKey = Record<string, ComposerDraft>;

export type ComposerDraftRevision = {
  key: string;
  revision: number;
};

export type PersistedComposerDraftAttachment = Omit<ComposerDraftAttachment, "file" | "previewUrl">;

export type PersistedComposerDraft = Omit<ComposerDraft, "attachments"> & {
  attachments: PersistedComposerDraftAttachment[];
};

export type PersistedComposerDrafts = Record<string, PersistedComposerDraft>;

export const EMPTY_COMPOSER_DRAFT: Readonly<ComposerDraft> = Object.freeze(
  createEmptyComposerDraft(new Date(0).toISOString()),
);

type ObjectUrlOptions = {
  createObjectURL?: (blob: Blob) => string;
};

type PruneComposerDraftOptions = {
  nowMs?: number;
  validThreadIds: ReadonlySet<string>;
  validProjectWorkspaceIds: ReadonlySet<string>;
  activeKey?: string | null;
  maxDrafts?: number;
  maxAgeMs?: number;
};

export function composerDraftKeyForThread(threadId: string): string {
  return `thread:${threadId}`;
}

export function composerDraftKeyForNewChatTarget(target: NewChatLandingTarget): string {
  return target.kind === "oneOff" ? "new:oneOff" : `new:project:${target.workspaceId}`;
}

export function resolveActiveComposerDraftKey(state: {
  selectedThreadId: string | null;
  newChatLandingTarget: NewChatLandingTarget | null;
  workspaces: WorkspaceRecord[];
  selectedWorkspaceId: string | null;
}): string {
  if (state.selectedThreadId) return composerDraftKeyForThread(state.selectedThreadId);
  return composerDraftKeyForNewChatTarget(
    resolveNewChatLandingTarget(
      state.newChatLandingTarget,
      state.workspaces,
      state.selectedWorkspaceId,
    ),
  );
}

export function selectActiveComposerDraft(state: {
  selectedThreadId: string | null;
  newChatLandingTarget: NewChatLandingTarget | null;
  workspaces: WorkspaceRecord[];
  selectedWorkspaceId: string | null;
  composerDraftsByKey: ComposerDraftsByKey;
}): Readonly<ComposerDraft> {
  return state.composerDraftsByKey[resolveActiveComposerDraftKey(state)] ?? EMPTY_COMPOSER_DRAFT;
}

export function createEmptyComposerDraft(updatedAt = new Date().toISOString()): ComposerDraft {
  return {
    revision: 0,
    generation: 0,
    updatedAt,
    text: "",
    attachments: [],
    references: [],
    provider: null,
    model: null,
    reasoningEffort: null,
  };
}

export async function createComposerDraftAttachment(
  file: File,
  options: ObjectUrlOptions = {},
): Promise<ComposerDraftAttachment> {
  const contentBase64 = encodeArrayBufferToBase64(await file.arrayBuffer());
  const createObjectURL = options.createObjectURL ?? defaultCreateObjectURL;
  const previewUrl =
    file.type.startsWith("image/") && file instanceof Blob ? createObjectURL(file) : undefined;
  return {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified,
    file,
    previewUrl,
    signature: `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`,
    contentBase64,
  };
}

export function serializeComposerDrafts(drafts: ComposerDraftsByKey): PersistedComposerDrafts {
  return Object.fromEntries(
    Object.entries(drafts)
      .filter(([, draft]) => hasComposerDraftState(draft))
      .map(([key, draft]) => [
        key,
        {
          revision: draft.revision,
          generation: draft.generation,
          updatedAt: draft.updatedAt,
          text: draft.text,
          attachments: draft.attachments.map(
            ({ filename, mimeType, size, lastModified, signature, contentBase64 }) => ({
              filename,
              mimeType,
              size,
              lastModified,
              signature,
              contentBase64,
            }),
          ),
          references: draft.references.map((reference) => ({ ...reference })),
          provider: draft.provider,
          model: draft.model,
          reasoningEffort: draft.reasoningEffort,
        },
      ]),
  );
}

export function sanitizePersistedComposerDrafts(value: unknown): PersistedComposerDrafts {
  if (!isRecord(value)) return {};
  const drafts: PersistedComposerDrafts = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    const revision =
      typeof candidate.revision === "number" &&
      Number.isInteger(candidate.revision) &&
      candidate.revision >= 0
        ? candidate.revision
        : 0;
    const generation =
      typeof candidate.generation === "number" &&
      Number.isInteger(candidate.generation) &&
      candidate.generation >= 0
        ? candidate.generation
        : 0;
    const updatedAt =
      typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
        ? candidate.updatedAt
        : new Date(0).toISOString();
    const attachments = Array.isArray(candidate.attachments)
      ? candidate.attachments.flatMap((attachment) => {
          const normalized = sanitizePersistedComposerDraftAttachment(attachment);
          return normalized ? [normalized] : [];
        })
      : [];
    drafts[key] = {
      revision,
      generation,
      updatedAt,
      text: typeof candidate.text === "string" ? candidate.text : "",
      attachments,
      references: hydrateReferences(candidate.references),
      provider: isProviderName(candidate.provider) ? candidate.provider : null,
      model:
        typeof candidate.model === "string" && candidate.model.trim()
          ? candidate.model.trim()
          : null,
      reasoningEffort: isReasoningEffortValue(candidate.reasoningEffort)
        ? candidate.reasoningEffort
        : null,
    };
  }
  return drafts;
}

export function hydrateComposerDrafts(
  value: unknown,
  options: ObjectUrlOptions = {},
): ComposerDraftsByKey {
  const drafts: ComposerDraftsByKey = {};
  for (const [key, candidate] of Object.entries(sanitizePersistedComposerDrafts(value))) {
    const draft = hydrateComposerDraft(candidate, options);
    if (draft) drafts[key] = draft;
  }
  return drafts;
}

export function clearComposerDraftRevision(
  drafts: ComposerDraftsByKey,
  owner: ComposerDraftRevision,
): {
  drafts: ComposerDraftsByKey;
  cleared: boolean;
  removedAttachments: ComposerDraftAttachment[];
} {
  const current = drafts[owner.key];
  if (!current || current.revision !== owner.revision) {
    return { drafts, cleared: false, removedAttachments: [] };
  }
  const next = { ...drafts };
  next[owner.key] = {
    ...createEmptyComposerDraft(current.updatedAt),
    revision: current.revision + 1,
    generation: current.generation + 1,
  };
  return {
    drafts: next,
    cleared: true,
    removedAttachments: current.attachments,
  };
}

export function pruneComposerDrafts(
  drafts: ComposerDraftsByKey,
  options: PruneComposerDraftOptions,
): {
  drafts: ComposerDraftsByKey;
  removedKeys: string[];
  removedAttachments: ComposerDraftAttachment[];
} {
  const nowMs = options.nowMs ?? Date.now();
  const maxDrafts = options.maxDrafts ?? MAX_COMPOSER_DRAFTS;
  const maxAgeMs = options.maxAgeMs ?? COMPOSER_DRAFT_MAX_AGE_MS;
  const eligible = Object.entries(drafts)
    .filter(([key, draft]) => {
      if (!isValidComposerDraftKey(key, options)) return false;
      if (key === options.activeKey) return true;
      const updatedAtMs = Date.parse(draft.updatedAt);
      return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= maxAgeMs;
    })
    .sort(([leftKey, left], [rightKey, right]) => {
      if (leftKey === options.activeKey) return -1;
      if (rightKey === options.activeKey) return 1;
      return (
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || leftKey.localeCompare(rightKey)
      );
    })
    .slice(0, Math.max(0, maxDrafts));
  const next = Object.fromEntries(eligible);
  const retainedKeys = new Set(Object.keys(next));
  const removedKeys = Object.keys(drafts).filter((key) => !retainedKeys.has(key));
  return {
    drafts: next,
    removedKeys,
    removedAttachments: removedKeys.flatMap((key) => drafts[key]?.attachments ?? []),
  };
}

export function revokeComposerDraftAttachmentPreviews(
  attachments: readonly ComposerDraftAttachment[],
  revokeObjectURL: (url: string) => void = defaultRevokeObjectURL,
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) revokeObjectURL(attachment.previewUrl);
  }
}

export function hasComposerDraftContent(draft: ComposerDraft | undefined): boolean {
  return Boolean(draft && (draft.text.length > 0 || draft.attachments.length > 0));
}

function hasComposerDraftState(draft: ComposerDraft): boolean {
  return Boolean(
    hasComposerDraftContent(draft) ||
      draft.references.length > 0 ||
      draft.provider ||
      draft.model ||
      draft.reasoningEffort,
  );
}

function hydrateComposerDraft(value: unknown, options: ObjectUrlOptions): ComposerDraft | null {
  if (!isRecord(value)) return null;
  const revision =
    typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0
      ? value.revision
      : 0;
  const generation =
    typeof value.generation === "number" &&
    Number.isInteger(value.generation) &&
    value.generation >= 0
      ? value.generation
      : 0;
  const updatedAt =
    typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
      ? value.updatedAt
      : new Date(0).toISOString();
  const text = typeof value.text === "string" ? value.text : "";
  const references = hydrateReferences(value.references);
  const provider = isProviderName(value.provider) ? value.provider : null;
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : null;
  const reasoningEffort = isReasoningEffortValue(value.reasoningEffort)
    ? value.reasoningEffort
    : null;
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.flatMap((attachment) => {
        const hydrated = hydrateComposerDraftAttachment(attachment, options);
        return hydrated ? [hydrated] : [];
      })
    : [];
  return {
    revision,
    generation,
    updatedAt,
    text,
    attachments,
    references,
    provider,
    model,
    reasoningEffort,
  };
}

function hydrateComposerDraftAttachment(
  value: unknown,
  options: ObjectUrlOptions,
): ComposerDraftAttachment | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.filename !== "string" ||
    !value.filename ||
    typeof value.mimeType !== "string" ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.lastModified !== "number" ||
    !Number.isFinite(value.lastModified) ||
    typeof value.signature !== "string" ||
    typeof value.contentBase64 !== "string"
  ) {
    return null;
  }
  try {
    const bytes = decodeBase64(value.contentBase64);
    if (bytes.byteLength !== value.size) return null;
    const file = new File([bytes], value.filename, {
      type: value.mimeType,
      lastModified: value.lastModified,
    });
    const createObjectURL = options.createObjectURL ?? defaultCreateObjectURL;
    const previewUrl = value.mimeType.startsWith("image/") ? createObjectURL(file) : undefined;
    return {
      filename: value.filename,
      mimeType: value.mimeType,
      size: value.size,
      lastModified: value.lastModified,
      file,
      previewUrl,
      signature: value.signature,
      contentBase64: value.contentBase64,
    };
  } catch {
    return null;
  }
}

function sanitizePersistedComposerDraftAttachment(
  value: unknown,
): PersistedComposerDraftAttachment | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.filename !== "string" ||
    !value.filename ||
    typeof value.mimeType !== "string" ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.lastModified !== "number" ||
    !Number.isFinite(value.lastModified) ||
    typeof value.signature !== "string" ||
    typeof value.contentBase64 !== "string"
  ) {
    return null;
  }
  try {
    if (decodeBase64(value.contentBase64).byteLength !== value.size) return null;
  } catch {
    return null;
  }
  return {
    filename: value.filename,
    mimeType: value.mimeType,
    size: value.size,
    lastModified: value.lastModified,
    signature: value.signature,
    contentBase64: value.contentBase64,
  };
}

function hydrateReferences(value: unknown): TurnReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      (candidate.kind !== "skill" && candidate.kind !== "plugin") ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim()
    ) {
      return [];
    }
    return [{ kind: candidate.kind, name: candidate.name.trim() }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidComposerDraftKey(
  key: string,
  options: Pick<PruneComposerDraftOptions, "validThreadIds" | "validProjectWorkspaceIds">,
): boolean {
  if (key === "new:oneOff") return true;
  if (key.startsWith("thread:")) {
    return options.validThreadIds.has(key.slice("thread:".length));
  }
  if (key.startsWith("new:project:")) {
    return options.validProjectWorkspaceIds.has(key.slice("new:project:".length));
  }
  return false;
}

function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}

function isReasoningEffortValue(value: unknown): value is ReasoningEffortValue {
  return typeof value === "string" && REASONING_EFFORT_VALUES.has(value);
}

function encodeArrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += BASE64_BINARY_CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + BASE64_BINARY_CHUNK_SIZE)));
  }
  return btoa(chunks.join(""));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function defaultCreateObjectURL(blob: Blob): string {
  return typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : "";
}

function defaultRevokeObjectURL(url: string): void {
  if (url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}
