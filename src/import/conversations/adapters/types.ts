import type {
  ConversationDiscoverOptions,
  ConversationImportSource,
  ConversationPreviewOptions,
  ConversationSourceCandidate,
  ExternalConversation,
} from "../types";

export type ConversationSourceAdapter = {
  source: ConversationImportSource;
  discover(opts: ConversationDiscoverOptions): Promise<ConversationSourceCandidate[]>;
  preview(
    candidate: ConversationSourceCandidate,
    opts: ConversationPreviewOptions,
  ): Promise<ExternalConversation[]>;
};
