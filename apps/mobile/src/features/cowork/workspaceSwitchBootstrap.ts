import type { CoworkThreadListResult } from "./protocolTypes";

type BootstrapWorkspaceSwitchSessionOptions = {
  client: {
    initialize: () => Promise<void>;
    requestThreadList: () => Promise<CoworkThreadListResult>;
  };
  clearThreads: () => void;
  hydrateThread: (thread: CoworkThreadListResult["threads"][number]) => void;
  refreshWorkspaceBoundStores: () => Promise<void>;
  waitForInitializedMs?: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function bootstrapWorkspaceSwitchSession(
  options: BootstrapWorkspaceSwitchSessionOptions,
): Promise<void> {
  options.clearThreads();
  await options.client.initialize();
  await delay(Math.max(0, options.waitForInitializedMs ?? 100));
  const list = await options.client.requestThreadList();
  for (const thread of list.threads) {
    options.hydrateThread(thread);
  }
  await options.refreshWorkspaceBoundStores();
}
