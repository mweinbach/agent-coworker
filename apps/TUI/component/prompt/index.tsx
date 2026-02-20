import path from "node:path";
import fg from "fast-glob";
import { TextareaRenderable } from "@opentui/core";
import { createEffect, createMemo, Show, type JSX } from "solid-js";
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
import { resolveTextareaInputValue } from "./input-value";
import {
  createLocalSlashCommands,
  findLocalSlashCommand,
  localSlashCommandsToAutocompleteItems,
  parseSlashInput,
} from "./slash-commands";

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

const COMPOSER_KEY_BINDINGS = [
  { name: "enter", action: "submit" as const },
  { name: "enter", shift: true, action: "newline" as const },
  { name: "j", ctrl: true, action: "newline" as const },
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

  let composerRef: TextareaRenderable | undefined;

  const localSlashCommands = createLocalSlashCommands({
    syncActions,
    route,
    dialog,
    exit: exitCtx,
  });

  const commandAutocompleteItems = createMemo(() => {
    const localItems = localSlashCommandsToAutocompleteItems(localSlashCommands);
    const serverItems = syncState.commands
      .filter((command) => command.source !== "skill")
      .map<AutocompleteItem>((command) => ({
        label: `/${command.name}`,
        value: `/${command.name}`,
        description: command.description,
        category: "command",
        icon: command.source === "mcp" ? "p" : command.source === "skill" ? "*" : "/",
      }));

    const deduped: AutocompleteItem[] = [];
    const seen = new Set<string>();

    for (const item of [...localItems, ...serverItems]) {
      const key = item.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    return deduped;
  });

  const autocomplete = createAutocomplete({
    getCommands: () => commandAutocompleteItems(),
    getFiles: () => getFileAutocompleteItems(syncState.cwd || process.cwd()),
  });

  createEffect(() => {
    const value = prompt.input();
    if (!composerRef) return;
    if (composerRef.plainText === value) return;

    composerRef.replaceText(value);
    composerRef.cursorOffset = value.length;
    autocomplete.onInput(value, value.length);
  });

  const placeholder = () => {
    if (prompt.shellMode()) {
      return SHELL_PLACEHOLDERS[Math.floor(Math.random() * SHELL_PLACEHOLDERS.length)]!;
    }
    return PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]!;
  };

  const isDisabled = createMemo(() => {
    return props.disabled || syncState.busy || syncState.pendingAsk !== null || syncState.pendingApproval !== null;
  });

  const setPromptInput = (value: string, cursorPos = value.length) => {
    prompt.setInput(value);
    if (composerRef) {
      if (composerRef.plainText !== value) {
        composerRef.replaceText(value);
      }
      composerRef.cursorOffset = Math.max(0, Math.min(cursorPos, value.length));
    }
    autocomplete.onInput(value, cursorPos);
  };

  const runSlashCommand = async (text: string): Promise<boolean> => {
    const serverCommandNamesWithSpaces = syncState.commands
      .map((command) => command.name)
      .filter((name) => name.includes(" "));
    const parsed = parseSlashInput(text, serverCommandNamesWithSpaces);
    if (!parsed) return false;

    const localCommand = findLocalSlashCommand(localSlashCommands, parsed.name);
    if (localCommand) {
      await Promise.resolve(localCommand.execute(parsed.argumentsText));
      return true;
    }

    const serverCommand = syncState.commands.find(
      (command) => command.name.toLowerCase() === parsed.name.toLowerCase()
    );
    if (serverCommand) {
      return syncActions.executeCommand(serverCommand.name, parsed.argumentsText, text);
    }

    return false;
  };

  const handleSubmit = async () => {
    const text = prompt.input().trim();
    if (!text) return;

    history.append(text, prompt.shellMode() ? "shell" : "normal");
    prompt.pushHistory(text);

    if (props.onSubmit) {
      props.onSubmit(text);
      setPromptInput("");
      return;
    }

    if (!prompt.shellMode() && text.startsWith("/")) {
      const handled = await runSlashCommand(text);
      if (handled) {
        setPromptInput("");
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

    setPromptInput("");
  };

  const handleKeyDown = (e: any) => {
    const key = keyNameFromEvent(e);
    const { ctrl, shift, alt } = keyModifiersFromEvent(e);

    // Page navigation belongs to the chat feed, not the prompt textarea.
    if (key === "pageup" || key === "pagedown") {
      e.preventDefault?.();
      return;
    }

    const acState = autocomplete.state();
    if (acState.visible) {
      if (autocomplete.onKeyDown(key, ctrl)) {
        e.preventDefault?.();

        if (key === "tab" || key === "enter") {
          const replacement = autocomplete.select(
            prompt.input(),
            composerRef?.cursorOffset ?? prompt.input().length
          );
          if (replacement !== null) {
            setPromptInput(replacement);
          }
        }
        return;
      }
    }

    const action = getTextareaAction(key, ctrl, shift, alt);

    switch (action) {
      case "submit":
      case "newline":
      case "none":
        return;

      case "clear":
        if (prompt.input() !== "") {
          e.preventDefault?.();
          setPromptInput("");
        }
        return;

      case "history_up": {
        // Only trigger history if cursor is on the first line
        const offset = composerRef?.cursorOffset ?? prompt.input().length;
        if (prompt.input().lastIndexOf("\n", offset - 1) !== -1) return;
        
        e.preventDefault?.();
        const entry = history.navigateUp(prompt.input());
        if (entry !== null) {
          setPromptInput(entry.input);
          if (entry.mode === "shell") prompt.setShellMode(true);
          else if (entry.mode === "normal") prompt.setShellMode(false);
        }
        return;
      }

      case "history_down": {
        // Only trigger history down if cursor is on the last line
        const offset = composerRef?.cursorOffset ?? prompt.input().length;
        if (prompt.input().indexOf("\n", offset) !== -1) return;
        
        e.preventDefault?.();
        const entry = history.navigateDown();
        if (entry !== null) {
          setPromptInput(entry.input);
          if (entry.mode === "shell") prompt.setShellMode(true);
          else if (entry.mode === "normal") prompt.setShellMode(false);
        }
        return;
      }

      case "cancel":
        if (prompt.input()) {
          e.preventDefault?.();
          setPromptInput("");
        }
        return;

      case "shell_mode":
        e.preventDefault?.();
        prompt.toggleShellMode();
        return;
    }
  };

  const handleInput = (raw: unknown) => {
    const value = resolveTextareaInputValue(raw, composerRef?.plainText ?? prompt.input());

    if (value === prompt.input()) {
      autocomplete.onInput(value, composerRef?.cursorOffset ?? value.length);
      return;
    }

    history.resetIndex();

    if (value.startsWith("!") && !prompt.shellMode()) {
      const stripped = value.slice(1);
      prompt.setShellMode(true);
      prompt.setInput(stripped);
      if (composerRef && composerRef.plainText !== stripped) {
        composerRef.replaceText(stripped);
        composerRef.cursorOffset = stripped.length;
      }
      autocomplete.onInput(stripped, composerRef?.cursorOffset ?? stripped.length);
      return;
    }

    prompt.setInput(value);
    autocomplete.onInput(value, composerRef?.cursorOffset ?? value.length);
  };

  return (
    <box flexDirection="column" width="100%">
      <AutocompleteDropdown
        items={() => autocomplete.state().items}
        selectedIndex={() => autocomplete.state().selectedIndex}
        visible={() => autocomplete.state().visible}
        emptyText="No matching items"
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
          <text fg={prompt.shellMode() ? theme.warning : theme.accent} selectable={false}>
            {prompt.shellMode() ? "$ " : "❯ "}
          </text>
          <textarea
            ref={(el) => {
              composerRef = el;
            }}
            initialValue={prompt.input()}
            onContentChange={handleInput}
            onKeyDown={handleKeyDown}
            onSubmit={() => {
              if (!isDisabled()) {
                void handleSubmit();
              }
            }}
            keyBindings={COMPOSER_KEY_BINDINGS}
            placeholder={isDisabled() ? "Waiting..." : placeholder()}
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focused={!isDisabled()}
            flexGrow={1}
          />
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
