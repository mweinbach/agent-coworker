import { createMemo } from "solid-js";
import { DialogSelect, type SelectItem } from "../ui/dialog-select";
import { useDialog } from "../context/dialog";
import { useRoute } from "../context/route";
import { useSyncState, useSyncActions } from "../context/sync";
import { useThemeContext } from "../context/theme";
import { useKV } from "../context/kv";
import { usePrompt } from "../context/prompt";
import { useExit } from "../context/exit";

export function openCommandPalette(dialog: ReturnType<typeof useDialog>) {
  dialog.push(
    () => <CommandPaletteDialog onDismiss={() => dialog.pop()} />,
    () => {}
  );
}

function CommandPaletteDialog(props: { onDismiss: () => void }) {
  const route = useRoute();
  const syncState = useSyncState();
  const syncActions = useSyncActions();
  const themeCtx = useThemeContext();
  const kv = useKV();
  const prompt = usePrompt();
  const exitCtx = useExit();
  const dialog = useDialog();

  const items = createMemo((): SelectItem[] => {
    const cmds: SelectItem[] = [
      // Session commands
      {
        label: "New Session",
        value: "new",
        description: "Start a fresh conversation",
        category: "Session",
        keybind: "Ctrl+N",
      },
      {
        label: "Reset Session",
        value: "reset",
        description: "Clear current session",
        category: "Session",
      },
      {
        label: "Cancel Turn",
        value: "cancel",
        description: "Cancel the current agent turn",
        category: "Session",
      },
      {
        label: "Copy Last Response",
        value: "copy_last",
        description: "Copy last assistant message",
        category: "Session",
      },
      {
        label: "Export Transcript",
        value: "export_transcript",
        description: "Copy session transcript",
        category: "Session",
      },

      // Display commands
      {
        label: "Toggle Thinking",
        value: "toggle_thinking",
        description: "Show/hide reasoning",
        category: "Display",
      },
      {
        label: "Toggle Tool Details",
        value: "toggle_details",
        description: "Show/hide tool output",
        category: "Display",
      },
      {
        label: "Toggle Sidebar",
        value: "toggle_sidebar",
        description: "Show/hide sidebar panel",
        category: "Display",
        keybind: "Ctrl+E",
      },
      {
        label: "Toggle Timestamps",
        value: "toggle_timestamps",
        description: "Show/hide message timestamps",
        category: "Display",
      },

      // Prompt commands
      {
        label: "Stash Prompt",
        value: "stash",
        description: "Save current prompt for later",
        category: "Prompt",
        keybind: "Ctrl+Z",
      },
      {
        label: "Pop Stash",
        value: "unstash",
        description: "Restore last stashed prompt",
        category: "Prompt",
        keybind: "Ctrl+Shift+Z",
      },
      {
        label: "View Stash",
        value: "stash_list",
        description: "Browse stashed prompts",
        category: "Prompt",
      },
      {
        label: "Toggle Shell Mode",
        value: "shell_mode",
        description: "Switch between agent and shell mode",
        category: "Prompt",
        keybind: "Ctrl+]",
      },

      // Model/Provider/Theme
      {
        label: "Switch Model",
        value: "models",
        description: "Change AI model",
        category: "System",
        keybind: "Ctrl+Shift+L",
      },
      {
        label: "Switch Theme",
        value: "themes",
        description: "Change color theme",
        category: "System",
        keybind: "Ctrl+X T",
      },
      {
        label: "Connect Provider",
        value: "connect",
        description: "Add API key",
        category: "System",
      },
      {
        label: "MCP Servers",
        value: "mcp",
        description: "View MCP server status",
        category: "System",
      },

      // Navigation / Help
      {
        label: "Help",
        value: "help",
        description: "Show keyboard shortcuts",
        category: "System",
        keybind: "?",
      },
      {
        label: "Status",
        value: "status",
        description: "Show session info",
        category: "System",
      },
      {
        label: "Exit",
        value: "exit",
        description: "Close the TUI",
        category: "System",
        keybind: "Ctrl+C",
      },
    ];

    return cmds;
  });

  const handleSelect = (item: SelectItem) => {
    props.onDismiss();

    switch (item.value) {
      case "new":
        syncActions.reset();
        route.navigate({ route: "home" });
        break;
      case "reset":
        syncActions.reset();
        break;
      case "cancel":
        syncActions.cancel();
        break;
      case "copy_last": {
        const feed = syncState.feed ?? [];
        const lastAssistant = [...feed].reverse().find(
          (f: any) => f.type === "message" && f.role === "assistant"
        ) as any;
        if (lastAssistant?.text) {
          import("../util/clipboard").then(({ copyToClipboard }) =>
            copyToClipboard(lastAssistant.text)
          );
        }
        break;
      }
      case "export_transcript": {
        import("../util/transcript").then(({ formatTranscript }) => {
          const transcript = formatTranscript(syncState.feed ?? []);
          import("../util/clipboard").then(({ copyToClipboard }) =>
            copyToClipboard(transcript)
          );
        });
        break;
      }
      case "toggle_thinking":
        kv.set("thinking_visibility", kv.get("thinking_visibility", "true") === "true" ? "false" : "true");
        break;
      case "toggle_details":
        kv.set("tool_details_visibility", kv.get("tool_details_visibility", "false") === "false" ? "true" : "false");
        break;
      case "toggle_sidebar":
        kv.set("sidebar_visible", kv.get("sidebar_visible", "true") === "true" ? "false" : "true");
        break;
      case "toggle_timestamps":
        kv.set("show_timestamps", kv.get("show_timestamps", "false") === "false" ? "true" : "false");
        break;
      case "stash":
        prompt.doStash();
        break;
      case "unstash": {
        const restored = prompt.doUnstash();
        if (restored !== null) {
          prompt.setInput(restored);
        }
        break;
      }
      case "stash_list":
        import("./dialog-stash").then(({ openStashDialog }) =>
          openStashDialog(dialog, (input) => prompt.setInput(input))
        );
        break;
      case "shell_mode":
        // Shell mode is handled in prompt component — no-op here
        break;
      case "models":
        import("./dialog-model").then(({ openModelPicker }) => openModelPicker(dialog));
        break;
      case "themes":
        import("./dialog-theme-list").then(({ openThemePicker }) => openThemePicker(dialog));
        break;
      case "connect":
        import("./dialog-provider").then(({ openProviderDialog }) => openProviderDialog(dialog));
        break;
      case "mcp":
        import("./dialog-mcp").then(({ openMcpDialog }) => openMcpDialog(dialog));
        break;
      case "help":
        import("../ui/dialog-help").then(({ openHelpDialog }) => openHelpDialog(dialog));
        break;
      case "status":
        import("./dialog-status").then(({ openStatusDialog }) => openStatusDialog(dialog));
        break;
      case "exit":
        exitCtx.exit();
        break;
    }
  };

  return (
    <DialogSelect
      items={items()}
      onSelect={handleSelect}
      onDismiss={props.onDismiss}
      title="Command Palette"
      placeholder="Type a command..."
    />
  );
}
