import type { AgentSession } from "../session/AgentSession";
import type { SessionBinding, SessionEventSink } from "../startServer/types";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class SessionRegistry {
  readonly bindings = new Map<string, SessionBinding>();
  private readonly idleSince = new Map<string, number>();

  addBinding(sessionId: string, binding: SessionBinding): void {
    this.bindings.set(sessionId, binding);
  }

  getBinding(sessionId: string): SessionBinding | undefined {
    return this.bindings.get(sessionId);
  }

  getSession(sessionId: string): AgentSession | null {
    return this.bindings.get(sessionId)?.session ?? null;
  }

  listBindings(): IterableIterator<SessionBinding> {
    return this.bindings.values();
  }

  listRootSessions(options: { cwd?: string } = {}): AgentSession[] {
    return [...this.bindings.values()]
      .flatMap((binding) => (binding.session ? [binding.session] : []))
      .filter(
        (session) =>
          session.sessionKind === "root" &&
          (!options.cwd || session.getWorkingDirectory() === options.cwd),
      );
  }

  addSink(binding: SessionBinding, sinkId: string, sink: SessionEventSink): void {
    binding.sinks.set(sinkId, sink);
    if (binding.session && !sinkId.startsWith("journal:")) {
      this.idleSince.delete(binding.session.id);
    }
  }

  removeSink(binding: SessionBinding, sinkId: string): void {
    binding.sinks.delete(sinkId);
    if (binding.session && binding.sinks.size === 0) {
      this.idleSince.set(binding.session.id, Date.now());
    }
  }

  countLiveConnectionSinks(binding: SessionBinding): number {
    return [...binding.sinks.keys()].filter((sinkId) => !sinkId.startsWith("journal:")).length;
  }

  disposeBinding(binding: SessionBinding, reason: string): void {
    if (!binding.session) return;
    try {
      binding.session.cancel();
    } catch {
      // ignore
    }
    try {
      binding.session.dispose(reason);
    } catch {
      // ignore
    }
    try {
      binding.socket?.close();
    } catch {
      // ignore
    }
  }

  removeBinding(sessionId: string): void {
    this.bindings.delete(sessionId);
    this.idleSince.delete(sessionId);
  }

  removeBindingForDeletedSession(sessionId: string, deletedSessionId: string): void {
    const binding = this.bindings.get(sessionId);
    if (!binding?.session) return;
    this.disposeBinding(binding, `session ${deletedSessionId} deleted`);
    this.removeBinding(sessionId);
  }

  getLiveSessionSnapshot(
    sessionId: string,
  ): ReturnType<AgentSession["peekSessionSnapshot"]> | null {
    return this.getSession(sessionId)?.peekSessionSnapshot() ?? null;
  }

  getLiveSessionWorkingDirectory(sessionId: string): string | null {
    return this.getSession(sessionId)?.getWorkingDirectory() ?? null;
  }

  findBusyWorkspaceSession(workingDirectory: string): AgentSession | null {
    return (
      [...this.bindings.values()]
        .map((candidate) => candidate.session)
        .find(
          (candidate): candidate is AgentSession =>
            !!candidate && candidate.getWorkingDirectory() === workingDirectory && candidate.isBusy,
        ) ?? null
    );
  }

  evictIdleBindings(now = Date.now()): void {
    for (const [sessionId, binding] of this.bindings) {
      if (binding.session && binding.sinks.size === 0 && !binding.session.isBusy) {
        const idleSince = this.idleSince.get(sessionId) ?? 0;
        if (idleSince > 0 && now - idleSince > IDLE_TIMEOUT_MS) {
          binding.session.dispose("idle eviction");
          this.removeBinding(sessionId);
        }
      }
    }
  }

  async disposeAll(reason: string): Promise<void> {
    const persistenceFlushes: Promise<void>[] = [];
    for (const [id, binding] of this.bindings) {
      if (!binding.session) {
        this.removeBinding(id);
        continue;
      }
      try {
        binding.session.dispose(reason);
      } catch {
        // ignore
      }
      try {
        persistenceFlushes.push(binding.session.waitForPersistenceIdle());
      } catch {
        // ignore
      }
      try {
        binding.socket?.close();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.allSettled(persistenceFlushes);
    this.bindings.clear();
    this.idleSince.clear();
  }
}
