import type {
  CloudSyncHealth,
  CloudSyncPatch,
  CloudSyncPullResult,
  CloudSyncRemoteState,
  CloudSyncScope,
} from "./types";

export interface CloudSyncProvider {
  readRemoteState(scope: CloudSyncScope): Promise<CloudSyncRemoteState | null>;
  pushPatch(scope: CloudSyncScope, patch: CloudSyncPatch): Promise<{ cursor?: string }>;
  pullSince(scope: CloudSyncScope, cursor?: string): Promise<CloudSyncPullResult>;
  healthCheck(): Promise<CloudSyncHealth>;
  shutdown(): Promise<void>;
}
