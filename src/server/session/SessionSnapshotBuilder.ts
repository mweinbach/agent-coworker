import type { HarnessContextStore } from "../../harness/contextStore";
import type { PersistedSessionMutation } from "../sessionDb";
import type { PersistedSessionSnapshot } from "../sessionStore";
import type { SessionRuntimeState } from "./SessionContext";

export class SessionSnapshotBuilder {
  constructor(
    private readonly opts: {
      sessionId: string;
      state: SessionRuntimeState;
      harnessContextStore: HarnessContextStore;
      getEnableMcp: () => boolean;
      hasPendingAsk: () => boolean;
      hasPendingApproval: () => boolean;
    }
  ) {}

  buildPersistedSnapshotAt(updatedAt: string): PersistedSessionSnapshot {
    return {
      version: 1,
      sessionId: this.opts.sessionId,
      createdAt: this.opts.state.sessionInfo.createdAt,
      updatedAt,
      session: {
        title: this.opts.state.sessionInfo.title,
        titleSource: this.opts.state.sessionInfo.titleSource,
        titleModel: this.opts.state.sessionInfo.titleModel,
        provider: this.opts.state.sessionInfo.provider,
        model: this.opts.state.sessionInfo.model,
      },
      config: {
        provider: this.opts.state.config.provider,
        model: this.opts.state.config.model,
        enableMcp: this.opts.getEnableMcp(),
        workingDirectory: this.opts.state.config.workingDirectory,
        ...(this.opts.state.config.outputDirectory ? { outputDirectory: this.opts.state.config.outputDirectory } : {}),
        ...(this.opts.state.config.uploadsDirectory ? { uploadsDirectory: this.opts.state.config.uploadsDirectory } : {}),
      },
      context: {
        system: this.opts.state.system,
        messages: this.opts.state.allMessages,
        todos: this.opts.state.todos,
        harnessContext: this.opts.harnessContextStore.get(this.opts.sessionId),
      },
    };
  }

  buildCanonicalSnapshot(updatedAt: string): PersistedSessionMutation["snapshot"] {
    return {
      title: this.opts.state.sessionInfo.title,
      titleSource: this.opts.state.sessionInfo.titleSource,
      titleModel: this.opts.state.sessionInfo.titleModel,
      provider: this.opts.state.config.provider,
      model: this.opts.state.config.model,
      workingDirectory: this.opts.state.config.workingDirectory,
      ...(this.opts.state.config.outputDirectory ? { outputDirectory: this.opts.state.config.outputDirectory } : {}),
      ...(this.opts.state.config.uploadsDirectory ? { uploadsDirectory: this.opts.state.config.uploadsDirectory } : {}),
      enableMcp: this.opts.getEnableMcp(),
      createdAt: this.opts.state.sessionInfo.createdAt,
      updatedAt,
      status: this.opts.state.persistenceStatus,
      hasPendingAsk: this.opts.hasPendingAsk(),
      hasPendingApproval: this.opts.hasPendingApproval(),
      systemPrompt: this.opts.state.system,
      messages: this.opts.state.allMessages,
      todos: this.opts.state.todos,
      harnessContext: this.opts.harnessContextStore.get(this.opts.sessionId),
    };
  }
}
