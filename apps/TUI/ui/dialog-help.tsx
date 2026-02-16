import { For } from "solid-js";
import { useTheme } from "../context/theme";
import { useKeybind, formatKeybind } from "../context/keybind";
import { Dialog } from "./dialog";

type DialogHelpProps = {
  onDismiss: () => void;
};

export function DialogHelp(props: DialogHelpProps) {
  const theme = useTheme();
  const keybind = useKeybind();

  const categories = () => {
    const cmds = keybind.commands();
    const grouped: Record<string, typeof cmds> = {};
    for (const cmd of cmds) {
      const cat = cmd.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat]!.push(cmd);
    }
    return grouped;
  };

  return (
    <Dialog onDismiss={props.onDismiss} width="70%">
      <box flexDirection="column" onKeyDown={(e: any) => {
        if ((e.key ?? e.name) === "escape") {
          props.onDismiss();
          e.preventDefault?.();
        }
      }} autoFocus>
        <text fg={theme.text} marginBottom={1}>
          <strong>Keyboard Shortcuts</strong>
        </text>

        <scrollbox maxHeight={25}>
          <For each={Object.entries(categories())}>
            {([category, cmds]) => (
              <box flexDirection="column" marginBottom={1}>
                <text fg={theme.accent}>
                  <strong>{category.charAt(0).toUpperCase() + category.slice(1)}</strong>
                </text>
                <For each={cmds}>
                  {(cmd) => (
                    <box flexDirection="row" paddingLeft={2} gap={1}>
                      <text fg={theme.text} width={30}>
                        {cmd.name}
                      </text>
                      <text fg={theme.textMuted} flexGrow={1}>
                        {cmd.description}
                      </text>
                      {cmd.keybind && (
                        <text fg={theme.accent}>
                          {formatKeybind(cmd.keybind)}
                        </text>
                      )}
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </scrollbox>

        <text fg={theme.textMuted} marginTop={1}>
          Press Escape to close
        </text>
      </box>
    </Dialog>
  );
}
