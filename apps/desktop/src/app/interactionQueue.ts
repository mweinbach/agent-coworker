import type { ChatInteraction } from "./types";

function isInteractionOutstanding(interaction: ChatInteraction): boolean {
  return interaction.status !== "resolved";
}

export function outstandingInteractions(
  interactions: readonly ChatInteraction[] | undefined,
): ChatInteraction[] {
  return interactions?.filter(isInteractionOutstanding) ?? [];
}

export function countOutstandingInteractions(
  interactions: readonly ChatInteraction[] | undefined,
): number {
  if (!interactions) return 0;
  let count = 0;
  for (const interaction of interactions) {
    if (isInteractionOutstanding(interaction)) count += 1;
  }
  return count;
}

export function countAllOutstandingInteractions(
  interactionsByThread: Readonly<Record<string, readonly ChatInteraction[]>>,
): number {
  return Object.values(interactionsByThread).reduce(
    (total, interactions) => total + countOutstandingInteractions(interactions),
    0,
  );
}

function firstOutstandingInteractionSequence(interactions: readonly ChatInteraction[]): number {
  let first: ChatInteraction | null = null;
  for (const interaction of interactions) {
    if (
      isInteractionOutstanding(interaction) &&
      (!first || interaction.receivedSequence < first.receivedSequence)
    ) {
      first = interaction;
    }
  }
  return first?.receivedSequence ?? Number.POSITIVE_INFINITY;
}

function orderedInteractionThreadIds(
  interactionsByThread: Readonly<Record<string, readonly ChatInteraction[]>>,
): string[] {
  return Object.entries(interactionsByThread)
    .map(([threadId, interactions]) => ({
      threadId,
      firstSequence: firstOutstandingInteractionSequence(interactions),
    }))
    .filter((entry) => Number.isFinite(entry.firstSequence))
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map((entry) => entry.threadId);
}

export function nextInteractionThreadId(
  interactionsByThread: Readonly<Record<string, readonly ChatInteraction[]>>,
  selectedThreadId: string | null,
): string | null {
  const threadIds = orderedInteractionThreadIds(interactionsByThread);
  if (threadIds.length === 0) return null;
  const selectedIndex = selectedThreadId ? threadIds.indexOf(selectedThreadId) : -1;
  return threadIds[(selectedIndex + 1) % threadIds.length] ?? null;
}
