import path from "node:path";
import fg from "fast-glob";
import { createMemo, Show, type JSX } from "solid-js";
import { useTheme } from "../../context/theme";
import { usePrompt } from "../../context/prompt";
import { useSyncState, useSyncActions } from "../../context/sync";
import { useRoute } from "../../context/route";
import { useDialog } from "../../context/dialog";
import { useExit } from "../../context/exit";
import { keyModifiersFromEvent, keyNameFromEvent } from "../../util/keyboard";
import { createPromptHistory } from "./history";
import { createAutocomplete, AutocompleteDropdown, type AutocompleteItem } from "./autocomplete";
import { getTextareaAction } from "../textarea-keybindings";

const PLACEHOLDERS = [
  "Ask me anything...",
  "What would you like to build?",
  "Describe a task or ask a question...",
  "How can I help?",
  "What should we work on?",
];

const SHELL_PLACEHOLDERS = [
  "Enter a shell command...",
  "Run a command...",
  "$ ",
];

const history = createPromptHistory();
const FILE_AUTOCOMPLETE_AGE_MS = 5000;
const FILE_AUTOCOMPLETE_LIMIT = 600;
const FILE_AUTOCOMPLETE_IGNORE = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.agent/**",
  "**/output/**",
  "**/uploads/**",
];

let fileCache: {
  cwd: string;
  at: number;
  items: AutocompleteItem[];
} | null = null;

function getFileAutocompleteItems(cwd: string): AutocompleteItem[] {
  const now = Date.now();
  if (
    fileCache &&
    fileCache.cwd === cwd &&
    now - fileCache.at < FILE_AUTOCOMPLETE_AGE_MS
  ) {
    return fileCache.items;
  }

  try {
    const files = fg
      .sync(["**/*"], {
        cwd,
        onlyFiles: true,
        dot: true,
        deep: 6,
        unique: true,
        suppressErrors: true,
        ignore: FILE_AUTOCOMPLETE_IGNORE,
      })
      .slice(0, FILE_AUTOCOMPLETE_LIMIT);

    const items = files.map((p) => ({
      label: path.basename(p) || p,
      value: p,
      description: p,
      category: "file",
      icon: "@",
    }));

    fileCache = { cwd, at: now, items };
    return items;
  } catch {
    return [];
  }
}

export function Prompt(props: {
  hint?: JSX.Element;
  onSubmit?: (text: string) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const prompt = usePrompt();
  const syncState = useSyncState();
  const syncActions = useSyncActions();
  const route = useRoute();
  const dialog = useDialog();
  const exitCtx = useExit();

  const placeholder = () => {
    if (prompt.shellMode()) {
      return SHELL_PLACEHOLDERS[Math.floor(Math.random() * SHELL_PLACEHOLDERS.length)]!;
    }
    return PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]!;
  };

  const autocomplete = createAutocomplete({
    getCommands: () => [
      { label: "/new", value: "/new", description: "New session", category: "command", icon: "+" },
      { label: "/clear", value: "/clear", description: "Clear session", category: "command", icon: "x" },
      { label: "/status", value: "/status", description: "Show status", category: "command", icon: "i" },
      { label: "/cancel", value: "/cancel", description: "Cancel current turn", category: "command", icon: "!" },
      { label: "/exit", value: "/exit", description: "Exit", category: "command", icon: "q" },
      { label: "/models", value: "/models", description: "Switch model", category: "command", icon: "m" },
      { label: "/connect", value: "/connect", description: "Connect provider", category: "command", icon: "c" },
      { label: "/themes", value: "/themes", description: "Change theme", category: "command", icon: "t" },
      { label: "/sessions", value: "/sessions", description: "Show sessions", category: "command", icon: "s" },
      { label: "/mcp", value: "/mcp", description: "Show MCP status", category: "command", icon: "p" },
      { label: "/help", value: "/help", description: "Show help", category: "command", icon: "?" },
    ],
    getFiles: () => getFileAutocompleteItems(syncState.cwd || process.cwd()),
  });

  const isDisabled = createMemo(() => {
    return props.disabled || syncState.busy || syncState.pendingAsk !== null || syncState.pendingApproval !== null;
  });

  const runSlashCommand = (raw: string): boolean => {
    const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    const normalized = (cmd ?? "").toLowerCase();

    switch (normalized) {
      case "new":
      case "reset":
      case "clear":
        syncActions.reset();
        route.navigate({ route: "home" });
        return true;

      case "status":
        import("../dialog-status").then(({ openStatusDialog }) => openStatusDialog(dialog));
        return true;

      case "help":
        import("../../ui/dialog-help").then(({ openHelpDialog }) => openHelpDialog(dialog));
        return true;

      case "models":
      case "model":
        import("../dialog-model").then(({ openModelPicker }) => openModelPicker(dialog));
        return true;

      case "themes":
      case "theme":
        import("../dialog-theme-list").then(({ openThemePicker }) => openThemePicker(dialog));
        return true;

      case "connect":
        if (arg) {
          syncActions.connectProvider(arg);
        } else {
          import("../dialog-provider").then(({ openProviderDialog }) => openProviderDialog(dialog));
        }
        return true;

      case "sessions":
        import("../dialog-session-list").then(({ openSessionList }) => openSessionList(dialog));
        return true;

      case "mcp":
        import("../dialog-mcp").then(({ openMcpDialog }) => openMcpDialog(dialog));
        return true;

      case "cancel":
        syncActions.cancel();
        return true;

      case "exit":
      case "quit":
        exitCtx.exit();
        return true;

      default:
        return false;
    }
  };

  const handleSubmit = () => {
    const text = prompt.input().trim();
    if (!text) return;

    // Save to persistent history
    history.append(text, prompt.shellMode() ? "shell" : "normal");
    // Also save to context history
    prompt.pushHistory(text);

    if (props.onSubmit) {
      props.onSubmit(text);
      prompt.setInput("");
      return;
    }

    if (!prompt.shellMode() && text.startsWith("/")) {
      const handled = runSlashCommand(text);
      if (handled) {
        prompt.setInput("");
        return;
      }
    }

    const messageText = prompt.shellMode() ? `!${text}` : text;
    if (route.current().route === "home") {
      syncActions.sendMessage(messageText);
      route.navigate({ route: "session", sessionId: syncState.sessionId ?? "pending" });
    } else {
      syncActions.sendMessage(messageText);
    }

    prompt.setInput("");
  };

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    const { ctrl, shift, alt } = keyModifiersFromEvent(e);

    // Let autocomplete handle keys first
    const acState = autocomplete.state();
    if (acState.visible) {
      if (autocomplete.onKeyDown(key, ctrl)) {
        e.preventDefault?.();

        // If tab/enter, do the selection
        if (key === "tab" || key === "enter") {
          const replacement = autocomplete.select(prompt.input());
          if (replacement !== null) {
            prompt.setInput(replacement);
          }
        }
        return;
      }
    }

    // Use textarea keybinding mapping
    const action = getTextareaAction(key, ctrl, shift, alt);

    switch (action) {
      case "submit":
        e.preventDefault?.();
        if (!isDisabled()) handleSubmit();
        return;

      case "newline":
        // Allow newline insertion (Shift+Enter)
        return;

      case "clear":
        if (prompt.input() !== "") {
          e.preventDefault?.();
          prompt.setInput("");
        }
        return;

      case "history_up": {
        e.preventDefault?.();
        const entry = history.navigateUp(prompt.input());
        if (entry !== null) {
          prompt.setInput(entry.input);
          if (entry.mode === "shell") prompt.setShellMode(true);
          else if (entry.mode === "normal") prompt.setShellMode(false);
        }
        return;
      }

      case "history_down": {
        e.preventDefault?.();
        const entry = history.navigateDown();
        if (entry !== null) {
          prompt.setInput(entry.input);
          if (entry.mode === "shell") prompt.setShellMode(true);
          else if (entry.mode === "normal") prompt.setShellMode(false);
        }
        return;
      }

      case "cancel":
        e.preventDefault?.();
        if (prompt.input()) {
          prompt.setInput("");
        }
        return;

      case "stash":
        e.preventDefault?.();
        prompt.doStash();
        return;

      case "unstash": {
        e.preventDefault?.();
        const restored = prompt.doUnstash();
        if (restored !== null) {
          prompt.setInput(restored);
        }
        return;
      }

      case "shell_mode":
        e.preventDefault?.();
        prompt.toggleShellMode();
        return;
    }
  };

  const handleInput = (v: any) => {
    const value = typeof v === "string" ? v : v?.value ?? "";
    prompt.setInput(value);
    history.resetIndex();

    // Check for ! prefix to auto-enable shell mode
    if (value.startsWith("!") && !prompt.shellMode()) {
      const stripped = value.slice(1);
      prompt.setShellMode(true);
      prompt.setInput(stripped);
      autocomplete.onInput(stripped);
      return;
    }

    // Update autocomplete
    autocomplete.onInput(value);
  };

  return (
    <box flexDirection="column" width="100%">
      {/* Autocomplete dropdown above the input */}
      <AutocompleteDropdown
        items={() => autocomplete.state().items}
        selectedIndex={() => autocomplete.state().selectedIndex}
        visible={() => autocomplete.state().visible}
      />

      <box
        border
        borderStyle="rounded"
        borderColor={isDisabled() ? theme.border : theme.borderActive}
        backgroundColor={isDisabled() ? theme.backgroundPanel : theme.backgroundElement}
        flexDirection="column"
        padding={0}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row">
          {/* Mode indicator */}
          <text fg={prompt.shellMode() ? theme.warning : theme.accent} selectable={false}>
            {prompt.shellMode() ? "$ " : "❯ "}
          </text>
          <input
            value={prompt.input()}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onSubmit={() => {
              if (!isDisabled()) handleSubmit();
            }}
            placeholder={isDisabled() ? "Waiting..." : placeholder()}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focused={!isDisabled()}
            flexGrow={1}
          />
          {/* Shell mode badge */}
          <Show when={prompt.shellMode()}>
            <text fg={theme.warning} selectable={false}>
              {" SHELL"}
            </text>
          </Show>
        </box>
        <Show when={props.hint}>
          <box paddingTop={0}>
            {props.hint}
          </box>
        </Show>
      </box>
      <Show when={syncState.busy}>
        <box paddingLeft={2}>
          <text fg={theme.textMuted}>Agent is working...</text>
        </box>
      </Show>
    </box>
  );
}
