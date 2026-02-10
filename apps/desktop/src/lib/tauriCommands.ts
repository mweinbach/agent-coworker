import { invoke } from "@tauri-apps/api/core";

import type { PersistedState, TranscriptEvent } from "../app/types";

export async function startWorkspaceServer(opts: {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
}): Promise<{ url: string }> {
  return await invoke("start_workspace_server", opts);
}

export async function stopWorkspaceServer(opts: { workspaceId: string }): Promise<void> {
  await invoke("stop_workspace_server", opts);
}

export async function loadState(): Promise<PersistedState> {
  return await invoke("load_state");
}

export async function saveState(state: PersistedState): Promise<void> {
  await invoke("save_state", { state });
}

export async function readTranscript(opts: { threadId: string }): Promise<TranscriptEvent[]> {
  return await invoke("read_transcript", opts);
}

export async function appendTranscriptEvent(opts: {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
}): Promise<void> {
  await invoke("append_transcript_event", opts);
}

export async function appendTranscriptBatch(events: {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
}[]): Promise<void> {
  await invoke("append_transcript_batch", { events });
}

export async function deleteTranscript(opts: { threadId: string }): Promise<void> {
  await invoke("delete_transcript", opts);
}
