import { createMemo, For, Show } from "solid-js";
import { useTheme } from "../context/theme";
import { Dialog } from "../ui/dialog";
import { useDialog } from "../context/dialog";
import { createPromptStash, formatRelativeTime, type StashEntry } from "./prompt/stash";

const stash = createPromptStash();

export { stash };

export function openStashDialog(
  dialog: ReturnType<typeof useDialog>,
  onRestore?: (input: string) => void
) {
  dialog.push(
    () => (
      <StashDialog
        onDismiss={() => dialog.pop()}
        onRestore={(input) => {
          dialog.pop();
          onRestore?.(input);
        }}
      />
    ),
    () => {}
  );
}

function StashDialog(props: {
  onDismiss: () => void;
  onRestore?: (input: string) => void;
}) {
  const theme = useTheme();
  const entries = createMemo(() => [...stash.list()].reverse());

  const handleRestore = (entry: StashEntry, index: number) => {
    // Remove from stash (index is reversed)
    const realIndex = stash.list().length - 1 - index;
    stash.remove(realIndex);
    props.onRestore?.(entry.input);
  };

  return (
    <Dialog onDismiss={props.onDismiss} width="60%">
      <box flexDirection="column">
        <text fg={theme.text} marginBottom={1}>
          <strong>Prompt Stash</strong>
        </text>

        <Show
          when={entries().length > 0}
          fallback={
            <text fg={theme.textMuted}>
              No stashed prompts. Use Ctrl+Z to stash the current prompt.
            </text>
          }
        >
          <For each={entries()}>
            {(entry, idx) => {
              const preview = () => {
                const firstLine = entry.input.split("\n")[0] ?? "";
                return firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
              };
              const lineCount = () => entry.input.split("\n").length;
              return (
                <box flexDirection="row" gap={2} marginBottom={0}>
                  <text fg={theme.accent} selectable={false}>
                    {`${idx() + 1}.`}
                  </text>
                  <text fg={theme.text}>{preview()}</text>
                  <Show when={lineCount() > 1}>
                    <text fg={theme.textMuted}>{`(${lineCount()} lines)`}</text>
                  </Show>
                  <text fg={theme.textMuted}>{formatRelativeTime(entry.timestamp)}</text>
                </box>
              );
            }}
          </For>
        </Show>

        <box marginTop={1}>
          <text fg={theme.textMuted}>
            Enter to restore · Escape to close
          </text>
        </box>
      </box>
    </Dialog>
  );
}
