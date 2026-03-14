export type EditorState =
  | { mode: "create" }
  | { mode: "edit"; name: string };

export function getEditingServerName(editorState: EditorState | null): string | null {
  return editorState?.mode === "edit" ? editorState.name : null;
}

export function getMcpEditorTitle(editorState: EditorState | null): string {
  const editingName = getEditingServerName(editorState);
  return editingName ? `Edit ${editingName}` : "Connect to a custom MCP";
}

export function getMcpEditorSubmitLabel(editorState: EditorState | null): string {
  return getEditingServerName(editorState) ? "Save changes" : "Add server";
}

export function getPreviousNameForUpsert(editorState: EditorState | null): string | undefined {
  return getEditingServerName(editorState) ?? undefined;
}

export function createMcpAutoValidateScheduler(
  validate: (workspaceId: string, name: string) => void | Promise<void>,
  {
    delayMs = 500,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }: {
    delayMs?: number;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
  } = {},
) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule(workspaceId: string, name: string) {
      if (timer !== null) clearTimeoutFn(timer);
      timer = setTimeoutFn(() => {
        timer = null;
        void validate(workspaceId, name);
      }, delayMs);
    },
    cancel() {
      if (timer === null) return;
      clearTimeoutFn(timer);
      timer = null;
    },
  };
}
