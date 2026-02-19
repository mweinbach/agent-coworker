import { For, createSignal } from "solid-js";
import { useTheme } from "../../context/theme";
import { useSyncActions } from "../../context/sync";
import type { ApprovalRequest } from "../../context/sync";
import { keyNameFromEvent } from "../../util/keyboard";

const OPTIONS = ["Allow once", "Allow always", "Reject"];

export function PermissionPrompt(props: { approval: ApprovalRequest }) {
  const theme = useTheme();
  const actions = useSyncActions();
  const [selected, setSelected] = createSignal(0);

  const handleSelect = () => {
    const idx = selected();
    if (idx === 2) {
      // Reject
      actions.respondApproval(props.approval.requestId, false);
    } else {
      // Allow (once or always)
      actions.respondApproval(props.approval.requestId, true);
    }
  };

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    if (key === "up") {
      setSelected((s) => Math.max(0, s - 1));
      e.preventDefault?.();
    } else if (key === "down") {
      setSelected((s) => Math.min(OPTIONS.length - 1, s + 1));
      e.preventDefault?.();
    } else if (key === "enter") {
      handleSelect();
      e.preventDefault?.();
    } else if (key === "escape") {
      actions.respondApproval(props.approval.requestId, false);
      e.preventDefault?.();
    }
  };

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={props.approval.dangerous ? theme.error : theme.warning}
      backgroundColor={theme.backgroundPanel}
      marginLeft={1}
      marginRight={1}
      marginBottom={1}
      padding={1}
      onKeyDown={handleKeyDown}
      focused
      focusable
    >
      <box flexDirection="row" gap={1} marginBottom={1}>
        <text fg={props.approval.dangerous ? theme.error : theme.warning}>
          {props.approval.dangerous ? "⚠ Dangerous command" : "⚠ Approval required"}
        </text>
      </box>

      <box
        border
        borderStyle="single"
        borderColor={theme.borderSubtle}
        backgroundColor={theme.backgroundElement}
        padding={1}
        marginBottom={1}
      >
        <text fg={theme.text}>{props.approval.command}</text>
      </box>

      <For each={OPTIONS}>
        {(opt, i) => (
          <box
            flexDirection="row"
            gap={1}
            onMouseDown={() => {
              setSelected(i());
              handleSelect();
            }}
          >
            <text fg={selected() === i() ? theme.accent : theme.textMuted}>
              {selected() === i() ? "▸" : " "}
            </text>
            <text fg={selected() === i() ? theme.text : theme.textMuted}>{opt}</text>
          </box>
        )}
      </For>
    </box>
  );
}
