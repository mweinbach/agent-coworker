import type {
  CreateThreadInput,
  ForkThreadInput,
  HandoffStatusInput,
  HandoffThreadInput,
  ListThreadsInput,
  ReadThreadInput,
  SendMessageToThreadInput,
  SetThreadArchivedInput,
  SetThreadPinnedInput,
  SetThreadTitleInput,
  ThreadControl,
  ThreadHostAdapter,
  ThreadHostId,
} from "./types";

export class ThreadManagementService {
  private readonly hosts = new Map<ThreadHostId, ThreadHostAdapter>();

  constructor(
    hosts: ThreadHostAdapter[],
    private readonly defaultHostId: ThreadHostId = hosts[0]?.hostId ?? "local",
  ) {
    for (const host of hosts) {
      this.hosts.set(host.hostId, host);
    }
  }

  createControl(currentThreadId: string): ThreadControl {
    const resolveThreadId = (threadId: string | undefined): string => threadId ?? currentThreadId;
    return {
      listProjects: async () => await this.defaultHost().listProjects(),
      listThreads: async (input: ListThreadsInput) =>
        await this.host(input.hostId).listThreads(input),
      readThread: async (input: ReadThreadInput) =>
        await this.host(input.hostId).readThread({
          ...input,
          threadId: resolveThreadId(input.threadId),
        }),
      createThread: async (input: CreateThreadInput) =>
        await this.host(input.hostId).createThread(input),
      sendMessage: async (input: SendMessageToThreadInput) =>
        await this.host(input.hostId).sendMessage({
          ...input,
          threadId: resolveThreadId(input.threadId),
        }),
      forkThread: async (input: ForkThreadInput) =>
        await this.host(input.hostId).forkThread({
          ...input,
          threadId: resolveThreadId(input.threadId),
        }),
      handoffThread: async (input: HandoffThreadInput) =>
        await this.host(input.hostId).handoffThread(input),
      getHandoffStatus: async (input: HandoffStatusInput) =>
        await this.host(input.hostId).getHandoffStatus(input),
      setTitle: async (input: SetThreadTitleInput) =>
        await this.host(input.hostId).setTitle({
          ...input,
          threadId: resolveThreadId(input.threadId),
        }),
      setPinned: async (input: SetThreadPinnedInput) =>
        await this.host(input.hostId).setPinned({
          ...input,
          threadId: resolveThreadId(input.threadId),
        }),
      setArchived: async (input: SetThreadArchivedInput) =>
        await this.host(input.hostId).setArchived({
          ...input,
          threadId: resolveThreadId(input.threadId),
        }),
    };
  }

  private defaultHost(): ThreadHostAdapter {
    return this.host();
  }

  private host(hostId?: ThreadHostId): ThreadHostAdapter {
    const resolved = hostId?.trim() || this.defaultHostId;
    const host = this.hosts.get(resolved);
    if (!host) {
      throw new Error(`Unknown thread host: ${resolved}`);
    }
    return host;
  }
}
