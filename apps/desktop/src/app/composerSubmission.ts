import type { PreparedComposerMessage } from "../lib/composerAttachments";
import type { NewChatLandingTarget } from "../lib/newChatLanding";
import type { ProviderName } from "../lib/wsProtocol";
import type { ComposerDraft, ComposerDraftRevision } from "./composerDrafts";
import { resolveActiveComposerDraftKey } from "./composerDrafts";
import type { ReasoningEffortValue } from "./openaiCompatibleProviderOptions";

export type ComposerSubmissionRequest =
  | {
      kind: "thread";
      threadId: string;
    }
  | {
      kind: "newChat";
      target: NewChatLandingTarget;
      provider: ProviderName;
      model: string;
      reasoningEffort: ReasoningEffortValue | null;
    };

export type ComposerSubmissionPhase = "preparing" | "sending" | "accepted" | "failed";
export type ComposerSubmissionDelivery = "send" | "steer";

export type ComposerSubmission = {
  id: string;
  clientMessageId: string;
  owner: ComposerDraftRevision;
  request: ComposerSubmissionRequest;
  draft: ComposerDraft;
  prepared: PreparedComposerMessage | null;
  phase: ComposerSubmissionPhase;
  delivery: ComposerSubmissionDelivery;
  error: string | null;
};

export type ComposerSubmissionsByKey = Record<string, ComposerSubmission>;

export function findComposerSubmissionById(
  submissions: ComposerSubmissionsByKey,
  submissionId: string,
): ComposerSubmission | null {
  return Object.values(submissions).find((submission) => submission.id === submissionId) ?? null;
}

export function cloneComposerDraftForSubmission(draft: ComposerDraft): ComposerDraft {
  return {
    ...draft,
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
    references: draft.references.map((reference) => ({ ...reference })),
  };
}

export function selectActiveComposerSubmission(state: {
  selectedThreadId: string | null;
  newChatLandingTarget: NewChatLandingTarget | null;
  workspaces: Parameters<typeof resolveActiveComposerDraftKey>[0]["workspaces"];
  selectedWorkspaceId: string | null;
  composerSubmissionsByKey: ComposerSubmissionsByKey;
}): ComposerSubmission | null {
  return state.composerSubmissionsByKey[resolveActiveComposerDraftKey(state)] ?? null;
}

export function isComposerSubmissionInFlight(
  submission: ComposerSubmission | null | undefined,
): boolean {
  return submission?.phase === "preparing" || submission?.phase === "sending";
}

export function composerSubmissionErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.trim() || "The message could not be sent.";
}
