export type EditableMcpSource = "user" | "workspace";

export type EditorState =
  | { mode: "create" }
  | { mode: "edit"; name: string; source: EditableMcpSource };

function getEditingServerName(editorState: EditorState | null): string | null {
  return editorState?.mode === "edit" ? editorState.name : null;
}

export function getMcpEditorTitle(editorState: EditorState | null): string {
  const editingName = getEditingServerName(editorState);
  return editingName ? `Edit ${editingName}` : "Add connector";
}

export function getMcpEditorSubmitLabel(editorState: EditorState | null): string {
  return getEditingServerName(editorState) ? "Save changes" : "Add connector";
}

export function getPreviousNameForUpsert(editorState: EditorState | null): string | undefined {
  return getEditingServerName(editorState) ?? undefined;
}

export function createMcpAutoValidateScheduler(
  validate: (workspaceId: string, name: string, source: EditableMcpSource) => void | Promise<void>,
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
    schedule(workspaceId: string, name: string, source: EditableMcpSource) {
      if (timer !== null) clearTimeoutFn(timer);
      timer = setTimeoutFn(() => {
        timer = null;
        void validate(workspaceId, name, source);
      }, delayMs);
    },
    cancel() {
      if (timer === null) return;
      clearTimeoutFn(timer);
      timer = null;
    },
  };
}
