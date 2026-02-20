import { createEffect, createMemo } from "solid-js";

import { useDialog } from "../context/dialog";
import { useSync } from "../context/sync";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";

function formatAge(updatedAt: string): string {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return "unknown";
  const diffMs = Math.max(0, Date.now() - updatedAtMs);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function openSessionList(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <SessionListDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function SessionListDialog(props: { onDismiss: () => void }) {
  const { state, actions } = useSync();

  createEffect(() => {
    actions.requestSessions();
  });

  const items = createMemo<SelectItem[]>(() => {
    return state.sessionSummaries.map((session) => {
      const current = session.sessionId === state.sessionId;
      const subtitle = `${session.provider}/${session.model} · ${formatAge(session.updatedAt)}`;
      return {
        label: current ? `${session.title} (current)` : session.title,
        value: session.sessionId,
        description: subtitle,
      };
    });
  });

  return (
    <DialogSelect
      title={`Sessions (${state.sessionSummaries.length})`}
      items={items()}
      placeholder="Search sessions..."
      width="70%"
      onDismiss={props.onDismiss}
      onSelect={(item) => {
        actions.resumeSession(item.value);
        props.onDismiss();
      }}
    />
  );
}
