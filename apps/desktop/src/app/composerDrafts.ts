import {
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE,
} from "../../../../src/shared/attachments";
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
export const MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT = MAX_TURN_ATTACHMENT_COUNT;
export const MAX_COMPOSER_DRAFT_ATTACHMENT_BYTE_SIZE = MAX_ATTACHMENT_INLINE_BYTE_SIZE;
export const MAX_COMPOSER_DRAFT_TOTAL_ATTACHMENT_BYTES = MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE;
export const MAX_PERSISTED_COMPOSER_DRAFT_ATTACHMENT_BYTES =
  MAX_TURN_ATTACHMENT_TOTAL_INLINE_BYTE_SIZE;

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

export type ComposerDraftRevisionFloor = {
  revision: number;
  generation: number;
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
  protectedKeys?: ReadonlySet<string>;
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

export function getComposerDraftAttachmentValidationMessage(
  drafts: ComposerDraftsByKey,
  ownerKey: string,
  selectedFiles: readonly Pick<File, "size">[],
): string | null {
  const currentAttachments = drafts[ownerKey]?.attachments ?? [];
  const totalCount = currentAttachments.length + selectedFiles.length;
  if (totalCount > MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT) {
    return `Too many file attachments (max ${MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT})`;
  }

  const selectedBytes = sumAttachmentBytes(selectedFiles);
  if (!Number.isFinite(selectedBytes)) {
    return "File attachment size is invalid";
  }
  if (selectedFiles.some((file) => file.size > MAX_COMPOSER_DRAFT_ATTACHMENT_BYTE_SIZE)) {
    return "File too large to save in a draft (max 25MB)";
  }

  const currentDraftBytes = sumAttachmentBytes(currentAttachments);
  if (
    !Number.isFinite(currentDraftBytes) ||
    currentDraftBytes + selectedBytes > MAX_COMPOSER_DRAFT_TOTAL_ATTACHMENT_BYTES
  ) {
    return "Draft attachments too large in total (max 25MB combined)";
  }

  const persistedBytes = Object.values(drafts).reduce(
    (total, draft) => total + sumAttachmentBytes(draft.attachments),
    0,
  );
  if (
    !Number.isFinite(persistedBytes) ||
    persistedBytes + selectedBytes > MAX_PERSISTED_COMPOSER_DRAFT_ATTACHMENT_BYTES
  ) {
    return "Saved draft attachments too large in total (max 25MB across chats)";
  }
  return null;
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
  let persistedAttachmentBytes = 0;
  const candidates = Object.entries(value)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .sort(([leftKey, left], [rightKey, right]) => {
      const updatedAtDelta = persistedDraftUpdatedAtMs(right) - persistedDraftUpdatedAtMs(left);
      return updatedAtDelta || leftKey.localeCompare(rightKey);
    });
  for (const [key, candidate] of candidates) {
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
    const attachments: PersistedComposerDraftAttachment[] = [];
    let draftAttachmentBytes = 0;
    if (Array.isArray(candidate.attachments)) {
      for (const attachment of candidate.attachments) {
        if (attachments.length >= MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT) break;
        const declaredSize = persistedAttachmentDeclaredSize(attachment);
        if (declaredSize === null) continue;
        if (
          draftAttachmentBytes + declaredSize > MAX_COMPOSER_DRAFT_TOTAL_ATTACHMENT_BYTES ||
          persistedAttachmentBytes + declaredSize > MAX_PERSISTED_COMPOSER_DRAFT_ATTACHMENT_BYTES
        ) {
          continue;
        }
        const normalized = sanitizePersistedComposerDraftAttachment(attachment);
        if (!normalized) continue;
        attachments.push(normalized);
        draftAttachmentBytes += declaredSize;
        persistedAttachmentBytes += declaredSize;
      }
    }
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
  const protectedEntries = Object.entries(drafts).filter(
    ([key]) => options.protectedKeys?.has(key) === true && isValidComposerDraftKey(key, options),
  );
  const eligible = Object.entries(drafts)
    .filter(([key, draft]) => {
      if (!isValidComposerDraftKey(key, options)) return false;
      if (options.protectedKeys?.has(key) === true) return false;
      if (!hasComposerDraftState(draft)) return false;
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
    });
  const retainedDrafts: Array<[string, ComposerDraft]> = [];
  let persistedAttachmentBytes = protectedEntries.reduce(
    (total, [, draft]) => total + validatedDraftAttachmentBytes(draft),
    0,
  );
  for (const entry of eligible) {
    if (retainedDrafts.length >= Math.max(0, maxDrafts)) break;
    const draftAttachmentBytes = validatedDraftAttachmentBytes(entry[1]);
    if (
      !Number.isFinite(draftAttachmentBytes) ||
      persistedAttachmentBytes + draftAttachmentBytes >
        MAX_PERSISTED_COMPOSER_DRAFT_ATTACHMENT_BYTES
    ) {
      continue;
    }
    retainedDrafts.push(entry);
    persistedAttachmentBytes += draftAttachmentBytes;
  }
  const next = Object.fromEntries([...protectedEntries, ...retainedDrafts]);
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
    value.size > MAX_COMPOSER_DRAFT_ATTACHMENT_BYTE_SIZE ||
    typeof value.lastModified !== "number" ||
    !Number.isFinite(value.lastModified) ||
    typeof value.signature !== "string" ||
    typeof value.contentBase64 !== "string" ||
    value.contentBase64.length > MAX_ATTACHMENT_BASE64_SIZE
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
    value.size > MAX_COMPOSER_DRAFT_ATTACHMENT_BYTE_SIZE ||
    typeof value.lastModified !== "number" ||
    !Number.isFinite(value.lastModified) ||
    typeof value.signature !== "string" ||
    typeof value.contentBase64 !== "string" ||
    value.contentBase64.length > MAX_ATTACHMENT_BASE64_SIZE
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

function persistedAttachmentDeclaredSize(value: unknown): number | null {
  if (
    !isRecord(value) ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    value.size > MAX_COMPOSER_DRAFT_ATTACHMENT_BYTE_SIZE ||
    typeof value.contentBase64 !== "string" ||
    value.contentBase64.length > MAX_ATTACHMENT_BASE64_SIZE
  ) {
    return null;
  }
  return value.size;
}

function persistedDraftUpdatedAtMs(value: Record<string, unknown>): number {
  if (typeof value.updatedAt !== "string") return 0;
  const updatedAtMs = Date.parse(value.updatedAt);
  return Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
}

function sumAttachmentBytes(attachments: readonly Pick<{ size: number }, "size">[]): number {
  let total = 0;
  for (const attachment of attachments) {
    if (!Number.isFinite(attachment.size) || attachment.size < 0) return Number.POSITIVE_INFINITY;
    total += attachment.size;
    if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY;
  }
  return total;
}

function validatedDraftAttachmentBytes(draft: ComposerDraft): number {
  if (draft.attachments.length > MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT) {
    return Number.POSITIVE_INFINITY;
  }
  if (
    draft.attachments.some(
      (attachment) => attachment.size > MAX_COMPOSER_DRAFT_ATTACHMENT_BYTE_SIZE,
    )
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const total = sumAttachmentBytes(draft.attachments);
  return total <= MAX_COMPOSER_DRAFT_TOTAL_ATTACHMENT_BYTES ? total : Number.POSITIVE_INFINITY;
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
