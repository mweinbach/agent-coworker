/**
 * Structured prompt envelope for Cowork's embedded document/text/slide canvas.
 *
 * Mirrors the spreadsheet canvas envelope (`lib/univerSpreadsheet.ts#buildUniverSpreadsheetPrompt`)
 * so every canvas surface sends the agent the same kind of XML context, and the
 * chat transcript can render all of them through one parser/bubble
 * (`ui/chat/feedMessageParsing.ts#parseCanvasRequest`).
 */

export function escapeXml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requestLooksLikeFeedback(request: string): boolean {
  return /\b(what do you think|thoughts?|feedback|opinion|comment|review|analy[sz]e|assessment)\b/i.test(
    request,
  );
}

export function buildCanvasAssistantInstructions(opts: {
  request: string;
  contextLabel: string;
  editInstruction: string;
}): string {
  const feedbackMode = requestLooksLikeFeedback(opts.request)
    ? "answer_without_editing"
    : "edit_when_requested";
  const instruction =
    feedbackMode === "answer_without_editing"
      ? "The user is asking for feedback or analysis; answer directly unless they explicitly ask for file changes."
      : opts.editInstruction;

  return `  <assistant_instructions>
    <instruction>Treat this as structured context from Cowork's ${escapeXml(
      opts.contextLabel,
    )}.</instruction>
    <instruction mode="${feedbackMode}">${instruction}</instruction>
  </assistant_instructions>`;
}

export function buildCanvasDocumentPrompt(opts: {
  path: string;
  fileName: string;
  kind: string;
  selection: string | null;
  request: string;
}): string {
  const selection = opts.selection?.trim();
  const selectionXml = selection ? `\n  <selection>${escapeXml(selection)}</selection>` : "";
  const assistantInstructions = buildCanvasAssistantInstructions({
    request: opts.request,
    contextLabel: "embedded document canvas",
    editInstruction:
      "If the user asks for document changes, edit the local file and summarize the exact changes.",
  });

  return `<canvas_request version="1" source="document">
${assistantInstructions}
  <file name="${escapeXml(opts.fileName)}" path="${escapeXml(opts.path)}" kind="${escapeXml(
    opts.kind,
  )}" />${selectionXml}
  <user_request>${escapeXml(opts.request)}</user_request>
</canvas_request>`;
}
