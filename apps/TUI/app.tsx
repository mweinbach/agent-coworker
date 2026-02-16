import { useKeyboard } from "@opentui/solid";
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { openCommandPalette } from "./component/dialog-command";
import { useDialog } from "./context/dialog";
import { useExit } from "./context/exit";
import { useKeybind, type Command } from "./context/keybind";
import { useKV } from "./context/kv";
import { usePrompt } from "./context/prompt";
import { useRoute } from "./context/route";
import { useSyncActions, useSyncState } from "./context/sync";
import { useTheme } from "./context/theme";
import { Home } from "./routes/home";
import { Session } from "./routes/session/index";
import { Toast, showToast } from "./ui/toast";
import { resolveCtrlCAction } from "./util/ctrl-c";
import { keyModifiersFromEvent, keyNameFromEvent } from "./util/keyboard";

export function App() {
  const { current } = useRoute();
  const theme = useTheme();
  const dialog = useDialog();

  const isHome = createMemo(() => current().route === "home");
  const sessionId = createMemo(() => {
    const c = current();
    return c.route === "session" ? c.sessionId : null;
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background}
    >
      <GlobalHotkeys />

      <Show when={isHome()}>
        <Home />
      </Show>
      <Show when={sessionId()}>
        {(sid) => <Session sessionId={sid()} />}
      </Show>

      {/* Dialog overlay */}
      <Show when={dialog.hasDialog()}>
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={100}
        >
          {dialog.stack().length > 0 && dialog.stack()[dialog.stack().length - 1]!.element()}
        </box>
      </Show>

      <Toast />
    </box>
  );
}

function GlobalHotkeys() {
  const keybind = useKeybind();
  const dialog = useDialog();
  const route = useRoute();
  const syncState = useSyncState();
  const syncActions = useSyncActions();
  const kv = useKV();
  const prompt = usePrompt();
  const exitCtx = useExit();

  const [ctrlXPendingAt, setCtrlXPendingAt] = createSignal<number | null>(null);
  const [ctrlCPendingAt, setCtrlCPendingAt] = createSignal<number | null>(null);

  const toggleSidebar = () => {
    kv.set("sidebar_visible", kv.get("sidebar_visible", "true") === "true" ? "false" : "true");
  };

  const commands: Command[] = [
    {
      id: "open-command-palette",
      name: "Open Command Palette",
      description: "Open the command palette",
      category: "navigation",
      keybind: { key: "k", ctrl: true },
      action: () => openCommandPalette(dialog),
    },
    {
      id: "new-session",
      name: "New Session",
      description: "Start a fresh conversation",
      category: "session",
      keybind: { key: "n", ctrl: true },
      action: () => {
        syncActions.reset();
        route.navigate({ route: "home" });
      },
    },
    {
      id: "cancel-turn",
      name: "Cancel Turn",
      description: "Cancel the current running turn",
      category: "session",
      action: () => syncActions.cancel(),
    },
    {
      id: "toggle-sidebar",
      name: "Toggle Sidebar",
      description: "Show or hide the session sidebar",
      category: "display",
      keybind: { key: "e", ctrl: true },
      action: toggleSidebar,
    },
    {
      id: "switch-model",
      name: "Switch Model",
      description: "Open the model picker",
      category: "system",
      keybind: { key: "l", ctrl: true, shift: true },
      action: () => import("./component/dialog-model").then(({ openModelPicker }) => openModelPicker(dialog)),
    },
    {
      id: "switch-theme",
      name: "Switch Theme",
      description: "Open the theme picker",
      category: "system",
      action: () => import("./component/dialog-theme-list").then(({ openThemePicker }) => openThemePicker(dialog)),
    },
    {
      id: "list-sessions",
      name: "List Sessions",
      description: "Open session history list",
      category: "navigation",
      action: () => import("./component/dialog-session-list").then(({ openSessionList }) => openSessionList(dialog)),
    },
    {
      id: "show-help",
      name: "Show Help",
      description: "Open keyboard shortcut help",
      category: "navigation",
      action: () => import("./ui/dialog-help").then(({ openHelpDialog }) => openHelpDialog(dialog)),
    },
    {
      id: "show-status",
      name: "Show Status",
      description: "Open system status dialog",
      category: "system",
      action: () => import("./component/dialog-status").then(({ openStatusDialog }) => openStatusDialog(dialog)),
    },
    {
      id: "connect-provider",
      name: "Connect Provider",
      description: "Open provider connection dialog",
      category: "system",
      action: () => import("./component/dialog-provider").then(({ openProviderDialog }) => openProviderDialog(dialog)),
    },
    {
      id: "show-mcp",
      name: "MCP Servers",
      description: "Open MCP status dialog",
      category: "system",
      action: () => import("./component/dialog-mcp").then(({ openMcpDialog }) => openMcpDialog(dialog)),
    },
    {
      id: "stash-prompt",
      name: "Stash Prompt",
      description: "Save current prompt text",
      category: "prompt",
      keybind: { key: "z", ctrl: true },
      action: () => prompt.doStash(),
    },
    {
      id: "unstash-prompt",
      name: "Pop Stash",
      description: "Restore last stashed prompt",
      category: "prompt",
      keybind: { key: "z", ctrl: true, shift: true },
      action: () => {
        const restored = prompt.doUnstash();
        if (restored !== null) prompt.setInput(restored);
      },
    },
    {
      id: "toggle-shell-mode",
      name: "Toggle Shell Mode",
      description: "Toggle between chat and shell prompt mode",
      category: "prompt",
      keybind: { key: "]", ctrl: true },
      action: () => prompt.toggleShellMode(),
    },
  ];

  onMount(() => {
    keybind.registerMany(commands);
  });

  onCleanup(() => {
    for (const command of commands) {
      keybind.unregister(command.id);
    }
  });

  const tryHandleCtrlXChord = (
    key: string,
    ctrl: boolean,
    alt: boolean
  ): boolean => {
    const startedAt = ctrlXPendingAt();
    if (startedAt === null) return false;

    if (Date.now() - startedAt > 1500) {
      setCtrlXPendingAt(null);
      return false;
    }

    if (ctrl || alt) {
      setCtrlXPendingAt(null);
      return false;
    }

    if (key === "t") {
      setCtrlXPendingAt(null);
      keybind.execute("switch-theme");
      return true;
    }

    if (key === "s") {
      setCtrlXPendingAt(null);
      keybind.execute("list-sessions");
      return true;
    }

    setCtrlXPendingAt(null);
    return false;
  };

  useKeyboard((e) => {
    if (e.repeated) return;
    if ((e as { defaultPrevented?: boolean }).defaultPrevented) return;

    const key = keyNameFromEvent(e);
    const { ctrl, shift, alt } = keyModifiersFromEvent(e);
    const isCtrlC = ctrl && !shift && !alt && key === "c";

    if (!isCtrlC && ctrlCPendingAt() !== null) {
      setCtrlCPendingAt(null);
    }

    if (dialog.hasDialog()) {
      if (key === "escape") {
        dialog.pop();
        e.preventDefault();
      }
      return;
    }

    if (tryHandleCtrlXChord(key, ctrl, alt)) {
      e.preventDefault();
      return;
    }

    if (ctrl && !shift && !alt && key === "x") {
      setCtrlXPendingAt(Date.now());
      e.preventDefault();
      return;
    }

    if (key === "escape") {
      if (syncState.busy) {
        syncActions.cancel();
      } else if (prompt.input()) {
        prompt.setInput("");
      }
      e.preventDefault();
      return;
    }

    if (isCtrlC) {
      const resolved = resolveCtrlCAction(prompt.input(), ctrlCPendingAt(), Date.now());
      setCtrlCPendingAt(resolved.nextPendingAt);

      if (resolved.outcome === "clear_input") {
        prompt.setInput("");
      } else if (resolved.outcome === "confirm_exit") {
        showToast("Press Ctrl+C again to exit", "warning");
      } else {
        exitCtx.exit();
      }
      e.preventDefault();
      return;
    }

    if ((key === "/" && shift && !ctrl && !alt) || key === "?") {
      keybind.execute("show-help");
      e.preventDefault();
      return;
    }

    const matched = keybind.matchKey(key, ctrl, shift, alt);
    if (matched) {
      matched.action();
      e.preventDefault();
    }
  });

  return null;
}
